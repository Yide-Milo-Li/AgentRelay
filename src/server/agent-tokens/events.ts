import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { agentTokens, connectionEvents } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import {
  CONNECTION_EVENTS_MAX_PAGE, CONNECTION_EVENTS_PAGE, CONNECTION_EVENT_RETENTION_DAYS, MAX_CONNECTION_EVENTS,
  type ConnectionEvent, type ConnectionEventDetail, type ConnectionEventKind, type ConnectionEventsPage,
} from "@/shared/contracts/agent-tokens";

/**
 * Connection history. Every entry is written by a statement that sits in the same `db.batch` as the change it records
 * and runs before that change, guarded by the same condition the change uses. When the change does not apply
 * (a stale version, a lost race), the guard is false for both and nothing is recorded.
 */
type Entry = { tokenId: string | null; tokenName: string; kind: ConnectionEventKind; actor: string | null; at: number; detail?: ConnectionEventDetail };
const text = (detail?: ConnectionEventDetail) => (detail ? JSON.stringify(detail) : null);

/** One entry, recorded only while `guard` holds (when given). */
export function recordEvent(owner: string, entry: Entry, guard?: SQL) {
  return getDb().insert(connectionEvents).select(sql`select ${crypto.randomUUID()}, ${owner}, ${entry.tokenId}, ${entry.tokenName}, ${entry.kind},
    ${entry.actor}, ${entry.at}, ${text(entry.detail)} ${guard ? sql`where ${guard}` : sql``}`);
}

/**
 * One entry per connection row that `where` selects, with each row's current name. Entries get random ids, or
 * `<idPrefix><connection id>` when the caller knows a connection can have at most one such entry.
 */
export function recordRowEvents(kind: ConnectionEventKind, actor: string | null, at: number, detail: ConnectionEventDetail | undefined, where: SQL, idPrefix?: string) {
  const entryId = idPrefix === undefined ? sql`lower(hex(randomblob(16)))` : sql`${idPrefix} || ${agentTokens.id}`;
  return getDb().insert(connectionEvents).select(sql`select ${entryId}, ${agentTokens.ownerId}, ${agentTokens.id}, ${agentTokens.name},
    ${kind}, ${actor}, ${at}, ${text(detail)} from ${agentTokens} where ${where}`);
}

/** Keeps the newest entries of one workspace; an entry inside the retention window is never dropped. */
export function trimEvents(owner: string, now: number) {
  const cutoff = now - CONNECTION_EVENT_RETENTION_DAYS * 86_400_000;
  return getDb().delete(connectionEvents).where(and(eq(connectionEvents.ownerId, owner), lt(connectionEvents.at, cutoff),
    sql`${connectionEvents.id} not in (select id from ${connectionEvents} where owner_id = ${owner} order by at desc, id desc limit ${MAX_CONNECTION_EVENTS})`));
}

const KINDS: readonly ConnectionEventKind[] = ["created", "renamed", "relabeled", "extended", "rotated", "revoked", "bulk_revoked", "removed"];

function parseDetail(value: string | null): ConnectionEventDetail | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const detail: ConnectionEventDetail = {};
    for (const [key, item] of Object.entries(parsed)) if (item === null || ["string", "number", "boolean"].includes(typeof item)) detail[key] = item as string | number | boolean | null;
    return detail;
  } catch { return null; }
}

/** The cursor is `<at>:<id>`: entries can share a millisecond, so the id breaks the tie. */
function parseCursor(value: unknown): { at: number; id: string } | null {
  if (value === undefined || value === null || value === "") return null;
  const match = typeof value === "string" ? /^(\d{1,15}):([A-Za-z0-9:_-]{1,80})$/.exec(value) : null;
  if (!match) throw new AgentRelayError("before is not a valid history cursor.");
  return { at: Number(match[1]), id: match[2] };
}
function parseLimit(value: unknown) {
  if (value === undefined || value === null || value === "") return CONNECTION_EVENTS_PAGE;
  const limit = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CONNECTION_EVENTS_MAX_PAGE)
    throw new AgentRelayError(`limit must be between 1 and ${CONNECTION_EVENTS_MAX_PAGE}.`);
  return limit;
}

/** Newest first. Revocations caused by deleting a device are recorded like any other change, by the batch that deletes it. */
export async function listConnectionEvents(owner: string, query: { limit?: unknown; before?: unknown; tokenId?: unknown }): Promise<ConnectionEventsPage> {
  const limit = parseLimit(query.limit), cursor = parseCursor(query.before);
  if (query.tokenId !== undefined && (typeof query.tokenId !== "string" || !query.tokenId || query.tokenId.length > 80)) throw new AgentRelayError("tokenId is not valid.");
  const tokenId = query.tokenId as string | undefined;
  const rows = await getDb().select().from(connectionEvents).where(and(
    eq(connectionEvents.ownerId, owner), tokenId === undefined ? undefined : eq(connectionEvents.tokenId, tokenId),
    cursor ? or(lt(connectionEvents.at, cursor.at), and(eq(connectionEvents.at, cursor.at), lt(connectionEvents.id, cursor.id))) : undefined,
  )).orderBy(desc(connectionEvents.at), desc(connectionEvents.id)).limit(limit + 1);
  const events: ConnectionEvent[] = rows.slice(0, limit).map(row => ({
    id: row.id, kind: (KINDS as readonly string[]).includes(row.kind) ? row.kind as ConnectionEventKind : "revoked", at: row.at,
    tokenId: row.tokenId, tokenName: row.tokenName, actorName: row.actorName, detail: parseDetail(row.detail),
  }));
  const last = events.at(-1);
  return { events, nextBefore: rows.length > limit && last ? `${last.at}:${last.id}` : null };
}
