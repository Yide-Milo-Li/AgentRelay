/** Public credential metadata. Only issuance includes the one-time secret. `deviceId` only labels the connection. */
export type TokenInfo = { id: string; name: string; createdAt: number; expiresAt: number | null; neverExpires: boolean;
  lastAuthenticatedAt: number | null; revokedAt: number | null; deviceId: string | null;
  /** An existing connection id identifies an issuer group without disclosing a platform user id. */
  issuerRef: string;
  /** Display name of the workspace member who minted it; null for credentials issued before attribution existed. */
  createdByName: string | null;
  /** True when the signed-in viewer minted it. Derived on the server so no platform user id reaches the browser. */
  issuedByViewer: boolean;
  /** Bumped by every change. Management calls may send the version they read; a stale one is answered with 409. */
  version: number;
  /** Who ended the connection and why; null while it is usable and for rows revoked before this was recorded. */
  revokedByName: string | null; revokedReason: RevokedReason | null;
  /** When the secret was last replaced; null if it never was. */
  rotatedAt: number | null;
  /** The agent profile chosen when the connection was made; null for connections that predate it. For display only. */
  clientProfile: string | null;
  /** What the agent last reported about itself when it initialized MCP. Untrusted text for display; nothing branches on it. */
  lastClient: { name: string; version: string | null } | null };
export type RevokedReason = "manual" | "bulk" | "offboarding" | "device_deleted";
export type IssuedAgentToken = TokenInfo & { token: string };

/** An owner can hold this many usable credentials; the list also shows at most this many retired ones. */
export const MAX_ACTIVE_CONNECTIONS = 100;
export const MAX_INACTIVE_LISTED = 100;

/** Health thresholds for a connection's credential use. They describe use of the secret, never whether an agent is online. */
/** The longest name or version an agent may report, in characters; anything longer is ignored rather than cut. */
export const CLIENT_TEXT_MAX = 64;
export const CONNECTION_PENDING_HOURS = 24;
export const CONNECTION_IDLE_DAYS = 30;
export const CONNECTION_STALE_DAYS = 60;
export const CONNECTION_EXPIRING_DAYS = 14;
/**
 * Expiry reminders, as lead times before a connection expires, longest first: 7 days, 3 days, 1 day and 1 hour.
 * Each one is sent at most once per lifetime; renewing the connection starts the series again.
 */
export const CONNECTION_REMINDER_LEADS = [7 * 86_400_000, 3 * 86_400_000, 86_400_000, 3_600_000] as const;

/** What the activity history records. Entries keep the connection's name as it was, so they outlive the connection. */
export type ConnectionEventKind = "created" | "renamed" | "relabeled" | "extended" | "rotated" | "revoked" | "bulk_revoked" | "removed";
export type ConnectionEventDetail = Record<string, string | number | boolean | null>;
export type ConnectionEvent = {
  id: string; kind: ConnectionEventKind; at: number;
  /** Null for a summary that covers several connections. */
  tokenId: string | null; tokenName: string;
  /** Display name of the member who acted; null for entries without attribution. */
  actorName: string | null; detail: ConnectionEventDetail | null;
};
/** `nextBefore` is an opaque cursor for the following, older page; null once the history is exhausted. */
export type ConnectionEventsPage = { events: ConnectionEvent[]; nextBefore: string | null };

/** The history keeps the newest entries per workspace, and never drops one younger than the retention window. */
export const MAX_CONNECTION_EVENTS = 2000;
export const CONNECTION_EVENT_RETENTION_DAYS = 30;
export const CONNECTION_EVENTS_PAGE = 50;
export const CONNECTION_EVENTS_MAX_PAGE = 200;
