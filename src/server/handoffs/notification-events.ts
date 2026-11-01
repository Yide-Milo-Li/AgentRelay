import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { notificationSubscriptions } from "@/server/db/schema";
import { isReservedDeviceName } from "@/shared/formatting/device-identity";
import { deliverNotification } from "./notification-delivery";
import type { HandoffProgress, NotificationEvent } from "@/shared/contracts/notifications";
import { buildNotificationEvent, buildProgressEvent, recordDelivery, vapidConfig } from "./notification-subscriptions";

/** `created` is a new handoff; `requeued` is one put back to Ready after it was claimed or finished. */
export type NotificationReason = "created" | "requeued";
export type ReadyHandoff = { id: string; version: number; targetDeviceId: string | null; targetDevice: string };
type Dependencies = { schedule?: (task: Promise<unknown>) => void; deliver?: typeof deliverNotification };

/** One event never contacts more browsers than this, so a workspace full of stale subscriptions stays cheap. */
const MAX_DESTINATIONS = 20;

/** Work handed to `waitUntil` finishes after the response is sent; outside a request there is nothing to extend. */
function afterResponse(task: Promise<unknown>) {
  try { waitUntil(task); } catch { /* No request context: the task simply runs on its own. */ }
}

/**
 * Tell the browsers that should hear about a handoff that is now Ready for its device. Call it only after the change
 * has committed. It never throws and never rejects: a notification problem must not fail or undo the handoff, because
 * the inbox stays the source of truth. The returned promise settles when delivery is over, for tests.
 */
export function notifyHandoffReady(owner: string, handoff: ReadyHandoff, reason: NotificationReason, dependencies: Dependencies = {}): Promise<void> {
  const config = vapidConfig();
  if (!config) return Promise.resolve();
  const deliver = dependencies.deliver ?? deliverNotification;
  const task = (async () => {
    const toAnyDevice = !handoff.targetDeviceId && isReservedDeviceName(handoff.targetDevice);
    // A name that is not a registered device (and not "any device") has no browser bound to it.
    if (!toAnyDevice && !handoff.targetDeviceId) return;
    const rows = await getDb().select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.ownerId, owner), isNull(notificationSubscriptions.disabledAt),
      reason === "requeued" ? eq(notificationSubscriptions.notifyRequeue, true) : undefined,
      toAnyDevice ? eq(notificationSubscriptions.notifyAny, true) : eq(notificationSubscriptions.deviceId, handoff.targetDeviceId!),
    )).orderBy(asc(notificationSubscriptions.createdAt)).limit(MAX_DESTINATIONS);
    const event = buildNotificationEvent(handoff);
    await Promise.all(rows.map(async row => {
      try { await recordDelivery(owner, row, await deliver(row, event, config)); }
      catch { console.warn("AgentRelay notification delivery failed."); }
    }));
  })().catch(() => { console.warn("AgentRelay notification fan-out failed."); });
  (dependencies.schedule ?? afterResponse)(task);
  return task;
}

export type ProgressedHandoff = { id: string; version: number; sourceDeviceId: string | null; claimedByDeviceId: string | null };

/**
 * Tell the browsers bound to a handoff's source device that it was claimed or finished. Call it only after the change has
 * committed. Nobody hears about a handoff whose source is not a registered device, or one its own device claimed. Like
 * `notifyHandoffReady` it never throws and never rejects.
 */
export function notifyHandoffProgress(owner: string, handoff: ProgressedHandoff, progress: HandoffProgress, dependencies: Dependencies = {}): Promise<void> {
  const config = vapidConfig();
  if (!config || !handoff.sourceDeviceId || handoff.claimedByDeviceId === handoff.sourceDeviceId) return Promise.resolve();
  const deliver = dependencies.deliver ?? deliverNotification;
  const task = (async () => {
    const rows = await getDb().select().from(notificationSubscriptions).where(and(
      eq(notificationSubscriptions.ownerId, owner), isNull(notificationSubscriptions.disabledAt), eq(notificationSubscriptions.deviceId, handoff.sourceDeviceId!),
      progress === "claimed" ? eq(notificationSubscriptions.notifyProgress, "all") : ne(notificationSubscriptions.notifyProgress, "off"),
    )).orderBy(asc(notificationSubscriptions.createdAt)).limit(MAX_DESTINATIONS);
    const event = buildProgressEvent(handoff, progress);
    await Promise.all(rows.map(async row => {
      try { await recordDelivery(owner, row, await deliver(row, event, config)); }
      catch { console.warn("AgentRelay notification delivery failed."); }
    }));
  })().catch(() => { console.warn("AgentRelay progress fan-out failed."); });
  (dependencies.schedule ?? afterResponse)(task);
  return task;
}

/** An agent connection whose expiry reminder is due; `lead` is the reminder's lead time in milliseconds. */
export type ExpiringConnection = { id: string; deviceId: string | null; expiresAt: number; lead: number };

const listensForExpiry = (owner: string) => and(eq(notificationSubscriptions.ownerId, owner), isNull(notificationSubscriptions.disabledAt),
  ne(notificationSubscriptions.notifyExpiry, "off"));

/** Whether any browser in the workspace wants expiry reminders at all, so a sweep can stop before it uses any up. */
export async function expiryRemindersWanted(owner: string) {
  if (!vapidConfig()) return false;
  const [row] = await getDb().select({ browserId: notificationSubscriptions.browserId }).from(notificationSubscriptions).where(listensForExpiry(owner)).limit(1);
  return !!row;
}

/**
 * Remind the browsers that follow a connection that it expires soon. A browser follows every connection (`all`), or
 * those bound to its own device and those bound to none (`device`). The push names only the connection and its expiry;
 * the worker reads the name with the person's session. Like handoff events it never throws.
 */
export function notifyConnectionExpiring(owner: string, connection: ExpiringConnection, dependencies: Dependencies = {}): Promise<void> {
  const config = vapidConfig();
  if (!config) return Promise.resolve();
  const deliver = dependencies.deliver ?? deliverNotification;
  const task = (async () => {
    const rows = await getDb().select().from(notificationSubscriptions).where(and(listensForExpiry(owner),
      connection.deviceId === null ? undefined : or(eq(notificationSubscriptions.notifyExpiry, "all"), eq(notificationSubscriptions.deviceId, connection.deviceId)),
    )).orderBy(asc(notificationSubscriptions.createdAt)).limit(MAX_DESTINATIONS);
    const event: NotificationEvent = { type: "agentrelay.connection-expiring", eventId: `${connection.id}:${connection.expiresAt}:${connection.lead}`,
      connectionId: connection.id, expiresAt: connection.expiresAt };
    await Promise.all(rows.map(async row => {
      try { await recordDelivery(owner, row, await deliver(row, event, config)); }
      catch { console.warn("AgentRelay notification delivery failed."); }
    }));
  })().catch(() => { console.warn("AgentRelay expiry reminder fan-out failed."); });
  (dependencies.schedule ?? afterResponse)(task);
  return task;
}
