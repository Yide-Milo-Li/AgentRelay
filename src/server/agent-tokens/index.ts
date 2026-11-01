import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/server/db/client";
import { agentTokens } from "@/server/db/schema";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { Actor } from "@/server/core/actor";
import { requireDevice } from "@/server/devices";
import { CLIENT_TEXT_MAX, CONNECTION_REMINDER_LEADS, MAX_ACTIVE_CONNECTIONS, MAX_INACTIVE_LISTED, type TokenInfo, type IssuedAgentToken, type RevokedReason } from "@/shared/contracts/agent-tokens";
import { dueReminderLead } from "@/shared/formatting/connection-health";
import { recordEvent, recordRowEvents, trimEvents } from "./events";

export { listConnectionEvents } from "./events";

const publicFields = {
  id: agentTokens.id, name: agentTokens.name, createdAt: agentTokens.createdAt,
  expiresAt: agentTokens.expiresAt, revokedAt: agentTokens.revokedAt, deviceId: agentTokens.deviceId,
  createdByName: agentTokens.createdByName,
  createdByUserId: agentTokens.createdByUserId, ownerId: agentTokens.ownerId,
  neverExpires: agentTokens.neverExpires, lastAuthenticatedAt: agentTokens.lastAuthenticatedAt,
  version: agentTokens.version, revokedByName: agentTokens.revokedByName, revokedReason: agentTokens.revokedReason, rotatedAt: agentTokens.rotatedAt,
  clientProfile: agentTokens.clientProfile, lastClientName: agentTokens.lastClientName, lastClientVersion: agentTokens.lastClientVersion,
};
type PublicRow = typeof agentTokens.$inferSelect;
type ListedRow = Pick<PublicRow, keyof typeof publicFields>;
const issuer = (row: Pick<PublicRow, "createdByUserId" | "ownerId">) => row.createdByUserId ?? row.ownerId;
/** `viewer` is the platform id of whoever asks; it only decides `issuedByViewer` and is never copied into the result. */
function asToken(row: ListedRow, issuerRef = row.id, viewer?: string): TokenInfo {
  const { createdByUserId: _user, ownerId: _owner, lastClientName, lastClientVersion, ...info } = row;
  return { ...info, lastClient: lastClientName ? { name: lastClientName, version: lastClientVersion } : null, issuerRef, issuedByViewer: viewer !== undefined && issuer(row) === viewer, expiresAt: row.neverExpires ? null : row.expiresAt,
    revokedReason: row.revokedReason as RevokedReason | null };
}
function mintSecret() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return "agentrelay_" + Array.from(random, b => b.toString(16).padStart(2, "0")).join("");
}
async function digest(token: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
const mine = (owner: string, id?: string) => and(eq(agentTokens.ownerId, owner), id === undefined ? undefined : eq(agentTokens.id, id));
// A credential is usable until it is revoked or reaches its expiry; everything else is retired.
const usable = (now: number) => and(isNull(agentTokens.revokedAt), or(eq(agentTokens.neverExpires, true), gt(agentTokens.expiresAt, now)));
const retired = (now: number) => or(isNotNull(agentTokens.revokedAt), and(eq(agentTokens.neverExpires, false), lte(agentTokens.expiresAt, now)));

/** The same rule as `retired`, for a row already in memory. */
const retiredAt = (row: Pick<PublicRow, "revokedAt" | "neverExpires" | "expiresAt">, now: number) =>
  row.revokedAt !== null || (!row.neverExpires && row.expiresAt <= now);

/** The version the caller last saw, when it sends one. Without it a change is not checked against what the caller read. */
export function parseVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new AgentRelayError("version must be a positive integer.");
  return value;
}
const stale = () => new AgentRelayError("This connection was just changed elsewhere. Refresh and try again.", 409);
/** Who did it, for history and for the revoked-by line; absent for internal callers. */
type Who = Pick<Actor, "userId" | "name">;
const nameOf = (who?: Who) => who?.name ?? null;
/** The row as it is now, fetched in the owner's scope. */
async function currentRow(owner: string, id: string) {
  const [row] = await getDb().select(publicFields).from(agentTokens).where(mine(owner, id)).limit(1);
  return row;
}
/** True while this very row is still at the version a batch was planned against; guards the statements that record history. */
const rowAt = (owner: string, id: string, version: number, extra?: SQL) =>
  sql`exists (select 1 from ${agentTokens} where ${and(mine(owner, id), eq(agentTokens.version, version), extra)})`;
const bump = sql`${agentTokens.version} + 1`;
const DAY = 86_400_000;
/**
 * A lifetime that already starts inside a reminder's window has used that reminder up: a 1-day connection is never
 * told on creation that it expires in a day, and only its 1-hour reminder is left to send.
 */
const startingReminder = (expiresAt: number, now: number) => dueReminderLead(expiresAt, now);

/**
 * `expiresInDays`: 1–365, or null for a permanent connection, which has to be acknowledged. With no `defaultDays`,
 * leaving it out means "no change" and returns undefined.
 */
function parseLifetime(input: Record<string, unknown>, defaultDays?: number): { neverExpires: boolean; days: number } | undefined {
  const given = input.expiresInDays;
  if (given === undefined && defaultDays === undefined) return undefined;
  const neverExpires = given === null, days = given === undefined ? defaultDays : given;
  if (neverExpires && input.acknowledgePermanentRisk !== true) throw new AgentRelayError("Acknowledge the permanent connection risk first.");
  if (!neverExpires && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365)) throw new AgentRelayError("Expiry must be between 1 and 365 days.");
  return { neverExpires, days: neverExpires ? 0 : days as number };
}

/** An agent profile id such as "codex". Profiles are data, so the server checks the shape and not a list of known agents. */
function parseClientProfile(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new AgentRelayError("clientProfile must be an agent profile id.");
  return value;
}
// No control, formatting (zero-width, direction override) or line-separator characters: the text is shown to other members.
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
function clientText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && [...text].length <= CLIENT_TEXT_MAX && PRINTABLE.test(text) ? text : null;
}

function parseName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) throw new AgentRelayError("Credential names must be 1–80 characters.");
  return value.trim();
}
/** A device reference must be a registered device id. It only labels the credential and never narrows what it can do. */
async function parseDevice(owner: string, value: unknown) {
  if (typeof value !== "string" || !value) throw new AgentRelayError("deviceId must be the id of a registered device.");
  return (await requireDevice(owner, value)).id;
}

/** Usable credentials first, then the most recent retired ones, so old rows can never push a usable one out of the list. */
export async function listAgentTokens(owner: string, viewer?: string): Promise<TokenInfo[]> {
  const db = getDb(), now = Date.now();
  const [active, inactive] = await Promise.all([
    db.select(publicFields).from(agentTokens).where(and(mine(owner), usable(now))).orderBy(desc(agentTokens.createdAt)).limit(MAX_ACTIVE_CONNECTIONS),
    db.select(publicFields).from(agentTokens).where(and(mine(owner), retired(now))).orderBy(desc(agentTokens.createdAt)).limit(MAX_INACTIVE_LISTED),
  ]);
  const refs = new Map<string, string>();
  return [...active, ...inactive].map(row => {
    const key = issuer(row);
    if (!refs.has(key)) refs.set(key, row.id);
    return asToken(row, refs.get(key), viewer);
  });
}

/** Mint only for the platform-authenticated caller; it receives the secret once. */
export async function createAgentToken(actor: Actor, input: Record<string, unknown>): Promise<IssuedAgentToken> {
  const { owner } = actor;
  const name = parseName(input.name);
  const { neverExpires, days } = parseLifetime(input, 90) as { neverExpires: boolean; days: number };
  const deviceId = input.deviceId == null ? null : await parseDevice(owner, input.deviceId);
  const clientProfile = parseClientProfile(input.clientProfile);
  const now = Date.now();
  const [{ total }] = await getDb().select({ total: count() }).from(agentTokens).where(and(mine(owner), usable(now)));
  if (total >= MAX_ACTIVE_CONNECTIONS) throw new AgentRelayError("You can keep up to 100 active connections. Revoke ones you no longer use first.", 409);
  const token = mintSecret(), id = crypto.randomUUID(), db = getDb();
  const [[record]] = await db.batch([
    db.insert(agentTokens).values({
      id, ownerId: owner, name, tokenHash: await digest(token),
      createdAt: now, expiresAt: neverExpires ? now : now + days * DAY, neverExpires, revokedAt: null, deviceId,
      createdByUserId: actor.userId, createdByName: actor.name, clientProfile,
      expiryRemindedLead: neverExpires ? null : startingReminder(now + days * DAY, now),
    }).returning(publicFields),
    recordEvent(owner, { tokenId: id, tokenName: name, kind: "created", actor: actor.name, at: now, detail: { deviceId, days: neverExpires ? null : days } }),
    trimEvents(owner, now),
  ]);
  return { ...asToken(record, record.id, actor.userId), token };
}

async function missingOrInactive(owner: string, id: string, inactiveMessage: string): Promise<never> {
  const [row] = await getDb().select({ id: agentTokens.id }).from(agentTokens).where(mine(owner, id)).limit(1);
  throw row ? new AgentRelayError(inactiveMessage, 409) : new AgentRelayError("This credential doesn't exist.", 404);
}

/** Why a guarded change did not apply: the row is gone, retired, or simply no longer at the version the caller read. */
async function explainConflict(owner: string, id: string): Promise<never> {
  const latest = await currentRow(owner, id);
  if (!latest) throw new AgentRelayError("This credential doesn't exist.", 404);
  throw retiredAt(latest, Date.now()) ? new AgentRelayError("A revoked or expired connection can't be changed.", 409) : stale();
}

/**
 * Rename, rebind or set the lifetime of a usable credential. Retired credentials are read-only; a stale `version` is
 * answered with 409. A new lifetime counts from now (`expiresInDays`), or is permanent with `expiresInDays: null`.
 */
export async function updateAgentToken(owner: string, id: string, input: Record<string, unknown>, actor?: Who): Promise<TokenInfo> {
  const lifetime = parseLifetime(input);
  if (input.name === undefined && input.deviceId === undefined && !lifetime) throw new AgentRelayError("Change at least the name, the device or the lifetime.");
  const patch: { name?: string; deviceId?: string | null; neverExpires?: boolean; expiresAt?: number; expiryRemindedLead?: number | null } = {};
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.deviceId !== undefined) patch.deviceId = input.deviceId === null ? null : await parseDevice(owner, input.deviceId);
  const expected = parseVersion(input.version), now = Date.now();
  const row = await currentRow(owner, id);
  if (!row) throw new AgentRelayError("This credential doesn't exist.", 404);
  if (retiredAt(row, now)) throw new AgentRelayError("A revoked or expired connection can't be changed.", 409);
  if (expected !== undefined && expected !== row.version) throw stale();
  // A permanent row keeps expires_at = created_at, so an older Worker reading it fails closed.
  if (lifetime) {
    patch.neverExpires = lifetime.neverExpires; patch.expiresAt = lifetime.neverExpires ? row.createdAt : now + lifetime.days * DAY;
    patch.expiryRemindedLead = lifetime.neverExpires ? null : startingReminder(patch.expiresAt, now);
  }

  const guard = rowAt(owner, id, row.version, usable(now)), name = patch.name ?? row.name, by = nameOf(actor);
  const history: BatchItem<"sqlite">[] = [];
  if (patch.name !== undefined && patch.name !== row.name)
    history.push(recordEvent(owner, { tokenId: id, tokenName: name, kind: "renamed", actor: by, at: now, detail: { from: row.name, to: patch.name } }, guard));
  if (patch.deviceId !== undefined && patch.deviceId !== row.deviceId)
    history.push(recordEvent(owner, { tokenId: id, tokenName: name, kind: "relabeled", actor: by, at: now, detail: { from: row.deviceId, to: patch.deviceId } }, guard));
  if (lifetime && !(lifetime.neverExpires && row.neverExpires))
    history.push(recordEvent(owner, { tokenId: id, tokenName: name, kind: "extended", actor: by, at: now,
      detail: { from: row.neverExpires ? null : row.expiresAt, to: lifetime.neverExpires ? null : patch.expiresAt as number } }, guard));
  const db = getDb();
  const results = await db.batch([
    ...history, trimEvents(owner, now),
    db.update(agentTokens).set({ ...patch, version: bump }).where(and(mine(owner, id), usable(now), eq(agentTokens.version, row.version))).returning(publicFields),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  const [record] = results.at(-1) as ListedRow[];
  return record ? asToken(record, record.id, actor?.userId) : explainConflict(owner, id);
}

/**
 * Replace a usable connection's secret. The old secret stops working at once and the new one is returned once.
 * Only the member who issued the connection may do it: the new secret acts as that member, so anyone else
 * would be handed their identity. They can create their own connection instead.
 */
export async function rotateAgentToken(actor: Actor, id: string, input: Record<string, unknown>): Promise<IssuedAgentToken> {
  const { owner } = actor, expected = parseVersion(input.version), now = Date.now();
  const row = await currentRow(owner, id);
  if (!row) throw new AgentRelayError("This credential doesn't exist.", 404);
  if (retiredAt(row, now)) throw new AgentRelayError("A revoked or expired connection can't be changed.", 409);
  if (issuer(row) !== actor.userId) throw new AgentRelayError("Only the member who issued a connection can replace its secret. Create a new connection instead.", 403);
  if (expected !== undefined && expected !== row.version) throw stale();
  const token = mintSecret(), db = getDb();
  const [, , rotated] = await db.batch([
    recordEvent(owner, { tokenId: id, tokenName: row.name, kind: "rotated", actor: actor.name, at: now }, rowAt(owner, id, row.version, usable(now))),
    trimEvents(owner, now),
    db.update(agentTokens).set({ tokenHash: await digest(token), lastAuthenticatedAt: null, lastClientName: null, lastClientVersion: null, rotatedAt: now, version: bump })
      .where(and(mine(owner, id), usable(now), eq(agentTokens.version, row.version))).returning(publicFields),
  ]);
  return rotated[0] ? { ...asToken(rotated[0], id, actor.userId), token } : explainConflict(owner, id);
}

/** Idempotent: revoking a credential that is already revoked returns it unchanged. A stale `version` is answered with 409. */
export async function revokeAgentToken(owner: string, id: string, actor?: Who, expected?: number): Promise<TokenInfo> {
  const row = await currentRow(owner, id);
  if (!row) throw new AgentRelayError("This credential doesn't exist.", 404);
  if (row.revokedAt !== null) return asToken(row, row.id, actor?.userId);
  if (expected !== undefined && expected !== row.version) throw stale();
  const now = Date.now(), by = nameOf(actor), db = getDb();
  const [, , revoked] = await db.batch([
    recordEvent(owner, { tokenId: id, tokenName: row.name, kind: "revoked", actor: by, at: now, detail: { reason: "manual" } },
      rowAt(owner, id, row.version, isNull(agentTokens.revokedAt))),
    trimEvents(owner, now),
    db.update(agentTokens).set({ revokedAt: now, revokedByName: by, revokedReason: "manual", version: bump })
      .where(and(mine(owner, id), isNull(agentTokens.revokedAt), eq(agentTokens.version, row.version))).returning(publicFields),
  ]);
  if (revoked[0]) return asToken(revoked[0], row.id, actor?.userId);
  const latest = await currentRow(owner, id);
  if (!latest) throw new AgentRelayError("This credential doesn't exist.", 404);
  if (latest.revokedAt !== null) return asToken(latest, latest.id, actor?.userId);
  throw stale();
}

/** Permanent removal is only allowed for revoked or expired credentials; the rule lives in the WHERE clause. */
export async function removeInactiveAgentToken(owner: string, id: string, actor?: Who): Promise<{ id: string }> {
  const now = Date.now(), where = and(mine(owner, id), retired(now)) as SQL, db = getDb();
  const [, , removed] = await db.batch([
    recordRowEvents("removed", nameOf(actor), now, undefined, where),
    trimEvents(owner, now),
    db.delete(agentTokens).where(where).returning({ id: agentTokens.id }),
  ]);
  return removed[0] ?? missingOrInactive(owner, id, "This connection is still active. Revoke it before removing it.");
}

export async function removeInactiveAgentTokens(owner: string, actor?: Who): Promise<{ removed: number }> {
  const now = Date.now(), where = and(mine(owner), retired(now)) as SQL, db = getDb();
  const [, , removed] = await db.batch([
    recordRowEvents("removed", nameOf(actor), now, undefined, where),
    trimEvents(owner, now),
    db.delete(agentTokens).where(where).returning({ id: agentTokens.id }),
  ]);
  return { removed: removed.length };
}

/** How many usable connections are bound to a device. */
export async function countUsableForDevice(owner: string, deviceId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(agentTokens).where(and(mine(owner), eq(agentTokens.deviceId, deviceId), usable(Date.now())));
  return row.n;
}

/**
 * What happens to a device's connections when the device is deleted: they are unbound and, with `revoke`, the usable
 * ones are revoked first, each with a history entry. `guard` is the deleting caller's condition (the device still has
 * the version it saw); when it fails, nothing is revoked or recorded. `read` receives the results of these statements,
 * in order, and counts the revoked and the merely unbound connections (retired ones bound to the device count as unbound).
 */
export function releaseDeviceStatements(owner: string, deviceId: string, guard: SQL, { revoke, by, now }: { revoke: boolean; by: string | null; now: number }) {
  const db = getDb(), flag = sql`${revoke ? 1 : 0} = 1`;
  const selected = and(mine(owner), eq(agentTokens.deviceId, deviceId), usable(now), flag, guard) as SQL;
  const statements: BatchItem<"sqlite">[] = [
    // A connection is revoked by a device deletion at most once, and this id is the one the backfill migration wrote for past ones.
    recordRowEvents("revoked", by, now, { reason: "device_deleted" satisfies RevokedReason }, selected, "device-deleted:"),
    trimEvents(owner, now),
    db.update(agentTokens).set({ revokedAt: now, revokedByName: by, revokedReason: "device_deleted" satisfies RevokedReason, version: bump })
      .where(selected).returning({ id: agentTokens.id }),
    db.update(agentTokens).set({ deviceId: null, version: bump })
      .where(and(mine(owner), eq(agentTokens.deviceId, deviceId), guard)).returning({ id: agentTokens.id }),
  ];
  const read = (results: readonly unknown[]) => {
    const revoked = (results[2] as unknown[]).length, bound = (results[3] as unknown[]).length;
    return { revoked, unbound: bound - revoked };
  };
  return { statements, read };
}

/** Agent credentials select their stored owner and issuer, never a caller-supplied identity. */
export async function resolveAgentToken(token: string) {
  const [record] = await getDb().select(publicFields).from(agentTokens)
    .where(and(eq(agentTokens.tokenHash, await digest(token)), usable(Date.now()))).limit(1);
  if (!record) throw new AgentRelayError("The Agent Token is invalid, expired or revoked.", 401);
  return record;
}

/** Record successful authentication at most once per minute, after workspace membership checks succeed. */
export async function recordAgentAuthentication(owner: string, id: string) {
  const now = Date.now();
  await getDb().update(agentTokens).set({ lastAuthenticatedAt: now }).where(and(mine(owner, id), usable(now),
    or(isNull(agentTokens.lastAuthenticatedAt), lte(agentTokens.lastAuthenticatedAt, now - 60_000))));
}

/**
 * Remember what an agent called itself when it initialized MCP. The report is untrusted display text: a name that is
 * missing, too long or not printable is ignored whole, and a bad version only drops the version. It is not a change
 * a member made, so the connection's version stays put.
 */
export async function recordAgentClient(owner: string, id: string, clientInfo: unknown) {
  if (!clientInfo || typeof clientInfo !== "object") return;
  const reported = clientInfo as Record<string, unknown>, name = clientText(reported.name);
  if (!name) return;
  const version = clientText(reported.version);
  await getDb().update(agentTokens).set({ lastClientName: name, lastClientVersion: version })
    .where(and(mine(owner, id), usable(Date.now()), sql`(${agentTokens.lastClientName} is not ${name} or ${agentTokens.lastClientVersion} is not ${version})`));
}

/** Return only the credential used by this request, never another member's platform identifier. */
export function agentConnectionInfo(row: ListedRow) { return asToken(row, row.id, issuer(row)); }

/**
 * Revoke a set of usable connections in one batch. `extra` is the guard that makes the set exact: if it does not
 * hold when the batch runs, nothing is revoked and nothing is recorded. `issuerName` is the one member who issued
 * all of them (empty for a legacy issuer), or null when they come from several members.
 */
async function revokeSet(owner: string, ids: string[], reason: RevokedReason, actor: Who | undefined, issuerName: string | null, extra: (now: number) => SQL | undefined) {
  const db = getDb(), now = Date.now(), by = nameOf(actor);
  const selected = and(mine(owner), inArray(agentTokens.id, ids), usable(now), extra(now)) as SQL;
  const [, , , revoked] = await db.batch([
    recordRowEvents("revoked", by, now, { reason }, selected),
    recordEvent(owner, { tokenId: null, tokenName: issuerName ?? "", kind: "bulk_revoked", actor: by, at: now, detail: { count: ids.length, reason, issuer: issuerName } },
      sql`exists (select 1 from ${agentTokens} where ${selected})`),
    trimEvents(owner, now),
    db.update(agentTokens).set({ revokedAt: now, revokedByName: by, revokedReason: reason, version: bump }).where(selected).returning({ id: agentTokens.id }),
  ]);
  if (revoked.length !== ids.length) throw new AgentRelayError("Connections changed since the preview. Refresh and review them again.", 409);
  return { revoked: revoked.map(row => row.id) };
}
function parseIds(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ACTIVE_CONNECTIONS || value.some(id => typeof id !== "string") || new Set(value).size !== value.length)
    throw new AgentRelayError("Preview a unique, non-empty list of active connection ids first.");
  return value as string[];
}

/** Revoke exactly these usable connections, or none: an id that is unknown, foreign, already retired or repeated refuses the whole request. */
export async function revokeTokenSet(owner: string, input: Record<string, unknown>, actor?: Who) {
  const ids = parseIds(input.ids), reason = input.reason === undefined ? "bulk" : input.reason;
  if (reason !== "bulk" && reason !== "offboarding") throw new AgentRelayError("reason must be bulk or offboarding.");
  const rows = await getDb().select(publicFields).from(agentTokens).where(and(mine(owner), inArray(agentTokens.id, ids)));
  const changed = () => new AgentRelayError("Connections changed since the preview. Refresh and review them again.", 409);
  if (rows.length !== ids.length) throw changed();
  const issuers = new Set(rows.map(issuer)), issuerName = issuers.size === 1 ? rows[0].createdByName ?? "" : null;
  // Counted inside the write, so a connection retired between the read and the batch still refuses the whole set.
  return revokeSet(owner, ids, reason, actor, issuerName, now =>
    sql`(select count(*) from ${agentTokens} where ${and(mine(owner), inArray(agentTokens.id, ids), usable(now))}) = ${ids.length}`);
}

/** Revoke exactly the issuer's previewed active set in one batch. A changed set never partially revokes. */
export async function revokeIssuerTokens(owner: string, input: Record<string, unknown>, actor?: Who) {
  if (typeof input.connectionId !== "string") throw new AgentRelayError("connectionId is required.");
  const ids = parseIds(input.expectedTokenIds);
  const ref = await currentRow(owner, input.connectionId);
  if (!ref) throw new AgentRelayError("This credential doesn't exist.", 404);
  return revokeSet(owner, ids, "offboarding", actor, ref.createdByName ?? "", now => {
    const group = and(mine(owner), eq(sql`coalesce(${agentTokens.createdByUserId}, ${agentTokens.ownerId})`, issuer(ref)), usable(now));
    // The subqueries are evaluated as part of the write: additions, revocations and expirations invalidate the preview.
    return sql`(select count(*) from ${agentTokens} where ${group}) = ${ids.length}
      and not exists (select 1 from ${agentTokens} where ${group} and ${agentTokens.id} not in (${sql.join(ids.map(id => sql`${id}`), sql`, `)}))`;
  });
}

/** A finite, usable connection as an expiry reminder names it. */
export type ExpiryReminder = { id: string; name: string; deviceId: string | null; expiresAt: number; lead: number };
/** One sweep never claims more reminders than this; the rest wait for the next sweep. */
const MAX_REMINDERS_PER_SWEEP = 20;

/**
 * Claim the expiry reminders that are due now. A reminder is claimed by moving the connection's used-up lead forward
 * with a guard on its expiry and on the lead it had, so concurrent sweeps claim each one once, and a renewal in
 * between wins. Only claimed reminders are returned; the caller sends them. A reminder that was claimed but could not
 * be delivered is not retried: the next lead, or the connection list, still tells the person.
 */
export async function claimExpiryReminders(owner: string, now = Date.now()): Promise<ExpiryReminder[]> {
  const db = getDb();
  const candidates = await db.select({ id: agentTokens.id, name: agentTokens.name, deviceId: agentTokens.deviceId, expiresAt: agentTokens.expiresAt, used: agentTokens.expiryRemindedLead })
    .from(agentTokens).where(and(mine(owner), isNull(agentTokens.revokedAt), eq(agentTokens.neverExpires, false),
      gt(agentTokens.expiresAt, now), lte(agentTokens.expiresAt, now + CONNECTION_REMINDER_LEADS[0])))
    .orderBy(agentTokens.expiresAt).limit(MAX_ACTIVE_CONNECTIONS);
  const due = candidates.flatMap(row => {
    const lead = dueReminderLead(row.expiresAt, now);
    return lead !== null && (row.used === null || lead < row.used) ? [{ ...row, lead }] : [];
  }).slice(0, MAX_REMINDERS_PER_SWEEP);
  const claimed = await Promise.all(due.map(async ({ used, ...reminder }) => {
    const [won] = await db.update(agentTokens).set({ expiryRemindedLead: reminder.lead })
      .where(and(mine(owner, reminder.id), isNull(agentTokens.revokedAt), eq(agentTokens.neverExpires, false), eq(agentTokens.expiresAt, reminder.expiresAt),
        used === null ? isNull(agentTokens.expiryRemindedLead) : eq(agentTokens.expiryRemindedLead, used)))
      .returning({ id: agentTokens.id });
    return won ? reminder : null;
  }));
  return claimed.filter(reminder => reminder !== null);
}

/** A finite connection that is still usable, for a reminder to describe; null when it is gone, revoked, expired or permanent. */
export async function expiringConnection(owner: string, id: string, now = Date.now()): Promise<Omit<ExpiryReminder, "lead"> | null> {
  const [row] = await getDb().select({ id: agentTokens.id, name: agentTokens.name, deviceId: agentTokens.deviceId, expiresAt: agentTokens.expiresAt })
    .from(agentTokens).where(and(mine(owner, id), isNull(agentTokens.revokedAt), eq(agentTokens.neverExpires, false), gt(agentTokens.expiresAt, now))).limit(1);
  return row ?? null;
}
