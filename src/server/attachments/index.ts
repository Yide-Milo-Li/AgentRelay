import { and, eq } from "drizzle-orm";
import { getBucket, getD1, getDb } from "@/server/db/client";
import { attachments } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { isUniqueViolation } from "@/server/core/sql-errors";
import type { Actor } from "@/server/core/actor";
import { UNATTACHED_RETENTION_MS, type AttachmentInfo, type CleanupResult, type CleanupSummary, type ImageMimeType } from "@/shared/contracts/attachments";
import { inspectImage, sha256Hex } from "@/shared/images/inspect-image.mjs";
import { checkDeclaredType, cleanFilename, parseUploadKey, uploadFailure } from "./validation";

export { parseAttachmentIds } from "./validation";

type Row = typeof attachments.$inferSelect;
const SWEEP_LIMIT = 25;
// Object keys come from the id alone, so a retried upload always rewrites the same object.
const objectKey = (id: string) => `a/${id}`;
const retentionCutoff = (now: number) => now - UNATTACHED_RETENTION_MS;
/** Public shape: the owner, retry key and object key never leave the server. */
function toInfo(row: Pick<Row, "id" | "filename" | "mimeType" | "byteSize" | "width" | "height" | "sha256" | "position" | "createdAt">): AttachmentInfo {
  return { id: row.id, filename: row.filename, mimeType: row.mimeType as ImageMimeType, bytes: row.byteSize, width: row.width, height: row.height,
    sha256: row.sha256, position: row.position, createdAt: row.createdAt };
}
const failed = () => new AgentRelayError("Saving failed. Try again.", 500);
async function findByKey(owner: string, uploadKey: string): Promise<Row | undefined> {
  const [row] = await getDb().select().from(attachments).where(and(eq(attachments.ownerId, owner), eq(attachments.uploadKey, uploadKey))).limit(1);
  return row;
}

/**
 * Validate and store one image. The row exists before the object does, so a crash between the two leaves a pending
 * row (reclaimed by the sweep, which also deletes the key) rather than an object nothing refers to.
 */
export async function uploadAttachment(actor: Actor, input: { bytes: Uint8Array; filename: string | null; uploadKey: string | null; declaredType: string | null }) {
  const owner = actor.owner, uploadKey = parseUploadKey(input.uploadKey);
  const inspected = inspectImage(input.bytes);
  if (!inspected.ok) throw uploadFailure(inspected.reason, inspected.detail);
  checkDeclaredType(input.declaredType, inspected.mimeType);
  const sha256 = await sha256Hex(input.bytes);
  await sweepQuietly(owner);
  const now = Date.now();
  let row = await findByKey(owner, uploadKey), created = false;
  if (!row) {
    const id = crypto.randomUUID();
    const fresh: Row = { id, ownerId: owner, handoffId: null, position: null, filename: cleanFilename(input.filename, inspected.mimeType),
      mimeType: inspected.mimeType, byteSize: input.bytes.length, width: inspected.width, height: inspected.height, sha256,
      objectKey: objectKey(id), uploadKey, state: "pending", createdAt: now };
    try { await getDb().insert(attachments).values(fresh); row = fresh; created = true; }
    catch (error) {
      if (!isUniqueViolation(error)) throw error;
      row = await findByKey(owner, uploadKey);
      if (!row) throw failed();
    }
  }
  if (row.sha256 !== sha256 || row.byteSize !== input.bytes.length) throw new AgentRelayError("This upload key was already used for a different image.", 409);
  if (row.handoffId) throw new AgentRelayError("This upload is already attached to a handoff. Upload the image again with a new upload key.", 409);
  if (row.createdAt < retentionCutoff(now)) throw new AgentRelayError("This upload expired. Upload the image again with a new upload key.", 409);
  if (row.state !== "ready") {
    await getBucket().put(row.objectKey, input.bytes, { sha256, httpMetadata: { contentType: row.mimeType } });
    await getDb().update(attachments).set({ state: "ready" }).where(and(eq(attachments.id, row.id), eq(attachments.ownerId, owner)));
  }
  return { attachment: toInfo(row), created };
}

/** Everything a creation batch needs to know about the requested uploads, or the specific reason it cannot proceed. */
export async function resolveBindable(owner: string, ids: string[], now = Date.now()): Promise<{ count: number; bytes: number }> {
  if (!ids.length) return { count: 0, bytes: 0 };
  const rows = await getD1().prepare(`SELECT id, handoff_id AS handoffId, state, created_at AS createdAt, byte_size AS bytes FROM attachments WHERE owner_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(owner, ...ids).all<{ id: string; handoffId: string | null; state: string; createdAt: number; bytes: number }>();
  const byId = new Map(rows.results.map(row => [row.id, row]));
  let bytes = 0;
  for (const id of ids) {
    const row = byId.get(id);
    // A foreign upload and a missing one answer identically, so ids cannot be probed across workspaces.
    if (!row) throw new AgentRelayError("An attached image doesn't exist. Upload it again.", 404);
    if (row.handoffId) throw new AgentRelayError("An attached image already belongs to another handoff. Upload it again.", 409);
    if (row.state !== "ready") throw new AgentRelayError("An attached image has not finished uploading.", 409);
    if (row.createdAt < retentionCutoff(now)) throw new AgentRelayError("An attached image expired before it was sent. Upload it again.", 409);
    bytes += row.bytes;
  }
  return { count: ids.length, bytes };
}

/**
 * Statements that attach the uploads to a handoff, in order. Run them in the same `D1.batch` as the handoff insert:
 * the guard row's CHECK aborts the whole transaction when any upload was claimed, reclaimed or removed in between.
 */
export function bindStatements(owner: string, handoffId: string, ids: string[], now: number): D1PreparedStatement[] {
  if (!ids.length) return [];
  const d1 = getD1(), cutoff = retentionCutoff(now);
  return [
    ...ids.map((id, position) => d1.prepare("UPDATE attachments SET handoff_id = ?, position = ? WHERE id = ? AND owner_id = ? AND handoff_id IS NULL AND state = 'ready' AND created_at >= ?")
      .bind(handoffId, position, id, owner, cutoff)),
    d1.prepare("INSERT INTO attachment_bind_guard (handoff_id, expected, actual) VALUES (?, ?, (SELECT COUNT(*) FROM attachments WHERE owner_id = ? AND handoff_id = ?))")
      .bind(handoffId, ids.length, owner, handoffId),
    d1.prepare("DELETE FROM attachment_bind_guard WHERE handoff_id = ?").bind(handoffId),
  ];
}

/**
 * Statements that queue a handoff's objects for deletion and drop its attachment rows. Both only match while the
 * handoff still has the observed version, so a stale deletion removes nothing. Run before the handoff delete.
 */
export function releaseStatements(owner: string, handoffId: string, version: number): D1PreparedStatement[] {
  const d1 = getD1(), now = Date.now();
  const match = "owner_id = ? AND handoff_id = ? AND EXISTS (SELECT 1 FROM handoffs WHERE id = ? AND owner_id = ? AND version = ?)";
  const args = [owner, handoffId, handoffId, owner, version];
  return [
    d1.prepare(`INSERT INTO object_cleanup (id, owner_id, object_key, byte_size, attempts, created_at) SELECT lower(hex(randomblob(16))), owner_id, object_key, byte_size, 0, ? FROM attachments WHERE ${match}`).bind(now, ...args),
    d1.prepare(`DELETE FROM attachments WHERE ${match}`).bind(...args),
  ];
}

/**
 * The set-based form of `releaseStatements`, for purging expired handoffs. Both only match images of a listed handoff
 * that is still expired at `now`, so they never touch a live handoff. The ids travel as one JSON parameter, which keeps
 * any chunk within D1's bound-parameter limit. Run before the handoff delete, in the same batch.
 */
export function releaseExpiredStatements(owner: string, handoffIds: string[], now: number): D1PreparedStatement[] {
  if (!handoffIds.length) return [];
  const d1 = getD1();
  const match = `owner_id = ? AND handoff_id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM handoffs WHERE handoffs.id = attachments.handoff_id
    AND handoffs.owner_id = attachments.owner_id AND handoffs.expires_at IS NOT NULL AND handoffs.expires_at <= ?)`;
  const args = [owner, JSON.stringify(handoffIds), now];
  return [
    d1.prepare(`INSERT INTO object_cleanup (id, owner_id, object_key, byte_size, attempts, created_at) SELECT lower(hex(randomblob(16))), owner_id, object_key, byte_size, 0, ? FROM attachments WHERE ${match}`).bind(now, ...args),
    d1.prepare(`DELETE FROM attachments WHERE ${match}`).bind(...args),
  ];
}

const MANIFEST_CHUNK = 90; // D1 allows 100 bound parameters per statement.
/** Ordered image metadata for the given handoffs; handoffs without images are absent from the map. */
export async function attachmentManifests(owner: string, handoffIds: string[]): Promise<Map<string, AttachmentInfo[]>> {
  const manifests = new Map<string, AttachmentInfo[]>();
  if (!handoffIds.length) return manifests;
  const d1 = getD1(), chunks: string[][] = [];
  for (let i = 0; i < handoffIds.length; i += MANIFEST_CHUNK) chunks.push(handoffIds.slice(i, i + MANIFEST_CHUNK));
  const results = await d1.batch<Row & { handoffId: string }>(chunks.map(chunk => d1.prepare(
    `SELECT id, handoff_id AS handoffId, position, filename, mime_type AS mimeType, byte_size AS byteSize, width, height, sha256, created_at AS createdAt
     FROM attachments WHERE owner_id = ? AND state = 'ready' AND handoff_id IN (${chunk.map(() => "?").join(",")}) ORDER BY handoff_id, position`).bind(owner, ...chunk)));
  for (const result of results) for (const row of result.results) {
    const list = manifests.get(row.handoffId) ?? [];
    list.push(toInfo(row)); manifests.set(row.handoffId, list);
  }
  return manifests;
}

/** The ids attached to a handoff, in order; used to compare a retried creation with the original. */
export async function attachmentIdsOf(owner: string, handoffId: string): Promise<string[]> {
  const rows = await getD1().prepare("SELECT id FROM attachments WHERE owner_id = ? AND handoff_id = ? ORDER BY position").bind(owner, handoffId).all<{ id: string }>();
  return rows.results.map(row => row.id);
}

/** One attached image and its bytes. Normal reads respect handoff expiry; Storage management may include expired handoffs. */
export async function readAttachment(owner: string, handoffId: string, attachmentId: string, options: { includeExpired?: boolean } = {}) {
  const now = Date.now();
  const row = await getD1().prepare(
    `SELECT a.id, a.position, a.filename, a.mime_type AS mimeType, a.byte_size AS byteSize, a.width, a.height, a.sha256, a.created_at AS createdAt, a.object_key AS objectKey
     FROM attachments a JOIN handoffs h ON h.id = a.handoff_id AND h.owner_id = a.owner_id
     WHERE a.id = ? AND a.handoff_id = ? AND a.owner_id = ? AND a.state = 'ready' ${options.includeExpired ? "" : "AND (h.expires_at IS NULL OR h.expires_at > ?)"}`)
    .bind(attachmentId, handoffId, owner, ...(options.includeExpired ? [] : [now])).first<Row & { objectKey: string }>();
  if (!row) throw new AgentRelayError("This image doesn't exist or has expired.", 404);
  const object = await getBucket().get(row.objectKey);
  if (!object) throw new AgentRelayError("This image is no longer available.", 404);
  return { info: toInfo(row), object };
}

/** R2 deletes at most this many keys in one call. */
const R2_DELETE_MAX = 1000;
/**
 * Delete queued objects from R2 in one call. Deleting a missing key succeeds, so a failed call keeps every row of the
 * batch, with the attempt count, and the whole batch is retried; the failure stays visible in Storage meanwhile.
 */
export async function purgeObjectCleanup(owner: string, limit = SWEEP_LIMIT): Promise<number> {
  const d1 = getD1();
  const queued = (await d1.prepare("SELECT id, object_key AS objectKey FROM object_cleanup WHERE owner_id = ? ORDER BY created_at LIMIT ?")
    .bind(owner, Math.min(limit, R2_DELETE_MAX)).all<{ id: string; objectKey: string }>()).results;
  if (!queued.length) return 0;
  const ids = JSON.stringify(queued.map(item => item.id)), inBatch = "owner_id = ? AND id IN (SELECT value FROM json_each(?))";
  try { await getBucket().delete(queued.map(item => item.objectKey)); }
  catch {
    await d1.prepare(`UPDATE object_cleanup SET attempts = attempts + 1, last_error = ? WHERE ${inBatch}`).bind("R2 delete failed", owner, ids).run();
    return 0;
  }
  await d1.prepare(`DELETE FROM object_cleanup WHERE ${inBatch}`).bind(owner, ids).run();
  return queued.length;
}

/**
 * Reclaim stale uploads (and rows whose handoff no longer exists), then delete queued objects. Each reclaim re-checks
 * its condition inside the batch, so an upload that a handoff binds first is simply not matched.
 */
export async function sweepAttachments(owner: string, limit = SWEEP_LIMIT): Promise<CleanupResult> {
  const d1 = getD1(), now = Date.now(), cutoff = retentionCutoff(now);
  const stale = "owner_id = ? AND ((handoff_id IS NULL AND created_at < ?) OR (handoff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM handoffs WHERE handoffs.id = attachments.handoff_id AND handoffs.owner_id = attachments.owner_id)))";
  const candidates = (await d1.prepare(`SELECT id FROM attachments WHERE ${stale} LIMIT ?`).bind(owner, cutoff, limit).all<{ id: string }>()).results;
  let reclaimedUploads = 0;
  if (candidates.length) {
    const results = await d1.batch(candidates.flatMap(({ id }) => [
      d1.prepare(`INSERT INTO object_cleanup (id, owner_id, object_key, byte_size, attempts, created_at) SELECT lower(hex(randomblob(16))), owner_id, object_key, byte_size, 0, ? FROM attachments WHERE id = ? AND ${stale}`).bind(now, id, owner, cutoff),
      d1.prepare(`DELETE FROM attachments WHERE id = ? AND ${stale}`).bind(id, owner, cutoff),
    ]));
    reclaimedUploads = results.filter((_, index) => index % 2 === 1).reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  const deletedObjects = await purgeObjectCleanup(owner, limit);
  return { ...await cleanupSummary(owner), reclaimedUploads, deletedObjects };
}
/** Opportunistic cleanup during uploads and deletions: a failure leaves the queue for the next attempt and never fails the request. */
export async function sweepQuietly(owner: string) {
  try { await sweepAttachments(owner, 10); } catch (error) { console.error("AgentRelay attachment sweep failed", (error as Error)?.name); }
}

export async function cleanupSummary(owner: string): Promise<CleanupSummary> {
  const d1 = getD1();
  const [unattached, pending] = await d1.batch<{ count: number; bytes: number; failing?: number }>([
    d1.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM attachments WHERE owner_id = ? AND handoff_id IS NULL").bind(owner),
    d1.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes, COALESCE(SUM(attempts > 0), 0) AS failing FROM object_cleanup WHERE owner_id = ?").bind(owner),
  ]);
  const u = unattached.results[0], p = pending.results[0];
  return { unattached: { count: u.count, bytes: u.bytes }, pendingCleanup: { count: p.count, bytes: p.bytes, failing: p.failing ?? 0 } };
}
