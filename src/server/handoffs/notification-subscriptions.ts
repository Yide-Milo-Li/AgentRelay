import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getD1, getDb } from "@/server/db/client";
import { handoffs, notificationSubscriptions } from "@/server/db/schema";
import { requireDevice } from "@/server/devices";
import type { Actor } from "@/server/core/actor";
import { isReservedDeviceName } from "@/shared/formatting/device-identity";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { HandoffProgress, NotificationEvent, NotificationHandoffInfo, NotificationProgressInfo, NotificationSettings } from "@/shared/contracts/notifications";
import { browserIdOf, notificationInput, notificationPatch } from "./notification-validation";
import { deliverNotification, type DeliveryResult } from "./notification-delivery";
import { pushConfig } from "./push-keys";

const mine = (owner: string, browserId: string) => and(eq(notificationSubscriptions.ownerId, owner), eq(notificationSubscriptions.browserId, browserId));
const fields = {
  browserId: notificationSubscriptions.browserId, deviceId: notificationSubscriptions.deviceId, locale: notificationSubscriptions.locale,
  version: notificationSubscriptions.version, disabledAt: notificationSubscriptions.disabledAt,
  notifyRequeue: notificationSubscriptions.notifyRequeue, notifyAny: notificationSubscriptions.notifyAny,
  showDetails: notificationSubscriptions.showDetails, label: notificationSubscriptions.label, notifyExpiry: notificationSubscriptions.notifyExpiry,
  notifyProgress: notificationSubscriptions.notifyProgress,
  lastAttemptAt: notificationSubscriptions.lastAttemptAt, lastAcceptedAt: notificationSubscriptions.lastAcceptedAt, lastError: notificationSubscriptions.lastError,
};

/** The most other browsers the settings list; a workspace with more than this has stale subscriptions to clear. */
const MAX_LISTED = 50;

/**
 * This browser's settings and the workspace's other browsers. `origin` is the Site's own address, passed when a browser
 * reads its settings: it lets the first reading make the workspace's push key pair, so nothing has to be configured.
 */
export async function getNotificationSettings(owner: string, inputId: unknown, origin?: string): Promise<NotificationSettings> {
  const browserId = browserIdOf(inputId), config = await pushConfig(owner, origin);
  const [row] = await getDb().select(fields).from(notificationSubscriptions).where(mine(owner, browserId));
  // Members share one workspace with equal rights, so each can see and remove the others' browsers, by display name only.
  const others = await getDb().select({ browserId: notificationSubscriptions.browserId, deviceId: notificationSubscriptions.deviceId, label: notificationSubscriptions.label,
    enabledBy: notificationSubscriptions.createdByName, lastAcceptedAt: notificationSubscriptions.lastAcceptedAt, lastError: notificationSubscriptions.lastError, disabledAt: notificationSubscriptions.disabledAt })
    .from(notificationSubscriptions).where(and(eq(notificationSubscriptions.ownerId, owner), ne(notificationSubscriptions.browserId, browserId)))
    .orderBy(sql`${notificationSubscriptions.lastAcceptedAt} IS NULL`, desc(notificationSubscriptions.lastAcceptedAt), desc(notificationSubscriptions.createdAt)).limit(MAX_LISTED);
  return { available: !!config, publicKey: config?.publicKey ?? null, subscription: row ? { ...row, locale: row.locale === "zh" ? "zh" : "en" } : null, others };
}

export async function saveNotificationSubscription(owner: string, input: Record<string, unknown>, actor?: Pick<Actor, "userId" | "name">) {
  if (!(await pushConfig(owner))) throw new AgentRelayError("Browser notifications are not configured on this Site.", 503);
  const draft = notificationInput(input);
  await requireDevice(owner, draft.deviceId);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft.endpoint));
  const endpointHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now(), db = getDb(), d1 = getD1();
  // A browser that cleared its site storage gets a new id but keeps its push endpoint. The earlier row for that
  // endpoint is replaced in the same transaction, or the unique endpoint index would refuse the new one.
  const replace = db.delete(notificationSubscriptions).where(and(eq(notificationSubscriptions.ownerId, owner),
    eq(notificationSubscriptions.endpointHash, endpointHash), ne(notificationSubscriptions.browserId, draft.browserId))).toSQL();
  // Attribution records who enabled the browser; the name is shown to other members, the platform id never is.
  const enabledBy = actor ? { createdByUserId: actor.userId, createdByName: actor.name } : {};
  const upsert = db.insert(notificationSubscriptions).values({ ...draft, ...enabledBy, ownerId: owner, endpointHash, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [notificationSubscriptions.ownerId, notificationSubscriptions.browserId], set: {
      ...draft, ...enabledBy, endpointHash, updatedAt: now, disabledAt: null, lastError: null, version: sql`${notificationSubscriptions.version} + 1`,
    } }).toSQL();
  await d1.batch([d1.prepare(replace.sql).bind(...replace.params), d1.prepare(upsert.sql).bind(...upsert.params)]);
  return getNotificationSettings(owner, draft.browserId);
}

/** Change options, language, label or the bound device of an existing subscription; the push subscription itself is untouched. */
export async function updateNotificationSubscription(owner: string, input: Record<string, unknown>) {
  const { browserId, changes } = notificationPatch(input);
  if (changes.deviceId) await requireDevice(owner, changes.deviceId);
  const [updated] = await getDb().update(notificationSubscriptions).set({ ...changes, updatedAt: Date.now(), version: sql`${notificationSubscriptions.version} + 1` })
    .where(mine(owner, browserId)).returning({ browserId: notificationSubscriptions.browserId });
  if (!updated) throw new AgentRelayError("Enable notifications in this browser first.", 404);
  return getNotificationSettings(owner, browserId);
}

export async function deleteNotificationSubscription(owner: string, inputId: unknown) {
  await getDb().delete(notificationSubscriptions).where(mine(owner, browserIdOf(inputId)));
  return { disabled: true };
}

/** Read only display metadata after current platform authentication; push payloads never contain task content. */
export async function getNotificationHandoff(owner: string, id: string, inputBrowserId: unknown) {
  const browserId = browserIdOf(inputBrowserId);
  const [subscription] = await getDb().select({ deviceId: notificationSubscriptions.deviceId, notifyAny: notificationSubscriptions.notifyAny, showDetails: notificationSubscriptions.showDetails })
    .from(notificationSubscriptions).where(and(mine(owner, browserId), isNull(notificationSubscriptions.disabledAt)));
  const [row] = subscription ? await getDb().select({ id: handoffs.id, title: handoffs.title, project: handoffs.project, version: handoffs.version,
    targetDeviceId: handoffs.targetDeviceId, targetDevice: handoffs.targetDevice }).from(handoffs)
    .where(and(eq(handoffs.ownerId, owner), eq(handoffs.id, id), eq(handoffs.status, "ready"), or(isNull(handoffs.expiresAt), gt(handoffs.expiresAt, Date.now())))) : [];
  // The handoff must still be addressed to the device this browser is bound to, or to any device when the browser asked to hear about those.
  const addressed = !!row && (row.targetDeviceId === subscription.deviceId || (subscription.notifyAny && !row.targetDeviceId && isReservedDeviceName(row.targetDevice)));
  if (!row || !addressed) throw new AgentRelayError("This notification no longer has a waiting handoff.", 404);
  // With details off the Site never hands the title or project to the browser; the worker then shows its generic text.
  return { id: row.id, title: subscription.showDetails ? row.title : "", project: subscription.showDetails ? row.project : "", version: row.version };
}

/**
 * Display metadata for a progress notification, read like `getNotificationHandoff` with the person's current session. The
 * handoff must still be at a claimed or done step and have been sent from the device this browser is bound to; the worker
 * compares the version and step with its event. The receipt is never part of it.
 */
export async function getNotificationProgress(owner: string, id: string, inputBrowserId: unknown): Promise<NotificationProgressInfo> {
  const browserId = browserIdOf(inputBrowserId);
  const [subscription] = await getDb().select({ deviceId: notificationSubscriptions.deviceId, showDetails: notificationSubscriptions.showDetails })
    .from(notificationSubscriptions).where(and(mine(owner, browserId), isNull(notificationSubscriptions.disabledAt), ne(notificationSubscriptions.notifyProgress, "off")));
  const [row] = subscription ? await getDb().select({ id: handoffs.id, title: handoffs.title, project: handoffs.project, version: handoffs.version,
    status: handoffs.status, claimedBy: handoffs.claimedBy }).from(handoffs)
    .where(and(eq(handoffs.ownerId, owner), eq(handoffs.id, id), eq(handoffs.sourceDeviceId, subscription.deviceId),
      inArray(handoffs.status, ["claimed", "done"]), or(isNull(handoffs.expiresAt), gt(handoffs.expiresAt, Date.now())))) : [];
  if (!row) throw new AgentRelayError("This notification no longer has a handoff update.", 404);
  const details = subscription.showDetails;
  return { id: row.id, version: row.version, status: row.status as HandoffProgress,
    title: details ? row.title : "", project: details ? row.project : "", device: details ? row.claimedBy ?? "" : "" };
}

/** A progress event names the handoff, its version and the step it reached, and nothing the handoff says. */
export function buildProgressEvent(handoff: Pick<NotificationHandoffInfo, "id" | "version">, progress: HandoffProgress): NotificationEvent {
  return { type: "agentrelay.handoff-progress", eventId: `${handoff.id}:${handoff.version}:progress`, handoffId: handoff.id, version: handoff.version, progress };
}

/**
 * What an active browser asked to hear about connections, for an expiry reminder's display data; null when the browser
 * has no active subscription. The caller decides whether a given connection is in scope.
 */
export async function getNotificationScope(owner: string, inputBrowserId: unknown) {
  const [row] = await getDb().select({ deviceId: notificationSubscriptions.deviceId, notifyExpiry: notificationSubscriptions.notifyExpiry, showDetails: notificationSubscriptions.showDetails })
    .from(notificationSubscriptions).where(and(mine(owner, browserIdOf(inputBrowserId)), isNull(notificationSubscriptions.disabledAt)));
  return row ?? null;
}

/** Store what a delivery attempt achieved. The version guard drops the result if the browser re-registered meanwhile. */
export async function recordDelivery(owner: string, subscription: { browserId: string; version: number }, result: DeliveryResult) {
  const now = Date.now();
  await getDb().update(notificationSubscriptions).set({ lastAttemptAt: now, lastError: result.error,
    ...(result.accepted ? { lastAcceptedAt: now } : {}), ...(result.disabled ? { disabledAt: now } : {}),
  }).where(and(mine(owner, subscription.browserId), eq(notificationSubscriptions.version, subscription.version)));
}

/** A handoff event names only the handoff and its version; a test event is the one that insists on a system notification. */
export function buildNotificationEvent(handoff: Pick<NotificationHandoffInfo, "id" | "version"> | null, testId: string = crypto.randomUUID()): NotificationEvent {
  return handoff ? { type: "agentrelay.handoff-ready", eventId: `${handoff.id}:${handoff.version}`, handoffId: handoff.id, version: handoff.version }
    : { type: "agentrelay.test", eventId: testId, system: true };
}

/** A test is a real push to this browser. With a handoff id it announces that handoff exactly as an arrival would, which acceptance runs use. */
export async function sendNotificationTest(owner: string, inputId: unknown, handoffId?: string) {
  const browserId = browserIdOf(inputId), config = await pushConfig(owner);
  if (!config) throw new AgentRelayError("Browser notifications are not configured on this Site.", 503);
  const [row] = await getDb().select().from(notificationSubscriptions).where(and(mine(owner, browserId), isNull(notificationSubscriptions.disabledAt)));
  if (!row) throw new AgentRelayError("Enable notifications in this browser first.", 404);
  const handoff = handoffId ? await getNotificationHandoff(owner, handoffId, browserId) : null;
  const event = buildNotificationEvent(handoff);
  const result = await deliverNotification(row, event, config);
  await recordDelivery(owner, row, result);
  return result;
}
