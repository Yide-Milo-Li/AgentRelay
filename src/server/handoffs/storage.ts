import { getD1, storageLimitBytes } from "@/server/db/client";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { attachmentManifests, cleanupSummary, releaseStatements, sweepQuietly } from "@/server/attachments";
import { resolveProjectFilter } from "@/server/projects";
import { STORAGE_CATEGORIES, STORAGE_PAGE_SIZE, type StorageSummary, type StorageGroup, type StorageHandoff, type StoragePage, type StorageDeletionResult } from "@/shared/contracts/storage";
import type { Handoff } from "@/shared/contracts/handoffs";
import { STORAGE_CURSOR_VERSION, encodeStorageCursor, observedVersion, parseHandoffDeletions, parseStorageQuery, storageFilterKey } from "./storage-validation";

// Prompt text and the completion receipt count as text alike.
const PROMPT_BYTES = "length(CAST(content AS BLOB)) + length(CAST(coalesce(result, '') AS BLOB))";
// Text plus attached images. This is the expression `handoffs_owner_logical_v2` indexes, so sorting and summing stay index-only.
const BYTE_EXPRESSION = `${PROMPT_BYTES} + attachment_bytes`;
const METADATA = `id, title, project, source_device AS sourceDevice, target_device AS targetDevice,
  source_device_id AS sourceDeviceId, target_device_id AS targetDeviceId, claimed_by_device_id AS claimedByDeviceId,
  status, claimed_by AS claimedBy, created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt, version,
  created_by_name AS createdByName, attachment_count AS attachmentCount, attachment_bytes AS imageBytes`;
const SORTS = {
  largest: { expression: BYTE_EXPRESSION, direction: "DESC", field: "logicalBytes" },
  smallest: { expression: BYTE_EXPRESSION, direction: "ASC", field: "logicalBytes" },
  oldest: { expression: "created_at", direction: "ASC", field: "createdAt" },
  newest: { expression: "created_at", direction: "DESC", field: "createdAt" },
  updated: { expression: "updated_at", direction: "DESC", field: "updatedAt" },
} as const;

export async function getStorageSummary(owner: string): Promise<StorageSummary> {
  const measuredAt = Date.now();
  // The covering index supplies category and byte totals without loading the prompt overflow pages. Prompt bytes are the
  // indexed text-plus-image expression minus the image bytes, because the text length alone is not stored in the index.
  const [result, imageStorage] = await Promise.all([getD1().prepare(`SELECT CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired' ELSE status END AS category,
    COUNT(*) AS count, COALESCE(SUM(${BYTE_EXPRESSION}), 0) - COALESCE(SUM(attachment_bytes), 0) AS promptBytes, COALESCE(SUM(attachment_count), 0) AS imageCount, COALESCE(SUM(attachment_bytes), 0) AS imageBytes
    FROM handoffs INDEXED BY handoffs_owner_logical_v2 WHERE owner_id = ? GROUP BY category`).bind(measuredAt, owner).run<StorageGroup & { category: string }>(), cleanupSummary(owner)]);
  const empty = (): StorageGroup => ({ count: 0, promptBytes: 0, imageCount: 0, imageBytes: 0, logicalBytes: 0 });
  const groups = Object.fromEntries(STORAGE_CATEGORIES.map(category => [category, empty()])) as StorageSummary["groups"];
  for (const row of result.results) {
    if (STORAGE_CATEGORIES.includes(row.category as typeof STORAGE_CATEGORIES[number]))
      groups[row.category as typeof STORAGE_CATEGORIES[number]] = { count: row.count, promptBytes: row.promptBytes, imageCount: row.imageCount, imageBytes: row.imageBytes, logicalBytes: row.promptBytes + row.imageBytes };
  }
  const handoffs = Object.values(groups).reduce((sum, group) => ({ count: sum.count + group.count, promptBytes: sum.promptBytes + group.promptBytes,
    imageCount: sum.imageCount + group.imageCount, imageBytes: sum.imageBytes + group.imageBytes, logicalBytes: sum.logicalBytes + group.logicalBytes }), empty());
  const size = result.meta?.size_after;
  return { databaseBytes: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null,
    limitBytes: storageLimitBytes(), measuredAt, handoffs, groups, imageStorage };
}

export async function listStorageHandoffs(owner: string, params: URLSearchParams): Promise<StoragePage> {
  const { filters, cursor, asOf } = parseStorageQuery(params);
  // The filter is a project id (or a name, matched by key); a text no project answers to still matches the stored name exactly.
  const projectId = filters.project ? await resolveProjectFilter(owner, filters.project) : null;
  const conditions = ["owner_id = ?"], values: (string | number)[] = [owner];
  const add = (condition: string, ...args: (string | number)[]) => { conditions.push(condition); values.push(...args); };
  if (filters.search) add("instr(lower(title || char(10) || project), lower(?)) > 0", filters.search);
  if (filters.status !== "all") add("status = ?", filters.status);
  if (filters.expiration === "expired") add("expires_at IS NOT NULL AND expires_at <= ?", asOf);
  if (filters.expiration === "unexpired") add("(expires_at IS NULL OR expires_at > ?)", asOf);
  if (projectId) add("project_id = ?", projectId);
  else if (filters.project) add("project = ?", filters.project);
  if (filters.sourceDevice) add("(source_device = ? OR source_device_id = ?)", filters.sourceDevice, filters.sourceDevice);
  if (filters.targetDevice) add("(target_device = ? OR target_device_id = ?)", filters.targetDevice, filters.targetDevice);
  if (filters.ageDays) add("created_at < ?", asOf - filters.ageDays * 86_400_000);
  if (filters.minBytes) add(`${BYTE_EXPRESSION} >= ?`, filters.minBytes);
  const where = conditions.join(" AND "), sort = SORTS[filters.sort];
  const countStatement = getD1().prepare(`SELECT COUNT(*) AS count FROM handoffs WHERE ${where}`).bind(...values);
  if (cursor) {
    const operator = sort.direction === "ASC" ? ">" : "<";
    add(`(${sort.expression} ${operator} ? OR (${sort.expression} = ? AND id ${operator} ?))`, cursor.value, cursor.value, cursor.id);
  }
  // Only fixed SQL fragments enter the statement; every owner, filter, and cursor value is bound.
  const [page, count, projects, sources, targets] = await getD1().batch([
    getD1().prepare(`SELECT ${METADATA}, ${PROMPT_BYTES} AS promptBytes, ${BYTE_EXPRESSION} AS logicalBytes FROM handoffs WHERE ${conditions.join(" AND ")}
      ORDER BY ${sort.expression} ${sort.direction}, id ${sort.direction} LIMIT ?`).bind(...values, STORAGE_PAGE_SIZE + 1),
    countStatement,
    getD1().prepare("SELECT DISTINCT project AS value FROM handoffs WHERE owner_id = ? AND project <> '' ORDER BY project LIMIT 200").bind(owner),
    getD1().prepare("SELECT DISTINCT source_device AS value FROM handoffs WHERE owner_id = ? ORDER BY source_device LIMIT 200").bind(owner),
    getD1().prepare("SELECT DISTINCT target_device AS value FROM handoffs WHERE owner_id = ? ORDER BY target_device LIMIT 200").bind(owner),
  ]);
  const rows = page.results as StorageHandoff[], hasMore = rows.length > STORAGE_PAGE_SIZE;
  const handoffs = rows.slice(0, STORAGE_PAGE_SIZE), last = handoffs.at(-1);
  const strings = (result: D1Result) => (result.results as { value: string }[]).map(row => row.value);
  return { handoffs, totalCount: (count.results[0] as { count: number }).count, asOf,
    nextCursor: hasMore && last ? encodeStorageCursor({ v: STORAGE_CURSOR_VERSION, value: last[sort.field], id: last.id, asOf, filters: storageFilterKey(filters) }) : null,
    suggestions: { projects: strings(projects), sourceDevices: strings(sources), targetDevices: strings(targets) } };
}

/** Management reads include expired rows, but never expose owner or idempotency identities. */
export async function getStorageHandoff(owner: string, id: string): Promise<Handoff> {
  const row = await getD1().prepare(`SELECT ${METADATA}, content, result FROM handoffs WHERE owner_id = ? AND id = ?`).bind(owner, id).first<Omit<Handoff, "attachments"> & { attachmentCount: number; imageBytes: number }>();
  if (!row) throw new AgentRelayError("This handoff doesn't exist.", 404);
  const { attachmentCount, imageBytes, ...wire } = row;
  void attachmentCount; void imageBytes;
  return { ...wire, attachments: (await attachmentManifests(owner, [id])).get(id) ?? [] };
}

export async function deleteStorageHandoffs(owner: string, input: Record<string, unknown>): Promise<StorageDeletionResult> {
  const items = parseHandoffDeletions(input), db = getD1();
  // Zero matched rows is a per-item conflict, not a failed SQL statement: other reviewed deletions may still succeed.
  // Each item first queues its images for object deletion and drops their rows, guarded by the same version check,
  // so a stale deletion removes nothing and a successful one never leaves an attachment pointing at a missing handoff.
  const perItem = items.map(item => [...releaseStatements(owner, item.id, item.version),
    db.prepare("DELETE FROM handoffs WHERE owner_id = ? AND id = ? AND version = ? RETURNING id").bind(owner, item.id, item.version),
    db.prepare("SELECT id FROM handoffs WHERE owner_id = ? AND id = ?").bind(owner, item.id)]);
  const outcome = await db.batch(perItem.flat());
  let offset = 0;
  const results: StorageDeletionResult["results"] = items.map((item, index) => {
    const deleted = outcome[offset + 2], remaining = outcome[offset + 3];
    offset += perItem[index].length;
    return { id: item.id, status: deleted.results.length ? "deleted" : remaining.results.length ? "conflict" : "not_found" };
  });
  // Object deletion follows the commit; failures stay queued, visible in Storage, and are retried by later sweeps.
  if (results.some(result => result.status === "deleted")) await sweepQuietly(owner);
  return { results, deletedCount: results.filter(result => result.status === "deleted").length };
}

/** Legacy callers may omit a version; the actual delete still compares the version read here. */
export async function deleteOwnedHandoff(owner: string, id: string, version?: unknown) {
  let expected: number;
  if (version !== undefined) expected = observedVersion(version);
  else {
    const row = await getD1().prepare("SELECT version FROM handoffs WHERE owner_id = ? AND id = ?").bind(owner, id).first<{ version: number }>();
    if (!row) throw new AgentRelayError("This handoff doesn't exist.", 404);
    expected = row.version;
  }
  const result = await deleteStorageHandoffs(owner, { items: [{ id, version: expected }] });
  if (result.results[0].status === "not_found") throw new AgentRelayError("This handoff doesn't exist.", 404);
  if (result.results[0].status === "conflict") throw new AgentRelayError("Another device just updated this handoff. Refresh to continue.", 409);
  return { id };
}
