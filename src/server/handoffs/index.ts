import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getD1, getDb } from "@/server/db/client";
import { handoffs } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { Actor } from "@/server/core/actor";
import { resolveDeviceRefs } from "@/server/devices";
import { attachmentIdsOf, attachmentManifests, bindStatements, parseAttachmentIds, resolveBindable } from "@/server/attachments";
import { prepareProjectLink, resolveProjectFilter, type ProjectLink } from "@/server/projects";
import { isUniqueViolation } from "@/server/core/sql-errors";
import { isSelfRef, selfUnavailable } from "@/server/core/self-device";
import { ANY_DEVICE_ID, RESERVED_DEVICE_NAME_KEYS, type Device } from "@/shared/contracts/devices";
import { HANDOFF_LIMITS, HANDOFF_LIST, type Handoff, type HandoffListItem, type HandoffListPage, type HandoffListScope, type HandoffProjectCounts, type HandoffThread } from "@/shared/contracts/handoffs";
import { deviceNameKey, isReservedDeviceName } from "@/shared/formatting/device-identity";
import { projectNameKey } from "@/shared/formatting/project-identity";
import { deleteOwnedHandoff } from "./storage";
import { notifyHandoffProgress, notifyHandoffReady } from "./notification-events";
import { parseReplyTo, parseResult, replyTitle } from "./receipt-validation";
import { parseGitContext, type GitContext } from "./git-context-validation";
import { listItem, PREVIEW_CHARACTERS } from "./summaries";
export { summarizeHandoff } from "./summaries";
export { getNotificationSettings, saveNotificationSubscription, updateNotificationSubscription, deleteNotificationSubscription, getNotificationHandoff, getNotificationProgress, getNotificationScope, sendNotificationTest } from "./notification-subscriptions";
export { expiryRemindersWanted, notifyConnectionExpiring, type ExpiringConnection } from "./notification-events";

export { adoptDeviceStatements, detachDeviceStatements, countDeviceReferences } from "./device-references";
export { getStorageSummary, listStorageHandoffs, getStorageHandoff, deleteStorageHandoffs } from "./storage";
export { purgeExpiredHandoffs, purgeExpiredQuietly, sweepExpiredHandoffs, sweepingExpiredFor } from "./retention";

// Wire fields are shared; owner and retry identity remain part of server storage only.
type HandoffRecord = Handoff & { ownerId: string; requestKey: string | null };
type HandoffRow = typeof handoffs.$inferSelect;
/**
 * The sender's platform id is stored for attribution only; members see the sender's display name. Image totals are
 * storage bookkeeping: the wire shape carries the attachment list itself.
 */
function record({ createdByUserId, attachmentCount, attachmentBytes, gitBranch, gitBaseCommit, ...row }: HandoffRow, attachments: Handoff["attachments"] = []): HandoffRecord {
  void createdByUserId; void attachmentCount; void attachmentBytes;
  return { ...row, branch: gitBranch, baseCommit: gitBaseCommit, attachments };
}
/** Attach each row's ordered image metadata; rows without images skip the lookup entirely. */
async function withManifests(owner: string, rows: HandoffRow[]): Promise<HandoffRecord[]> {
  const manifests = await attachmentManifests(owner, rows.filter(row => row.attachmentCount > 0).map(row => row.id));
  return rows.map(row => record(row, manifests.get(row.id)));
}

type Input = Record<string, unknown>;
function field(input: Input, key: string, max: number, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AgentRelayError(`${key} must be 1–${max} characters.`);
  return value;
}
// Pseudo-target stored as a plain snapshot name; `any` is never a registry row.
const ANY_TARGET = "任意设备";
type Stop = { name: string; id: string | null };
/** The snapshot name and registry id stored for a device reference. Unregistered references keep their text and a null id. */
function stopFor(ref: string, found: Device | undefined): Stop {
  if (found) return { name: found.name, id: found.id };
  if (ref.trim().toLowerCase() === ANY_DEVICE_ID) return { name: ANY_TARGET, id: null };
  return { name: ref, id: null };
}
// Ids are compared when both sides have one, so a retry after a rename still matches; otherwise names decide.
function sameStop(name: string, id: string | null, stop: Stop) {
  return id && stop.id ? id === stop.id : deviceNameKey(name) === deviceNameKey(stop.name);
}
async function targetFilter(owner: string, value: unknown) {
  if (!value) return undefined;
  if (isSelfRef(value)) throw selfUnavailable();
  const ref = String(value), device = (await resolveDeviceRefs(owner, [ref])).get(ref);
  // Legacy rows have no id yet, so their snapshot may equal the device's id or name (SQLite folds only ASCII case).
  if (device) return or(eq(handoffs.targetDeviceId, device.id),
    and(isNull(handoffs.targetDeviceId), inArray(sql`lower(trim(${handoffs.targetDevice}))`, [...new Set([device.id, deviceNameKey(device.name)])])));
  if (isReservedDeviceName(ref)) return inArray(sql`lower(trim(${handoffs.targetDevice}))`, [...RESERVED_DEVICE_NAME_KEYS]);
  return eq(handoffs.targetDevice, ref);
}
/** A project id or a name compared by key; legacy names are filed under projects first, so they match too. */
async function projectFilter(owner: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const id = await resolveProjectFilter(owner, value);
  return id ? eq(handoffs.projectId, id) : sql`0`;
}
function active(owner: string) {
  return and(eq(handoffs.ownerId, owner), or(isNull(handoffs.expiresAt), gt(handoffs.expiresAt, Date.now())));
}
// Agents page through the same newest 500 handoffs the browser list holds, 50 rows at a time.
const LIST_WINDOW = 500, LIST_PAGE = 50;
async function listCondition(owner: string, filters: Input) {
  const status = filters.status;
  if (status && !["ready", "claimed", "done"].includes(String(status))) throw new AgentRelayError("Invalid handoff status.");
  const [target, project] = await Promise.all([targetFilter(owner, filters.targetDevice), projectFilter(owner, filters.project)]);
  return and(active(owner), status ? eq(handoffs.status, String(status)) : undefined, target, project);
}
export async function listHandoffs(owner: string, filters: Input = {}): Promise<HandoffRecord[]> {
  const rows = await getDb().select().from(handoffs).where(await listCondition(owner, filters)).orderBy(desc(handoffs.createdAt)).limit(LIST_WINDOW);
  return withManifests(owner, rows);
}
/**
 * One page of agent-facing list rows. SQLite cuts the previews and counts the sizes, so the Worker never holds the full
 * prompts; it reads at most one row past the page to know whether another page follows.
 */
export async function listHandoffSummaries(owner: string, filters: Input = {}, offset = 0): Promise<{ handoffs: HandoffListItem[]; nextOffset: number | null }> {
  const condition = await listCondition(owner, filters), size = Math.min(LIST_PAGE, LIST_WINDOW - offset);
  if (size <= 0) return { handoffs: [], nextOffset: null };
  const rows = await getDb().select(SUMMARY_COLUMNS).from(handoffs).where(condition).orderBy(desc(handoffs.createdAt), desc(handoffs.id)).limit(size + 1).offset(offset);
  const more = rows.length > size;
  return { handoffs: rows.slice(0, size).map(listItem), nextOffset: more && offset + size < LIST_WINDOW ? offset + size : null };
}
/** The columns of a list row, shared by the agent list and the browser's inbox list. */
const SUMMARY_COLUMNS = { id: handoffs.id, title: handoffs.title, status: handoffs.status, version: handoffs.version,
  sourceDevice: handoffs.sourceDevice, targetDevice: handoffs.targetDevice, createdAt: handoffs.createdAt, updatedAt: handoffs.updatedAt,
  expiresAt: handoffs.expiresAt, project: handoffs.project, projectId: handoffs.projectId, sourceDeviceId: handoffs.sourceDeviceId,
  targetDeviceId: handoffs.targetDeviceId, claimedBy: handoffs.claimedBy, claimedByDeviceId: handoffs.claimedByDeviceId,
  createdByName: handoffs.createdByName, replyToId: handoffs.replyToId, threadId: handoffs.threadId, branch: handoffs.gitBranch,
  baseCommit: handoffs.gitBaseCommit, attachmentCount: handoffs.attachmentCount,
  // SQLite counts and cuts Unicode characters, so a preview never splits a surrogate pair.
  preview: sql<string>`substr(${handoffs.content}, 1, ${PREVIEW_CHARACTERS})`, characters: sql<number>`length(${handoffs.content})`,
  resultPreview: sql<string | null>`substr(${handoffs.result}, 1, ${PREVIEW_CHARACTERS})`, resultCharacters: sql<number | null>`length(${handoffs.result})` };

const OPEN_STATUSES = ["ready", "claimed"];
function scopeOf(value: unknown): HandoffListScope {
  if (value === undefined || value === "" || value === "open") return "open";
  if (value === "done") return "done";
  throw new AgentRelayError("scope must be open or done.");
}
const scopeCondition = (scope: HandoffListScope) => scope === "done" ? eq(handoffs.status, "done") : inArray(handoffs.status, OPEN_STATUSES);
/** The position after which a page continues: the last row's creation time and id, opaque to the browser. */
function encodeCursor(row: { createdAt: number; id: string }) {
  return btoa(JSON.stringify([row.createdAt, row.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string): { createdAt: number; id: string } {
  try {
    const [createdAt, id] = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    if (Number.isSafeInteger(createdAt) && typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return { createdAt, id };
  } catch { /* Reported below. */ }
  throw new AgentRelayError("Invalid list cursor.");
}
function listLimit(value: unknown) {
  if (value === undefined || value === "") return HANDOFF_LIST.pageSize;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > HANDOFF_LIST.maxLimit) throw new AgentRelayError(`limit must be 1–${HANDOFF_LIST.maxLimit}.`);
  return limit;
}
function searchText(value: unknown) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > HANDOFF_LIST.searchCharacters) throw new AgentRelayError(`Search text must be at most ${HANDOFF_LIST.searchCharacters} characters.`);
  return value.trim() ? value : null;
}
/** The project condition of the inbox list: an id or name as for agents, or `none` for handoffs without a project. */
async function inboxProjectFilter(owner: string, value: unknown) {
  if (value === "none") return and(isNull(handoffs.projectId), eq(handoffs.project, ""));
  return projectFilter(owner, value);
}

/**
 * One page of the browser's inbox list: summaries only, filtered and searched in SQL, newest first, continued by a
 * cursor rather than an offset so a new handoff never shifts a later page. The open count is the inbox badge.
 */
export async function listInboxPage(owner: string, input: Input = {}): Promise<HandoffListPage> {
  const scope = scopeOf(input.scope), limit = listLimit(input.limit), q = searchText(input.q);
  const status = input.status === undefined || input.status === "" ? undefined : String(input.status);
  if (status && (scope !== "open" || !OPEN_STATUSES.includes(status))) throw new AgentRelayError("status must be ready or claimed, in the open scope.");
  const cursor = typeof input.cursor === "string" && input.cursor ? decodeCursor(input.cursor) : null;
  const [target, project] = await Promise.all([targetFilter(owner, input.target), inboxProjectFilter(owner, input.project)]);
  const shared = and(active(owner), target, project,
    // The same fields the browser searched before; SQLite's lower() folds ASCII letters only.
    q ? sql`instr(lower(${handoffs.title} || char(10) || ${handoffs.project} || char(10) || ${handoffs.content}), lower(${q})) > 0` : undefined,
    cursor ? or(lt(handoffs.createdAt, cursor.createdAt), and(eq(handoffs.createdAt, cursor.createdAt), lt(handoffs.id, cursor.id))) : undefined);
  // One query per status: SQLite pages `status = ?` through the status index, but answers `status IN (...)` by walking
  // the creation index past every other row. Each reads at most one row past the page; the newest of both form it.
  const statuses = status ? [status] : scope === "done" ? ["done"] : OPEN_STATUSES;
  const [open, ...pages] = await Promise.all([
    getDb().select({ n: count() }).from(handoffs).where(and(active(owner), scopeCondition("open"))),
    ...statuses.map(value => getDb().select(SUMMARY_COLUMNS).from(handoffs).where(and(shared, eq(handoffs.status, value)))
      .orderBy(desc(handoffs.createdAt), desc(handoffs.id)).limit(limit + 1)),
  ]);
  // Newest first by (createdAt, id), the order SQLite used within each status; ids are ASCII, so < compares as SQLite does.
  const rows = pages.flat().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit + 1);
  const page = rows.slice(0, limit);
  return { handoffs: page.map(listItem), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null, counts: { open: open[0]?.n ?? 0 } };
}

/** Handoffs per project id in a scope (or both), read when a project menu or Manage projects opens, never per poll. */
export async function countHandoffsByProject(owner: string, input: Input = {}): Promise<HandoffProjectCounts> {
  const scope = input.scope === "all" ? null : scopeOf(input.scope);
  const rows = await getDb().select({ id: handoffs.projectId, n: count() }).from(handoffs)
    // A legacy name that is not filed under a project yet belongs to no count, as before.
    .where(and(active(owner), scope ? scopeCondition(scope) : undefined, or(sql`${handoffs.projectId} IS NOT NULL`, eq(handoffs.project, ""))))
    .groupBy(handoffs.projectId);
  return { projects: Object.fromEntries(rows.map(row => [row.id ?? "none", row.n])) };
}
async function activeRow(owner: string, id: string, missing = "This handoff no longer exists or has expired.") {
  const [row] = await getDb().select().from(handoffs).where(and(active(owner), eq(handoffs.id, id))).limit(1);
  if (!row) throw new AgentRelayError(missing, 404);
  return row;
}
/** The active handoffs of a row's thread, oldest first; null when the row neither replies to nor has replies. */
async function threadOf(owner: string, row: HandoffRow): Promise<HandoffThread | null> {
  const rootId = row.threadId ?? row.id;
  const items = await getDb().select({ id: handoffs.id, title: handoffs.title, status: handoffs.status, sourceDevice: handoffs.sourceDevice,
    targetDevice: handoffs.targetDevice, replyToId: handoffs.replyToId, createdAt: handoffs.createdAt, hasResult: sql<number>`${handoffs.result} IS NOT NULL`,
    sourceDeviceId: handoffs.sourceDeviceId, targetDeviceId: handoffs.targetDeviceId })
    .from(handoffs).where(and(active(owner), or(eq(handoffs.id, rootId), eq(handoffs.threadId, rootId))))
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id)).limit(HANDOFF_LIMITS.threadSize);
  if (items.length <= 1 && !row.threadId) return null;
  return { rootId, items: items.map(item => ({ ...item, hasResult: !!item.hasResult })) };
}
/** One handoff with its thread; the lifecycle operations read the bare row instead. */
export async function getHandoff(owner: string, id: string): Promise<HandoffRecord> {
  const row = await activeRow(owner, id);
  const [[found], thread] = await Promise.all([withManifests(owner, [row]), threadOf(owner, row)]);
  return { ...found, thread };
}
/** Prompt text may be empty only when images carry the message; non-empty text is stored exactly as sent. */
function contentFor(input: Input, hasImages: boolean): string {
  const value = input.content ?? (hasImages ? "" : undefined);
  if (typeof value !== "string" || value.length > 200000 || (!hasImages && !value.trim()))
    throw new AgentRelayError(hasImages ? "content must be at most 200000 characters." : "content must be 1–200000 characters.");
  return value;
}
type Draft = { title: string; project: ProjectLink | null; content: string; source: Stop; target: Stop; attachmentIds: string[]; replyToId: string | null; git: GitContext };
const blank = (value: unknown) => value == null || (typeof value === "string" && !value.trim());
/** The handoff a reply points at: active and in the same workspace, or the same 404 whether it is foreign, missing or expired. */
async function replyParent(owner: string, value: unknown): Promise<HandoffRow | null> {
  const id = parseReplyTo(value);
  return id ? activeRow(owner, id, "The handoff you are replying to no longer exists or has expired.") : null;
}
/**
 * The thread cap is a display bound, so a check outside the creation batch is enough; two racing replies may pass it together.
 * Expired handoffs have left the thread, so they do not use up its room.
 */
async function assertThreadRoom(owner: string, rootId: string) {
  const [{ n }] = await getDb().select({ n: count() }).from(handoffs)
    .where(and(active(owner), or(eq(handoffs.id, rootId), eq(handoffs.threadId, rootId))));
  if (n >= HANDOFF_LIMITS.threadSize) throw new AgentRelayError(`A thread holds at most ${HANDOFF_LIMITS.threadSize} handoffs. Start a new handoff instead.`, 409);
}
// Like devices: ids decide when both sides have one, otherwise the name key, so a retry may differ in case or separators.
function sameProject(existing: HandoffRow, link: ProjectLink | null) {
  if (!link) return !existing.project;
  return existing.projectId && link.existingId ? existing.projectId === link.existingId : projectNameKey(existing.project) === link.key;
}
/** A retry may only repeat the original request: same text, route, code state and ordered images. */
async function replay(existing: HandoffRow, draft: Draft): Promise<HandoffRecord> {
  const ids = existing.attachmentCount ? await attachmentIdsOf(existing.ownerId, existing.id) : [];
  if (existing.content !== draft.content || existing.title !== draft.title || !sameProject(existing, draft.project) || existing.replyToId !== draft.replyToId
    || existing.gitBranch !== draft.git.branch || existing.gitBaseCommit !== draft.git.baseCommit
    || !sameStop(existing.sourceDevice, existing.sourceDeviceId, draft.source) || !sameStop(existing.targetDevice, existing.targetDeviceId, draft.target)
    || ids.length !== draft.attachmentIds.length || ids.some((id, index) => id !== draft.attachmentIds[index]))
    throw new AgentRelayError("This request key was already used for a different prompt.", 409);
  return (await withManifests(existing.ownerId, [existing]))[0];
}
async function findByRequestKey(owner: string, requestKey: string) {
  const [existing] = await getDb().select().from(handoffs).where(and(eq(handoffs.ownerId, owner), eq(handoffs.requestKey, requestKey)));
  return existing;
}
export async function createHandoff(actor: Actor, input: Input): Promise<HandoffRecord> {
  const { owner } = actor;
  const attachmentIds = parseAttachmentIds(input.attachmentIds), content = contentFor(input, attachmentIds.length > 0);
  // Git context is never inherited from a parent: work sent back usually sits on a newer commit than the one it answers.
  const git = parseGitContext(input);
  // A reply defaults its title, its target (the parent's sender) and its project from the parent; explicit values win.
  const parent = await replyParent(owner, input.replyTo);
  const title = parent && blank(input.title) ? replyTitle(parent.title) : field(input, "title", HANDOFF_LIMITS.titleCharacters);
  const sourceRef = field(input, "sourceDevice", 80, "Agent");
  const targetRef = parent && blank(input.targetDevice) ? parent.sourceDeviceId ?? parent.sourceDevice : field(input, "targetDevice", 80, ANY_TARGET);
  const projectInput = parent && input.project === undefined ? parent.project || undefined : input.project;
  // `self` is resolved from the calling connection by the MCP adapter; a literal one here has no connection behind it.
  if (isSelfRef(sourceRef) || isSelfRef(targetRef)) throw selfUnavailable();
  const requestKey = input.requestKey == null ? null : field(input, "requestKey", 120);
  const days = input.expiresInDays ?? 30;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) throw new AgentRelayError("Expiry must be between 1 and 365 days.");
  // Device ids and registered names resolve in one query; the registry name is kept as the snapshot.
  const found = await resolveDeviceRefs(owner, [sourceRef, targetRef]);
  const source = stopFor(sourceRef, found.get(sourceRef)), target = stopFor(targetRef, found.get(targetRef));
  const now = Date.now(), link = await prepareProjectLink(owner, projectInput, now);
  const draft: Draft = { title, project: link, content, source, target, attachmentIds, replyToId: parent?.id ?? null, git };
  // A retry of a request that already succeeded must not touch its (now attached) images again.
  if (requestKey) { const earlier = await findByRequestKey(owner, requestKey); if (earlier) return replay(earlier, draft); }
  const threadId = parent ? parent.threadId ?? parent.id : null;
  if (threadId) await assertThreadRoom(owner, threadId);
  const images = await resolveBindable(owner, attachmentIds, now);
  const row = { id: crypto.randomUUID(), ownerId: owner, title, project: "", projectId: null, sourceDevice: source.name, sourceDeviceId: source.id,
    targetDevice: target.name, targetDeviceId: target.id, content, status: "ready",
    claimedBy: null, claimedByDeviceId: null, createdAt: now, updatedAt: now, expiresAt: now + days * 86400000, version: 1, requestKey,
    createdByUserId: actor.userId, createdByName: actor.name, attachmentCount: images.count, attachmentBytes: images.bytes,
    result: null, replyToId: draft.replyToId, threadId, gitBranch: git.branch, gitBaseCommit: git.baseCommit };
  if (!attachmentIds.length && !link) {
    // The owner-scoped unique key makes simultaneous network retries idempotent.
    const [created] = await getDb().insert(handoffs).values(row).onConflictDoNothing().returning();
    if (created) { void notifyHandoffReady(owner, created, "created"); return record(created); }
    const existing = await findByRequestKey(owner, requestKey!);
    if (!existing) throw new AgentRelayError("Saving failed. Try again.", 500);
    return replay(existing, draft);
  }
  // The handoff, its project and its images commit together or not at all: the guard row inside the batch aborts the
  // whole transaction if any upload was attached elsewhere or reclaimed after the check above.
  const d1 = getD1(), insert = getDb().insert(handoffs).values(link ? { ...row, project: link.projectName, projectId: link.projectId } : row).toSQL();
  try { await d1.batch([...(link ? [link.statement] : []), d1.prepare(insert.sql).bind(...insert.params), ...bindStatements(owner, row.id, attachmentIds, now)]); }
  catch (error) {
    if (requestKey && isUniqueViolation(error)) { const winner = await findByRequestKey(owner, requestKey); if (winner) return replay(winner, draft); }
    if (!attachmentIds.length) throw error;
    if (!/CHECK constraint failed|UNIQUE constraint failed/i.test([(error as Error)?.message, (error as { cause?: Error })?.cause?.message].join(" "))) throw error;
    await resolveBindable(owner, attachmentIds, Date.now());
    throw new AgentRelayError("The attached images changed while sending. Try again.", 409);
  }
  const [created] = await getDb().select().from(handoffs).where(eq(handoffs.id, row.id));
  if (!created) throw new AgentRelayError("Saving failed. Try again.", 500);
  void notifyHandoffReady(owner, created, "created");
  return (await withManifests(owner, [created]))[0];
}
/** `undo` steps one claim or completion back; only the web route passes it, so agents keep the forward-only rules. */
export async function changeHandoff(owner: string, id: string, input: Input, { undo = false }: { undo?: boolean } = {}): Promise<HandoffRecord> {
  const row = await activeRow(owner, id), status = field(input, "status", 20);
  const result = parseResult(input.result, status, undo);
  const transitions: Record<string, string[]> = undo ? { claimed: ["ready"], done: ["claimed"] } : { ready: ["claimed"], claimed: ["done", "ready"], done: ["ready"] };
  if (!transitions[row.status]?.includes(status)) throw new AgentRelayError("The status changed elsewhere. Refresh and try again.", 409);
  if (undo && input.version === undefined) throw new AgentRelayError("Undo needs the handoff version.");
  if (input.version !== undefined && input.version !== row.version) throw new AgentRelayError("Another device just updated this handoff. Refresh to continue.", 409);
  // Undoing a completion keeps the original claimant rather than reassigning the claim to the undoing device.
  let claimedBy = status === "ready" ? null : row.claimedBy, claimedByDeviceId = status === "ready" ? null : row.claimedByDeviceId;
  if (status === "claimed" && !undo) {
    const ref = field(input, "device", 80, "Agent");
    if (isSelfRef(ref)) throw selfUnavailable();
    const claimant = stopFor(ref, (await resolveDeviceRefs(owner, [ref])).get(ref));
    claimedBy = claimant.name; claimedByDeviceId = claimant.id;
  }
  // A ready handoff never shows the outcome of an earlier attempt. An undone completion keeps its receipt, and completing
  // again without one keeps it too, so a one-click "done" in the browser does not erase what an agent reported.
  const receipt = status === "ready" ? { result: null } : result !== undefined ? { result } : {};
  // Compare-and-swap prevents two devices from successfully claiming the same prompt.
  const [updated] = await getDb().update(handoffs).set({ status, claimedBy, claimedByDeviceId, ...receipt, updatedAt: Date.now(), version: row.version + 1 })
    .where(and(active(owner), eq(handoffs.id, id), eq(handoffs.version, row.version))).returning();
  if (!updated) throw new AgentRelayError("Another device just updated this handoff. Refresh to continue.", 409);
  // Only a compare-and-swap that won announces anything: a stale or conflicting request has already thrown above.
  // An undone claim never left Ready in anyone's view for long, so it is not announced as requeued.
  if (status === "ready" && !undo) void notifyHandoffReady(owner, updated, "requeued");
  // The sender hears about forward steps only; an undo puts back a state it was already told about.
  if ((status === "claimed" || status === "done") && !undo) void notifyHandoffProgress(owner, updated, status);
  return (await withManifests(owner, [updated]))[0];
}
export async function deleteHandoff(owner: string, id: string, version?: unknown) { return deleteOwnedHandoff(owner, id, version); }
