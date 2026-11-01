import { AgentRelayError } from "@/server/core/agent-relay-error";
import { EXPIRY_REMINDER_SCOPES, PROGRESS_SCOPES, type ExpiryReminderScope, type ProgressScope } from "@/shared/contracts/notifications";

export function browserIdOf(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw new AgentRelayError("A valid browser notification ID is required.");
  return value;
}

const UNSUPPORTED_ENDPOINT = "Only the Chrome and Edge push services are supported.";
// One DNS label in front of the fixed suffix, so `a.b.notify.windows.com` and look-alike hosts never match.
const WNS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com$/;

/**
 * The endpoint is an outbound destination, not an arbitrary URL supplied by a trusted caller. Chrome (and Edge off
 * Windows) subscribe through Google's FCM; Edge on Windows subscribes through the Windows Push Notification Service,
 * whose endpoint carries its token in a single `token` query parameter. Nothing else is ever contacted.
 */
export function pushEndpointOf(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw new AgentRelayError("Invalid push endpoint.");
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentRelayError("Invalid push endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new AgentRelayError(UNSUPPORTED_ENDPOINT);
  if (url.hostname === "fcm.googleapis.com") {
    if (url.search || url.pathname === "/") throw new AgentRelayError(UNSUPPORTED_ENDPOINT);
    return url.href;
  }
  const params = [...url.searchParams];
  if (WNS_HOST.test(url.hostname) && url.pathname === "/w/" && params.length === 1 && params[0][0] === "token" && params[0][1] && /^\?token=[^&#]+$/.test(url.search))
    return url.href;
  throw new AgentRelayError(UNSUPPORTED_ENDPOINT);
}

function subscriptionKey(value: unknown, bytes: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 100)
    throw new AgentRelayError("Invalid browser push key.");
  let decoded: string;
  try { decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/")); } catch { throw new AgentRelayError("Invalid browser push key."); }
  if (decoded.length !== bytes || (bytes === 65 && decoded.charCodeAt(0) !== 4)) throw new AgentRelayError("Invalid browser push key.");
  return value;
}

export function subscriptionOf(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentRelayError("A browser push subscription is required.");
  const subscription = value as Record<string, unknown>, keys = subscription.keys as Record<string, unknown> | undefined;
  return { endpoint: pushEndpointOf(subscription.endpoint), p256dh: subscriptionKey(keys?.p256dh, 65), auth: subscriptionKey(keys?.auth, 16) };
}

const PREFERENCES = ["notifyRequeue", "notifyAny", "showDetails"] as const;
// Printable characters only, one to forty of them: the label is display text for the "other browsers" list.
const LABEL = /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u;

function deviceIdOf(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 32) throw new AgentRelayError("Choose a registered device.");
  return value;
}
function localeOf(value: unknown) {
  if (value !== "en" && value !== "zh") throw new AgentRelayError("Choose English or Chinese notifications.");
  return value;
}
function expiryScopeOf(value: unknown) {
  if (!EXPIRY_REMINDER_SCOPES.includes(value as ExpiryReminderScope)) throw new AgentRelayError("Choose which connections to be reminded about.");
  return value as ExpiryReminderScope;
}
function progressScopeOf(value: unknown) {
  if (!PROGRESS_SCOPES.includes(value as ProgressScope)) throw new AgentRelayError("Choose what to hear about handoffs sent from this device.");
  return value as ProgressScope;
}
function labelOf(value: unknown) {
  if (typeof value !== "string" || value.trim() !== value || !LABEL.test(value)) throw new AgentRelayError("A browser label must be 1–40 printable characters.");
  return value;
}

/** Only the preferences that were sent are returned, so a later registration cannot reset the ones it leaves out. */
export function notificationInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !["browserId", "deviceId", "locale", "subscription", "label", "notifyExpiry", "notifyProgress", ...PREFERENCES].includes(key)))
    throw new AgentRelayError("Unknown notification setting.");
  const preferences = preferencesOf(input);
  return { browserId: browserIdOf(input.browserId), deviceId: deviceIdOf(input.deviceId), locale: localeOf(input.locale), ...preferences,
    ...(input.label === undefined ? {} : { label: labelOf(input.label) }),
    ...(input.notifyExpiry === undefined ? {} : { notifyExpiry: expiryScopeOf(input.notifyExpiry) }),
    ...(input.notifyProgress === undefined ? {} : { notifyProgress: progressScopeOf(input.notifyProgress) }), ...subscriptionOf(input.subscription) };
}

function preferencesOf(input: Record<string, unknown>) {
  const preferences: Partial<Record<(typeof PREFERENCES)[number], boolean>> = {};
  for (const key of PREFERENCES) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new AgentRelayError("Notification options must be on or off.");
    preferences[key] = input[key];
  }
  return preferences;
}

/** A partial change to an existing subscription: options, language, label (null clears it) or the bound device. It never carries a subscription. */
export function notificationPatch(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !["browserId", "deviceId", "locale", "label", "notifyExpiry", "notifyProgress", ...PREFERENCES].includes(key))) throw new AgentRelayError("Unknown notification setting.");
  const changes: { deviceId?: string; locale?: "en" | "zh"; label?: string | null; notifyRequeue?: boolean; notifyAny?: boolean; showDetails?: boolean;
    notifyExpiry?: ExpiryReminderScope; notifyProgress?: ProgressScope } = { ...preferencesOf(input) };
  if (input.notifyExpiry !== undefined) changes.notifyExpiry = expiryScopeOf(input.notifyExpiry);
  if (input.notifyProgress !== undefined) changes.notifyProgress = progressScopeOf(input.notifyProgress);
  if (input.deviceId !== undefined) changes.deviceId = deviceIdOf(input.deviceId);
  if (input.locale !== undefined) changes.locale = localeOf(input.locale);
  if (input.label !== undefined) changes.label = input.label === null ? null : labelOf(input.label);
  if (!Object.keys(changes).length) throw new AgentRelayError("Name at least one notification setting to change.");
  return { browserId: browserIdOf(input.browserId), changes };
}
