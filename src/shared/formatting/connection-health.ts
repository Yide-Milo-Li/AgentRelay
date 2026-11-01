import {
  CONNECTION_EXPIRING_DAYS, CONNECTION_IDLE_DAYS, CONNECTION_REMINDER_LEADS, CONNECTION_PENDING_HOURS, CONNECTION_STALE_DAYS, type TokenInfo,
} from "@/shared/contracts/agent-tokens";

/** `rotatedAt` is optional so callers holding older shapes still type-check; a rotation starts the connection's "pending" window again. */
type Timing = Pick<TokenInfo, "createdAt" | "expiresAt" | "neverExpires" | "lastAuthenticatedAt" | "revokedAt"> & { rotatedAt?: number | null };
export type ConnectionStatus = "pending" | "unused" | "active" | "idle" | "revoked" | "expired";
export type ConnectionAttention = "unused" | "stale" | "expiring";

const HOUR = 3_600_000, DAY = 24 * HOUR;

export function isRetired(token: Timing, now: number) {
  return token.revokedAt !== null || (!token.neverExpires && token.expiresAt !== null && token.expiresAt <= now);
}

/** Where a connection stands, judged only from when its secret was last accepted. */
export function connectionStatus(token: Timing, now: number): ConnectionStatus {
  if (token.revokedAt !== null) return "revoked";
  if (isRetired(token, now)) return "expired";
  if (token.lastAuthenticatedAt === null) return now - Math.max(token.createdAt, token.rotatedAt ?? 0) < CONNECTION_PENDING_HOURS * HOUR ? "pending" : "unused";
  return now - token.lastAuthenticatedAt > CONNECTION_IDLE_DAYS * DAY ? "idle" : "active";
}

/** A finite connection that is still usable and ends within the warning window. */
export function isExpiring(token: Timing, now: number) {
  return !isRetired(token, now) && !token.neverExpires && token.expiresAt !== null && token.expiresAt - now <= CONNECTION_EXPIRING_DAYS * DAY;
}

/** Reasons to review a usable connection. Reviewing never revokes anything by itself. */
export function connectionAttention(token: Timing, now: number): ConnectionAttention[] {
  if (isRetired(token, now)) return [];
  const reasons: ConnectionAttention[] = [];
  if (connectionStatus(token, now) === "unused") reasons.push("unused");
  if (token.lastAuthenticatedAt !== null && now - token.lastAuthenticatedAt >= CONNECTION_STALE_DAYS * DAY) reasons.push("stale");
  if (isExpiring(token, now)) reasons.push("expiring");
  return reasons;
}

/**
 * The most urgent expiry reminder a finite connection has reached at `now`: the shortest lead time that the time left
 * fits inside. Null once it has expired or while more than the longest lead remains. Reminders that are skipped over
 * (a quiet week, a short lifetime) are never sent late; only this one counts.
 */
export function dueReminderLead(expiresAt: number, now: number): number | null {
  const left = expiresAt - now;
  if (left <= 0) return null;
  let due: number | null = null;
  for (const lead of CONNECTION_REMINDER_LEADS) if (left <= lead) due = lead;
  return due;
}
