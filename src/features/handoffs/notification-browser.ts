import { currentNotificationEnvironment, notificationSupport } from "@/shared/browser/notification-support";
import type { NotificationSettings } from "@/shared/contracts/notifications";
import { api } from "@/shared/http/client";
import type { Observation, Repair } from "./notification-state";

const ID_KEY = "agentrelay.notifications.browser-id.v1";
// What this browser last registered with the Site, and whether it was switched on here. Both are hints for repair
// and explanation; the Site's own subscription is always the source of truth.
const REGISTERED_KEY = "agentrelay.notifications.registered.v1";
const ON_KEY = "agentrelay.notifications.on.v1";
const HINT_KEY = "agentrelay.notifications.hint-seen.v1";
const WORKER_WAIT_MS = 10_000;

export function notificationBrowserId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(ID_KEY, id); }
  return id;
}

/** The footer reminder that notifications are off goes away for good once the person has looked at the settings. */
export function notificationHintSeen() { return remembered(HINT_KEY) === "1"; }
export function markNotificationHintSeen() { remember(HINT_KEY, "1"); }

/** True when this browser was switched on here at some point, so a subscription may still exist on the Site. */
export function wasSwitchedOn() { return remembered(ON_KEY) === "1"; }
function remembered(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* A browser that refuses storage simply forgets the hint. */ }
}

/** Waiting for a worker that never activates would hang the settings, so every wait is bounded. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export function notificationWorkerMessage(worker: ServiceWorker, message: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error("The notification worker did not respond.")); }, 5000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    worker.postMessage(message, [channel.port2]);
  });
}

/** Registers the worker if needed and waits, within a bound, until it is active. */
async function activeWorker(): Promise<{ registration: ServiceWorkerRegistration; worker: ServiceWorker }> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  const ready = await withTimeout(navigator.serviceWorker.ready, WORKER_WAIT_MS, "The notification worker did not start.");
  const worker = registration.active ?? ready.active;
  if (!worker) throw new Error("The notification worker is not active.");
  return { registration: ready, worker };
}

/** The worker that is already running, without registering one: reading state must not switch anything on. */
async function runningWorker(): Promise<{ registration: ServiceWorkerRegistration; worker: ServiceWorker } | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.active ? { registration, worker: registration.active } : null;
}

async function sendConfiguration(worker: ServiceWorker, browserId: string | null, locale: "en" | "zh") {
  const reply = await notificationWorkerMessage(worker, { type: "agentrelay.configure-notifications", browserId, locale }) as { ok?: boolean } | null;
  if (!reply?.ok) throw new Error("The notification worker could not save its settings.");
}

export async function configureNotificationWorker(browserId: string | null, locale: "en" | "zh") {
  const { worker } = await activeWorker();
  await sendConfiguration(worker, browserId, locale);
}

async function readWorkerConfiguration(): Promise<Observation["worker"]> {
  try {
    const running = await runningWorker();
    if (!running) return null;
    const value = await notificationWorkerMessage(running.worker, { type: "agentrelay.read-configuration" }) as { browserId: string | null; locale: "en" | "zh" } | null;
    return value ?? { browserId: null, locale: "en" };
  } catch { return null; }
}

export type NotificationReceipt = { at: number; foreground: boolean; authenticated: boolean; outcome?: string };
/** What the worker last did with a push, for the delivery details; null when it has handled none or is not running. */
export async function readNotificationReceipt(): Promise<NotificationReceipt | null> {
  try {
    const running = await runningWorker();
    return running ? await notificationWorkerMessage(running.worker, { type: "agentrelay.notification-diagnostics" }) as NotificationReceipt | null : null;
  } catch { return null; }
}

/** Ask the worker to close notifications of handoffs that are no longer waiting. Best effort. */
export async function syncWaitingNotifications(ids: readonly string[]) {
  const running = await runningWorker();
  if (running) running.worker.postMessage({ type: "agentrelay.sync-waiting", ids });
}

async function endpointDigest(endpoint: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
const keyBytes = (publicKey: string) => Uint8Array.from(atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
function sameKey(subscription: PushSubscription, publicKey: string) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current), b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const running = await runningWorker();
  return (await running?.registration.pushManager.getSubscription()) ?? null;
}

/** Everything the decision needs, read without changing anything. */
export async function observeNotifications(lang: "en" | "zh"): Promise<Observation> {
  const browserId = notificationBrowserId();
  const settings = await api<NotificationSettings>(`/api/notifications?browserId=${encodeURIComponent(browserId)}`);
  const support = notificationSupport(currentNotificationEnvironment());
  const permission = "Notification" in window ? Notification.permission : "denied";
  let local: Observation["local"] = null, worker: Observation["worker"] = null;
  if (support.supported) {
    const subscription = await currentSubscription();
    if (subscription) local = { keyMatches: !!settings.publicKey && sameKey(subscription, settings.publicKey), endpointDigest: await endpointDigest(subscription.endpoint) };
    worker = await readWorkerConfiguration();
  }
  return { support, settings, permission, local, registeredDigest: remembered(REGISTERED_KEY), worker, browserId, locale: lang, previouslyOn: remembered(ON_KEY) === "1" };
}

async function register(browserId: string, deviceId: string, locale: "en" | "zh", subscription: PushSubscription, extra: object = {}) {
  const support = notificationSupport(currentNotificationEnvironment());
  const settings = await api<NotificationSettings>("/api/notifications", "PUT", { browserId, deviceId, locale, subscription: subscription.toJSON(),
    ...(support.supported ? { label: support.label } : {}), ...extra });
  remember(REGISTERED_KEY, await endpointDigest(subscription.endpoint));
  remember(ON_KEY, "1");
  return settings;
}

/** Called only after an explicit enable action. Browser permission is requested by the click handler itself. */
export async function enableNotificationSubscription(browserId: string, deviceId: string, locale: "en" | "zh", publicKey: string, preferences: object = {}) {
  const { registration, worker } = await activeWorker();
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const settings = await register(browserId, deviceId, locale, subscription, preferences);
  await sendConfiguration(worker, browserId, locale);
  return settings;
}

export async function disableNotificationSubscription(browserId: string) {
  // Stop cloud delivery first, so an interrupted local unsubscribe cannot keep receiving new events.
  await api("/api/notifications", "DELETE", { browserId });
  remember(ON_KEY, null); remember(REGISTERED_KEY, null);
  const running = await runningWorker();
  // Forgetting the settings in the worker is a courtesy: the Site no longer sends anything to this browser.
  if (running) await sendConfiguration(running.worker, null, "en").catch(() => {});
  await (await running?.registration.pushManager.getSubscription())?.unsubscribe();
}

/** Carry out the silent repairs a decision asked for, in the order given. Throws if one cannot be done; the caller then asks for a click. */
export async function applyNotificationRepairs(repairs: readonly Repair[], observation: Observation) {
  const { browserId, locale, settings } = observation, row = settings.subscription;
  for (const repair of repairs) {
    if (repair === "delete-row") await api("/api/notifications", "DELETE", { browserId });
    else if (repair === "drop-local") await (await currentSubscription())?.unsubscribe();
    else if (repair === "clear-worker") { if (await runningWorker()) await configureNotificationWorker(null, locale); }
    else if (repair === "sync-row") await api("/api/notifications", "PATCH", { browserId, locale });
    else if (repair === "sync-worker") await configureNotificationWorker(browserId, locale);
    else if (repair === "reregister" || repair === "resubscribe") {
      if (!row || !settings.publicKey) throw new Error("There is no subscription to repair.");
      const { registration } = await activeWorker();
      let subscription = await registration.pushManager.getSubscription();
      if (repair === "resubscribe") {
        await subscription?.unsubscribe();
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(settings.publicKey) });
      }
      if (!subscription) throw new Error("There is no push subscription to register.");
      await register(browserId, row.deviceId, locale, subscription);
      await configureNotificationWorker(browserId, locale);
    }
  }
}
