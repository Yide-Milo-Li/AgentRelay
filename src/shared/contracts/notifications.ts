/** Notification delivery is separate from handoff ownership and the ready/claimed/done lifecycle. */
export type NotificationSubscriptionInfo = {
  browserId: string; deviceId: string; locale: "en" | "zh"; version: number; disabledAt: number | null;
  lastAttemptAt: number | null; lastAcceptedAt: number | null; lastError: string | null;
  /** What this browser hears about: handoffs put back to Ready, handoffs sent to any device, and whether the title and project are shown. */
  notifyRequeue: boolean; notifyAny: boolean; showDetails: boolean; label: string | null;
  /** Which agent connections this browser is reminded about before they expire. */
  notifyExpiry: ExpiryReminderScope;
  /** What this browser hears about handoffs sent from its own device. */
  notifyProgress: ProgressScope;
};
/** `done`: only when a handoff sent from this browser's device is completed. `all`: also when it is claimed. */
export type ProgressScope = "off" | "done" | "all";
export const PROGRESS_SCOPES: readonly ProgressScope[] = ["off", "done", "all"];
/** The lifecycle steps a sender hears about. */
export type HandoffProgress = "claimed" | "done";
/** `device`: connections bound to this browser's device, and connections bound to no device. `all`: every connection. */
export type ExpiryReminderScope = "off" | "device" | "all";
export const EXPIRY_REMINDER_SCOPES: readonly ExpiryReminderScope[] = ["off", "device", "all"];
/** Another browser that notifies this workspace. Shown by label, device and the member's name; the platform id and the push address stay on the server. */
export type NotificationBrowserInfo = {
  browserId: string; deviceId: string; label: string | null; enabledBy: string | null;
  lastAcceptedAt: number | null; lastError: string | null; disabledAt: number | null;
};
export type NotificationSettings = {
  available: boolean; publicKey: string | null; subscription: NotificationSubscriptionInfo | null; others: NotificationBrowserInfo[];
};
export type NotificationEvent = {
  type: "agentrelay.test" | "agentrelay.handoff-ready" | "agentrelay.handoff-progress" | "agentrelay.connection-expiring"; eventId: string;
  handoffId?: string; version?: number;
  /** For a progress event: the step the handoff reached at `version`. */
  progress?: HandoffProgress;
  /** For an expiry reminder: the connection and the expiry it was sent for, so a renewed connection's reminder reads as stale. */
  connectionId?: string; expiresAt?: number;
  /** Always show a system notification, even when a page of the Site is visible; a test only proves anything that way. */
  system?: boolean;
};
export type NotificationHandoffInfo = { id: string; title: string; project: string; version: number };
/** What a progress notification shows. Title, project and the claiming device are empty when the browser hides details; the receipt never appears. */
export type NotificationProgressInfo = NotificationHandoffInfo & { status: HandoffProgress; device: string };
/** What an expiry reminder shows. The name is empty when the browser hides details. */
export type NotificationConnectionInfo = { id: string; name: string; expiresAt: number };
