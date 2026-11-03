import { AgentRelayError } from "./agent-relay-error";

/**
 * D1 quota failures as clear answers instead of a generic 500: a full database (500 MB on Workers Free, 10 GB on Paid
 * and on Sites) and the Workers Free daily row-read and row-write caps, which reset at 00:00 UTC.
 */
const DATABASE_FULL = "This deployment's database is full. Delete old handoffs in Settings › Storage, or move to a plan with more storage.";
const DAILY_LIMIT = "This deployment has used today's database allowance. It resets at 00:00 UTC.";
const FULL_MARKERS = ["exceeded maximum db size", "maximum account storage limit"];
const DAILY_MARKERS = ["daily row read limit", "daily row write limit"];

export function storageQuotaError(error: unknown, now = Date.now()): AgentRelayError | null {
  // Query wrappers put the D1 error in `cause`; walk a few levels.
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++, current = (current as { cause?: unknown }).cause) {
    const message = String((current as { message?: unknown }).message ?? "").toLowerCase();
    // A wrapper's own message quotes the query and its parameters, which can contain prompt text; only causes count.
    if (message.startsWith("failed query:")) continue;
    if (FULL_MARKERS.some(marker => message.includes(marker))) return new AgentRelayError(DATABASE_FULL, 507);
    if (DAILY_MARKERS.some(marker => message.includes(marker))) {
      const today = new Date(now);
      const nextMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
      return new AgentRelayError(DAILY_LIMIT, 503, Math.max(1, Math.ceil((nextMidnight - now) / 1000)));
    }
  }
  return null;
}
