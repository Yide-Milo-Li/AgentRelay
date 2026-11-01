import { waitUntil } from "cloudflare:workers";
import { getD1 } from "@/server/db/client";
import { purgeObjectCleanup, releaseExpiredStatements } from "@/server/attachments";
import { IMAGE_LIMITS } from "@/shared/contracts/attachments";

/**
 * Expired handoffs are deleted automatically: their text, attachment rows and image objects. Sites runs no scheduled
 * jobs, so the purge runs whenever a workspace is in use (the inbox, both MCP endpoints, Storage), and a handoff goes
 * at the first activity after it expires. Until then it is already hidden from everything but Storage.
 *
 * No version check is needed: nothing writes `expires_at` after creation and every lifecycle operation skips expired
 * rows, so an expired row stays expired. Each statement still re-checks expiry against the same `now`.
 */
const PURGE_CHUNK = 50;
/** A sweep removes at most this many chunks, so a backlog drains over a few requests while each one stays bounded. */
const SWEEP_CHUNKS = 4;
/** A workspace is swept at most this often per Worker isolate; the SQL guard, not this, keeps concurrent sweeps safe. */
const SWEEP_INTERVAL = 60_000;
const MAX_TRACKED = 1000;
const lastSweep = new Map<string, number>();
const EXPIRED = "owner_id = ? AND expires_at IS NOT NULL AND expires_at <= ?";

/** Delete up to `chunks` × 50 handoffs that are expired at `now`, oldest expiry first, and their images. Returns how many went. */
export async function purgeExpiredHandoffs(owner: string, options: { now?: number; chunks?: number } = {}): Promise<number> {
  const d1 = getD1(), now = options.now ?? Date.now();
  let deleted = 0;
  for (let chunk = 0; chunk < (options.chunks ?? 1); chunk++) {
    const ids = (await d1.prepare(`SELECT id FROM handoffs WHERE ${EXPIRED} ORDER BY expires_at, id LIMIT ?`).bind(owner, now, PURGE_CHUNK)
      .all<{ id: string }>()).results.map(row => row.id);
    if (!ids.length) break;
    // The images are released and the rows deleted in one transaction, so no attachment ever points at a missing handoff.
    const outcome = await d1.batch([...releaseExpiredStatements(owner, ids, now),
      d1.prepare(`DELETE FROM handoffs WHERE ${EXPIRED} AND id IN (SELECT value FROM json_each(?)) RETURNING id`).bind(owner, now, JSON.stringify(ids))]);
    deleted += outcome[outcome.length - 1].results.length;
    // Objects follow the commit; a failed deletion stays queued in object_cleanup and later sweeps retry it.
    await purgeObjectCleanup(owner, PURGE_CHUNK * IMAGE_LIMITS.maxImages);
    if (ids.length < PURGE_CHUNK) break;
  }
  return deleted;
}

/** One bounded sweep that logs instead of failing the request it rides on. */
export async function purgeExpiredQuietly(owner: string, now = Date.now()): Promise<void> {
  try { await purgeExpiredHandoffs(owner, { now, chunks: SWEEP_CHUNKS }); }
  catch (error) { console.warn("AgentRelay expired handoff purge failed", (error as Error)?.name); }
}

function afterResponse(task: Promise<unknown>) {
  try { waitUntil(task); } catch { /* No request context: the task simply runs on its own. */ }
}

type SweepDependencies = { now?: () => number; schedule?: (task: Promise<unknown>) => void };
/** Purge a workspace's expired handoffs after the response, at most once a minute per isolate. It never throws or rejects. */
export function sweepExpiredHandoffs(owner: string, dependencies: SweepDependencies = {}): Promise<void> {
  const now = (dependencies.now ?? Date.now)(), last = lastSweep.get(owner);
  if (last !== undefined && now - last < SWEEP_INTERVAL) return Promise.resolve();
  if (lastSweep.size >= MAX_TRACKED) lastSweep.clear();
  lastSweep.set(owner, now);
  const task = purgeExpiredQuietly(owner, now);
  (dependencies.schedule ?? afterResponse)(task);
  return task;
}

/** The same authentication, with a sweep for the workspace it resolves to. */
export function sweepingExpiredFor<A extends { owner: string }>(resolve: (request: Request) => A | Promise<A>) {
  return async (request: Request) => {
    const actor = await resolve(request);
    void sweepExpiredHandoffs(actor.owner);
    return actor;
  };
}
