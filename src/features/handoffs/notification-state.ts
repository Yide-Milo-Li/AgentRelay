import type { NotificationSupport } from "@/shared/browser/notification-support";
import type { NotificationSettings } from "@/shared/contracts/notifications";

/** Everything the browser can observe about notifications, gathered in one place so the verdict below stays a pure function. */
export type Observation = {
  support: NotificationSupport;
  /** The Site's answer for this browser id: whether push is configured, its public key and this browser's subscription. */
  settings: NotificationSettings;
  permission: NotificationPermission;
  /** The browser's own push subscription, if any: whether it was made with this Site's key, and a digest of its endpoint. */
  local: { keyMatches: boolean; endpointDigest: string } | null;
  /** The endpoint digest this browser last registered with the Site. */
  registeredDigest: string | null;
  /** What the notification worker has stored; null when no worker is active. */
  worker: { browserId: string | null; locale: "en" | "zh" } | null;
  browserId: string;
  locale: "en" | "zh";
  /** True when this browser was switched on here earlier, so a missing subscription can be explained. */
  previouslyOn: boolean;
};

export type NotificationState = "unsupported" | "unavailable" | "off" | "on" | "blocked" | "reconnect";
/**
 * `delete-row` removes the Site's subscription; `drop-local` unsubscribes the browser; `clear-worker` and `sync-worker` empty or rewrite
 * the worker's stored configuration; `sync-row` updates the language on the Site; `resubscribe` makes a new push subscription and
 * registers it; `reregister` sends the current one again.
 */
export type Repair = "delete-row" | "drop-local" | "clear-worker" | "resubscribe" | "reregister" | "sync-row" | "sync-worker";
export type Decision = { state: NotificationState; reason?: "mobile" | "browser" | "api"; hint?: "removed"; repairs: Repair[] };

/**
 * What state notifications are in, and which silent repairs would put them right. A repair never asks the person for
 * anything: when permission itself is missing the state is `reconnect` and only a click can fix it.
 */
export function decideNotification(observation: Observation): Decision {
  const { support, settings, permission, local, registeredDigest, worker, browserId, locale } = observation;
  const row = settings.subscription;
  if (!support.supported) return { state: "unsupported", reason: support.reason, repairs: row ? ["delete-row"] : [] };
  if (!settings.available) return { state: "unavailable", repairs: [] };
  // Nothing may be sent to a browser that blocked notifications, so the Site's subscription goes with the permission.
  if (permission === "denied") return { state: "blocked", repairs: row ? ["delete-row"] : [] };
  if (!row) {
    const repairs: Repair[] = [];
    if (local) repairs.push("drop-local");
    if (worker?.browserId) repairs.push("clear-worker");
    return { state: "off", ...(observation.previouslyOn ? { hint: "removed" as const } : {}), repairs };
  }
  if (permission !== "granted") return { state: "reconnect", repairs: [] };
  // A retired subscription (the push service refused it) or one made with another key cannot be fixed by registering it again.
  if (!local || !local.keyMatches || row.disabledAt) return { state: "on", repairs: ["resubscribe"] };
  const repairs: Repair[] = [];
  if (registeredDigest !== local.endpointDigest) repairs.push("reregister");
  if (row.locale !== locale) repairs.push("sync-row");
  if (!worker || worker.browserId !== browserId || worker.locale !== locale) repairs.push("sync-worker");
  return { state: "on", repairs };
}

/** Where a permission request made from a click stands: still open, or answered without a decision (dismissed, ignored, or collapsed by the browser). */
export type PermissionPrompt = "waiting" | "dismissed";
export type PermissionGuide = "waiting" | "dismissed" | "blocked";

/**
 * Which browser-specific permission steps the settings should show. Chrome and Edge can collapse the request into an icon in
 * the address bar instead of a prompt, so an open or unanswered request is explained as well as a block.
 */
export function permissionGuide(state: NotificationState | "loading" | "error", prompt: PermissionPrompt | null): PermissionGuide | null {
  if (state === "blocked") return "blocked";
  if (state !== "off" && state !== "reconnect") return null;
  return prompt;
}
