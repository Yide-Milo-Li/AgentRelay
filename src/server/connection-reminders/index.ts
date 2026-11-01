import { waitUntil } from "cloudflare:workers";
import { claimExpiryReminders, expiringConnection } from "@/server/agent-tokens";
import { expiryRemindersWanted, getNotificationScope, notifyConnectionExpiring } from "@/server/handoffs";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { NotificationConnectionInfo } from "@/shared/contracts/notifications";

/**
 * Connection expiry reminders. Sites runs no scheduled jobs, so reminders are swept for whenever a workspace is in use:
 * the inbox polling while it is open and every MCP request an agent makes. A reminder can therefore arrive late after
 * a quiet spell, but never early and never twice. This is the one place that combines connections with notifications.
 */
type Dependencies = { now?: () => number; schedule?: (task: Promise<unknown>) => void; deliver?: NonNullable<Parameters<typeof notifyConnectionExpiring>[2]>["deliver"] };

/** A workspace is swept at most this often per Worker isolate; the database claim, not this, stops duplicates. */
const SWEEP_INTERVAL = 60_000;
const MAX_TRACKED = 1000;
const lastSweep = new Map<string, number>();

function afterResponse(task: Promise<unknown>) {
  try { waitUntil(task); } catch { /* No request context: the task simply runs on its own. */ }
}

/** Send the expiry reminders that are due for a workspace, after the response. It never throws or rejects. */
export function remindExpiringConnections(owner: string, dependencies: Dependencies = {}): Promise<void> {
  const now = (dependencies.now ?? Date.now)(), last = lastSweep.get(owner);
  if (last !== undefined && now - last < SWEEP_INTERVAL) return Promise.resolve();
  if (lastSweep.size >= MAX_TRACKED) lastSweep.clear();
  lastSweep.set(owner, now);
  const task = (async () => {
    // Without a browser that wants them, claiming would use reminders up for nobody.
    if (!(await expiryRemindersWanted(owner))) return;
    const due = await claimExpiryReminders(owner, now);
    await Promise.all(due.map(connection => notifyConnectionExpiring(owner, connection, { schedule: () => {}, deliver: dependencies.deliver })));
  })().catch(() => { console.warn("AgentRelay expiry reminder sweep failed."); });
  (dependencies.schedule ?? afterResponse)(task);
  return task;
}

/** The same agent authentication, with a reminder sweep for the workspace it resolves to. */
export function sweepingRemindersFor<A extends { owner: string }>(resolve: (request: Request) => A | Promise<A>) {
  return async (request: Request) => {
    const actor = await resolve(request);
    void remindExpiringConnections(actor.owner);
    return actor;
  };
}

/**
 * What a reminder shows, read with the person's own session. It answers only for a usable finite connection that this
 * browser still follows; anything else (renewed, revoked, expired, out of scope) is the same 404.
 */
export async function getNotificationConnection(owner: string, id: string, browserId: unknown): Promise<NotificationConnectionInfo> {
  const scope = await getNotificationScope(owner, browserId);
  const connection = scope && scope.notifyExpiry !== "off" ? await expiringConnection(owner, id) : null;
  const follows = !!scope && !!connection && (scope.notifyExpiry === "all" || connection.deviceId === null || connection.deviceId === scope.deviceId);
  if (!follows) throw new AgentRelayError("This reminder is no longer needed.", 404);
  return { id: connection.id, name: scope.showDetails ? connection.name : "", expiresAt: connection.expiresAt };
}
