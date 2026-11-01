import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs"),
  "next/headers": path.join(projectRoot, "tests/support/next-auth-stub.mjs"), "next/navigation": path.join(projectRoot, "tests/support/next-auth-stub.mjs") }, inProject: true };
const tokens = await loadTypeScriptModule("src/server/agent-tokens/index.ts", options);
const devices = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const auth = await loadTypeScriptModule("src/server/auth/index.ts", options);
const owner = { owner: "workspace-a", userId: "workspace-a", name: "Same Name" };
const member = { ...owner, userId: "member-b" };
let db;
const fresh = () => { db?.close(); db = openDatabase(); env.DB = createD1(db); delete env.AGENTRELAY_WORKSPACE_OWNER_ID; };
const issue = (extra = {}, actor = owner) => tokens.createAgentToken(actor, { name: "Test connection", ...extra });
const permanent = (extra = {}, actor = owner) => issue({ expiresInDays: null, acknowledgePermanentRisk: true, ...extra }, actor);
const rejects = (promise, status) => assert.rejects(promise, e => e.status === status);

test("default lifetime remains 90 days; permanent requires explicit boolean acknowledgement", async () => {
  fresh(); const finite = await issue();
  assert.equal(finite.expiresAt - finite.createdAt, 90 * 86400000); assert.equal(finite.neverExpires, false);
  for (const ack of [undefined, false, "true", 1]) await rejects(issue({ expiresInDays: null, acknowledgePermanentRisk: ack }), 400);
  const p = await permanent(); assert.equal(p.expiresAt, null); assert.equal(p.neverExpires, true);
  assert.equal(db.prepare("select expires_at = created_at as closed from agent_tokens where id = ?").get(p.id).closed, 1);
  assert.equal((await tokens.listAgentTokens(owner.owner)).length, 2);
});

test("permanent authenticates after years, is excluded from cleanup, and immediately stops on revocation", async () => {
  fresh(); const p = await permanent(), f = await issue(); const original = Date.now;
  try {
    Date.now = () => original() + 10 * 365 * 86400000;
    assert.equal((await tokens.resolveAgentToken(p.token)).id, p.id); await rejects(tokens.resolveAgentToken(f.token), 401);
    await tokens.updateAgentToken(owner.owner, p.id, { name: "Renamed" });
    await rejects(tokens.removeInactiveAgentToken(owner.owner, p.id), 409);
    assert.equal((await tokens.removeInactiveAgentTokens(owner.owner)).removed, 1);
    await tokens.revokeAgentToken(owner.owner, p.id); await rejects(tokens.resolveAgentToken(p.token), 401);
    assert.equal((await tokens.removeInactiveAgentTokens(owner.owner)).removed, 1);
  } finally { Date.now = original; }
});

test("permanent connections count toward the 100 active limit", async () => {
  fresh(); for (let i = 0; i < 100; i++) await permanent();
  await rejects(issue(), 409); assert.equal((await tokens.listAgentTokens(owner.owner)).length, 100);
});

test("device usage and atomic deletion include permanent connections", async () => {
  fresh(); const d = await devices.createDevice(owner.owner, { name: "Desk", id: "desk" });
  const p = await permanent({ deviceId: d.id });
  assert.equal((await devices.getDeviceDetail(owner.owner, d.id)).usage.connections, 1);
  assert.equal((await devices.deleteDevice(owner.owner, d.id, { version: d.version, connections: "revoke" })).revokedConnections, 1);
  await rejects(tokens.resolveAgentToken(p.token), 401);
});

test("same display names remain separate issuer groups, including legacy owner credentials", async () => {
  fresh(); const a = await permanent(), b = await permanent({}, member);
  const listing = await tokens.listAgentTokens(owner.owner);
  assert.notEqual(listing.find(t => t.id === a.id).issuerRef, listing.find(t => t.id === b.id).issuerRef);
  assert.ok(!/createdByUserId|ownerId|tokenHash|agentrelay_/.test(JSON.stringify(listing)));
  await tokens.revokeIssuerTokens(owner.owner, { connectionId: a.id, expectedTokenIds: [a.id] });
  await rejects(tokens.resolveAgentToken(a.token), 401); assert.equal((await tokens.resolveAgentToken(b.token)).id, b.id);
});

test("issuedByViewer is derived from the issuer, covers legacy owner rows, and never exposes a user id", async () => {
  fresh(); const a = await permanent(), b = await permanent({}, member);
  db.prepare("update agent_tokens set created_by_user_id = null, created_by_name = null where id = ?").run(a.id);
  const flags = async viewer => Object.fromEntries((await tokens.listAgentTokens(owner.owner, viewer)).map(t => [t.id, t.issuedByViewer]));
  assert.deepEqual(await flags(owner.userId), { [a.id]: true, [b.id]: false });
  assert.deepEqual(await flags(member.userId), { [a.id]: false, [b.id]: true });
  assert.deepEqual(await flags(undefined), { [a.id]: false, [b.id]: false });
  assert.equal(a.issuedByViewer, true); assert.equal(b.issuedByViewer, true);
  assert.equal((await tokens.revokeAgentToken(owner.owner, b.id, member)).issuedByViewer, true);
  assert.ok(!/member-b|workspace-a/.test(JSON.stringify(await tokens.listAgentTokens(owner.owner, member.userId))));
});

test("issuer bulk revocation atomically revokes the exact preview and rejects changed/foreign sets", async () => {
  fresh(); const a = await permanent(), b = await issue();
  await rejects(tokens.revokeIssuerTokens(owner.owner, { connectionId: a.id, expectedTokenIds: [a.id] }), 409);
  assert.equal((await tokens.resolveAgentToken(a.token)).id, a.id);
  await rejects(tokens.revokeIssuerTokens("other-owner", { connectionId: a.id, expectedTokenIds: [a.id, b.id] }), 404);
  const result = await tokens.revokeIssuerTokens(owner.owner, { connectionId: a.id, expectedTokenIds: [b.id, a.id] });
  assert.equal(result.revoked.length, 2); await rejects(tokens.resolveAgentToken(a.token), 401); await rejects(tokens.resolveAgentToken(b.token), 401);
});

test("successful authentication is throttled, diagnostics redact identities, and disabled sharing blocks permanent member tokens", async () => {
  fresh(); const p = await permanent({}, member);
  const request = new Request("https://example.test/api/agent/connection", { headers: { Authorization: `Bearer ${p.token}` } });
  await rejects(auth.actorFromAgent(request), 401);
  assert.equal((await tokens.listAgentTokens(owner.owner))[0].lastAuthenticatedAt, null);
  env.AGENTRELAY_WORKSPACE_OWNER_ID = owner.owner;
  const diagnostic = await auth.connectionFromAgent(request);
  assert.equal(diagnostic.connection.id, p.id); assert.equal(diagnostic.workspace.shared, true);
  assert.ok(!/createdByUserId|ownerId|member-b|tokenHash|agentrelay_/.test(JSON.stringify(diagnostic)));
  const first = (await tokens.listAgentTokens(owner.owner))[0].lastAuthenticatedAt;
  await auth.actorFromAgent(request); assert.equal((await tokens.listAgentTokens(owner.owner))[0].lastAuthenticatedAt, first);
  delete env.AGENTRELAY_WORKSPACE_OWNER_ID; await rejects(auth.actorFromAgent(request), 401);
});

test("additive migration preserves old finite rows; old Worker inserts stay finite and rollback rejects permanent rows", async () => {
  const old = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync(path.join(projectRoot, "drizzle")).filter(f => f.endsWith(".sql")).sort();
    for (const file of migrations.filter(f => !f.startsWith("0007"))) old.exec(readFileSync(path.join(projectRoot, "drizzle", file), "utf8"));
    const now = Date.now(), put = old.prepare("insert into agent_tokens(id,owner_id,name,token_hash,created_at,expires_at) values(?,?,?,?,?,?)");
    put.run("old", "w", "Old", "hash-old", now, now + 100000);
    old.exec(readFileSync(path.join(projectRoot, "drizzle", migrations.find(f => f.startsWith("0007"))), "utf8"));
    put.run("mixed", "w", "Mixed", "hash-mixed", now, now + 200000);
    old.prepare("insert into agent_tokens(id,owner_id,name,token_hash,created_at,expires_at,never_expires) values(?,?,?,?,?,?,1)").run("permanent", "w", "P", "hash-p", now, now);
    assert.equal(old.prepare("select never_expires from agent_tokens where id='mixed'").get().never_expires, 0);
    assert.deepEqual(old.prepare("select id from agent_tokens where revoked_at is null and expires_at > ? order by id").all(now).map(r => r.id), ["mixed", "old"]);
    assert.equal(old.prepare("select expires_at from agent_tokens where id='old'").get().expires_at, now + 100000);
  } finally { old.close(); }
});

const history = (who = owner.owner) => db.prepare("select kind, token_id as tokenId, token_name as tokenName, actor_name as actorName, detail from connection_events where owner_id = ? order by rowid").all(who)
  .map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
const row = id => db.prepare("select version, name, device_id as deviceId, revoked_at as revokedAt, revoked_by_name as revokedByName, revoked_reason as revokedReason from agent_tokens where id = ?").get(id);

test("every change bumps the version, and a stale version is refused without recording history", async () => {
  fresh(); const a = await issue({ name: "Laptop Codex" }); assert.equal(a.version, 1);
  const renamed = await tokens.updateAgentToken(owner.owner, a.id, { name: "Laptop Claude", version: 1 }, owner);
  assert.equal(renamed.version, 2); assert.equal(renamed.name, "Laptop Claude");
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { name: "Stale", version: 1 }, owner), 409);
  await rejects(tokens.revokeAgentToken(owner.owner, a.id, owner, 1), 409);
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { name: "Bad", version: 0 }, owner), 400);
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { name: "Bad", version: "2" }, owner), 400);
  assert.equal(row(a.id).name, "Laptop Claude"); assert.equal(row(a.id).revokedAt, null);
  assert.deepEqual(history().map(event => event.kind), ["created", "renamed"]);
  assert.deepEqual(history()[1].detail, { from: "Laptop Codex", to: "Laptop Claude" });
  const unversioned = await tokens.updateAgentToken(owner.owner, a.id, { name: "Unchecked" }, owner);
  assert.equal(unversioned.version, 3);
});

test("renaming and relabelling record who did what, and a change that does not apply records nothing", async () => {
  fresh(); const desk = await devices.createDevice(owner.owner, { name: "Desk", id: "desk" });
  const a = await issue({ name: "One" });
  await tokens.updateAgentToken(owner.owner, a.id, { name: "One", deviceId: desk.id }, member);
  await tokens.updateAgentToken(owner.owner, a.id, { deviceId: null }, member);
  assert.deepEqual(history().map(event => [event.kind, event.actorName, event.detail]), [
    ["created", "Same Name", { deviceId: null, days: 90 }], ["relabeled", "Same Name", { from: null, to: "desk" }], ["relabeled", "Same Name", { from: "desk", to: null }]]);
  await rejects(tokens.updateAgentToken(owner.owner, "nope", { name: "X" }, owner), 404);
  await rejects(tokens.updateAgentToken("other-owner", a.id, { name: "X" }, owner), 404);
  assert.equal(history().length, 3);
});

test("a write that loses the race to another change records no history and reports a conflict", async () => {
  fresh(); const a = await issue({ name: "Racer" });
  let raced = false;
  env.DB = createD1(db, { beforeBatch: () => { if (raced) return; raced = true; db.prepare("update agent_tokens set version = version + 1, name = 'Winner' where id = ?").run(a.id); } });
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { name: "Loser", version: 1 }, owner), 409);
  assert.equal(row(a.id).name, "Winner"); assert.deepEqual(history().map(event => event.kind), ["created"]);
  raced = false;
  await rejects(tokens.revokeAgentToken(owner.owner, a.id, owner), 409);
  assert.equal(row(a.id).revokedAt, null); assert.deepEqual(history().map(event => event.kind), ["created"]);
});

test("revocation records who revoked it and why, stays idempotent, and survives removal in the history", async () => {
  fresh(); const a = await issue({ name: "Gone soon" });
  const revoked = await tokens.revokeAgentToken(owner.owner, a.id, member, 1);
  assert.equal(revoked.revokedByName, "Same Name"); assert.equal(revoked.revokedReason, "manual"); assert.equal(revoked.version, 2);
  const again = await tokens.revokeAgentToken(owner.owner, a.id, owner, 99);
  assert.equal(again.revokedAt, revoked.revokedAt); assert.equal(again.version, 2); assert.equal(history().filter(event => event.kind === "revoked").length, 1);
  await tokens.removeInactiveAgentToken(owner.owner, a.id, owner);
  assert.equal(db.prepare("select count(*) as n from agent_tokens").get().n, 0);
  assert.deepEqual(history().map(event => [event.kind, event.tokenName, event.tokenId]), [["created", "Gone soon", a.id], ["revoked", "Gone soon", a.id], ["removed", "Gone soon", a.id]]);
  // Entries made in the same millisecond have no defined order, so give each step its own tick.
  const original = Date.now; let tick = original();
  try {
    Date.now = () => tick += 5;
    const b = await issue({ name: "Second" }); await tokens.revokeAgentToken(owner.owner, b.id, owner); await tokens.removeInactiveAgentToken(owner.owner, b.id, owner);
    const page = await tokens.listConnectionEvents(owner.owner, { limit: 3 });
    assert.deepEqual(page.events.map(event => [event.kind, event.tokenName]), [["removed", "Second"], ["revoked", "Second"], ["created", "Second"]]);
    assert.ok(!/created_by_user_id|userId|ownerId/.test(JSON.stringify(page)));
  } finally { Date.now = original; }
});

test("removing retired connections in bulk records one entry each and never touches active ones", async () => {
  fresh(); const keep = await issue({ name: "Keep" }), x = await issue({ name: "X" }), y = await issue({ name: "Y" });
  await tokens.revokeAgentToken(owner.owner, x.id, owner); await tokens.revokeAgentToken(owner.owner, y.id, owner);
  assert.equal((await tokens.removeInactiveAgentTokens(owner.owner, owner)).removed, 2);
  assert.deepEqual(history().filter(event => event.kind === "removed").map(event => event.tokenName).sort(), ["X", "Y"]);
  assert.equal((await tokens.removeInactiveAgentTokens(owner.owner, owner)).removed, 0);
  assert.equal(history().filter(event => event.kind === "removed").length, 2); assert.equal(row(keep.id).revokedAt, null);
  await rejects(tokens.removeInactiveAgentToken(owner.owner, keep.id, owner), 409);
  assert.equal(history().filter(event => event.kind === "removed").length, 2);
  await rejects(tokens.removeInactiveAgentToken(owner.owner, "nope", owner), 404);
});

test("revoking an issuer's set writes one entry per connection plus a summary, and a changed set writes nothing", async () => {
  fresh(); const a = await permanent({ name: "A" }, member), b = await issue({ name: "B" }, member), mine = await issue({ name: "Mine" });
  await rejects(tokens.revokeIssuerTokens(owner.owner, { connectionId: a.id, expectedTokenIds: [a.id] }, owner), 409);
  assert.deepEqual(history().map(event => event.kind), ["created", "created", "created"]);
  assert.equal(row(a.id).revokedAt, null);
  const result = await tokens.revokeIssuerTokens(owner.owner, { connectionId: a.id, expectedTokenIds: [b.id, a.id] }, owner);
  assert.equal(result.revoked.length, 2);
  const events = history().slice(3);
  assert.deepEqual(events.map(event => event.kind).sort(), ["bulk_revoked", "revoked", "revoked"]);
  assert.deepEqual(events.find(event => event.kind === "bulk_revoked").detail, { count: 2, reason: "offboarding", issuer: "Same Name" });
  assert.deepEqual(events.filter(event => event.kind === "revoked").map(event => event.tokenName).sort(), ["A", "B"]);
  assert.ok(events.every(event => event.actorName === "Same Name"));
  assert.deepEqual([row(a.id).revokedReason, row(b.id).revokedByName, row(b.id).version], ["offboarding", "Same Name", 2]);
  assert.equal(row(mine.id).revokedAt, null);
});

test("deleting a device records why its connections were revoked and shows them in the history", async () => {
  fresh(); const desk = await devices.createDevice(owner.owner, { name: "Desk", id: "desk" });
  const a = await issue({ name: "On desk", deviceId: desk.id }), b = await issue({ name: "Also desk", deviceId: desk.id });
  await tokens.revokeAgentToken(owner.owner, b.id, owner);
  const deleted = await devices.deleteDevice(owner.owner, desk.id, { version: desk.version, connections: "revoke" }, "Same Name");
  assert.equal(deleted.revokedConnections, 1);
  assert.deepEqual([row(a.id).revokedReason, row(a.id).revokedByName, row(a.id).deviceId], ["device_deleted", "Same Name", null]);
  assert.ok(row(a.id).version >= 2); assert.equal(row(b.id).revokedReason, "manual");
  const page = await tokens.listConnectionEvents(owner.owner, {});
  const entry = page.events.find(event => event.id === `device-deleted:${a.id}`);
  assert.deepEqual([entry.kind, entry.tokenName, entry.actorName, entry.detail], ["revoked", "On desk", "Same Name", { reason: "device_deleted" }]);
  assert.equal(page.events.filter(event => event.id.startsWith("device-deleted:")).length, 1);
  assert.deepEqual((await tokens.listConnectionEvents(owner.owner, { tokenId: a.id })).events.map(event => event.kind).sort(), ["created", "revoked"]);
});

test("history is paged newest first with a tie-safe cursor, scoped to the workspace, and validates its query", async () => {
  fresh(); const insert = db.prepare("insert into connection_events (id, owner_id, token_id, token_name, kind, actor_name, at, detail) values (?, ?, ?, ?, ?, ?, ?, ?)");
  const now = Date.now();
  for (let i = 0; i < 7; i++) insert.run(`e${i}`, owner.owner, i % 2 ? "t-odd" : "t-even", `Name ${i}`, "created", null, now - Math.floor(i / 2) * 1000, i === 3 ? "{\"ok\":1,\"nested\":{\"x\":1},\"s\":\"t\"}" : i === 4 ? "not json" : null);
  insert.run("foreign", "other-owner", null, "Foreign", "created", null, now, null);
  const first = await tokens.listConnectionEvents(owner.owner, { limit: "3" });
  assert.deepEqual(first.events.map(event => event.id), ["e1", "e0", "e3"]); assert.ok(first.nextBefore);
  const second = await tokens.listConnectionEvents(owner.owner, { limit: 3, before: first.nextBefore });
  assert.deepEqual(second.events.map(event => event.id), ["e2", "e5", "e4"]);
  const third = await tokens.listConnectionEvents(owner.owner, { limit: 3, before: second.nextBefore });
  assert.deepEqual(third.events.map(event => event.id), ["e6"]); assert.equal(third.nextBefore, null);
  assert.deepEqual(first.events[2].detail, { ok: 1, s: "t" }); assert.equal(second.events[2].detail, null);
  assert.deepEqual((await tokens.listConnectionEvents(owner.owner, { tokenId: "t-odd" })).events.map(event => event.id), ["e1", "e3", "e5"]);
  assert.equal((await tokens.listConnectionEvents("someone-else", {})).events.length, 0);
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: "x" }, { limit: 1.5 }, { before: "nonsense" }, { before: "12:bad id" }, { tokenId: "" }, { tokenId: 5 }])
    await rejects(tokens.listConnectionEvents(owner.owner, bad), 400);
});

test("history keeps the newest 2000 entries and never drops one inside the 30 day window", async () => {
  fresh(); const insert = db.prepare("insert into connection_events (id, owner_id, token_id, token_name, kind, actor_name, at, detail) values (?, ?, null, 'x', 'created', null, ?, null)");
  const now = Date.now(), day = 86_400_000; db.exec("BEGIN");
  for (let i = 0; i < 1990; i++) insert.run(`old${i}`, owner.owner, now - (40 + i % 5) * day - i);
  for (let i = 0; i < 30; i++) insert.run(`new${i}`, owner.owner, now - day - i);
  for (let i = 0; i < 5; i++) insert.run(`far${i}`, "other-owner", now - 90 * day);
  db.exec("COMMIT");
  await issue({ name: "Trigger" });
  const count = who => db.prepare("select count(*) as n from connection_events where owner_id = ?").get(who).n;
  assert.equal(count(owner.owner), 2000); assert.equal(count("other-owner"), 5);
  assert.equal(db.prepare("select count(*) as n from connection_events where id like 'new%'").get().n, 30);
  db.exec("BEGIN"); for (let i = 0; i < 100; i++) insert.run(`recent${i}`, owner.owner, now - 2 * day - i); db.exec("COMMIT");
  await issue({ name: "Trigger 2" });
  assert.equal(db.prepare("select count(*) as n from connection_events where id like 'recent%'").get().n, 100);
  // 2101 entries before trimming: only the 101 oldest entries, all outside the window, go.
  assert.equal(count(owner.owner), 2000);
  assert.equal(db.prepare("select count(*) as n from connection_events where id like 'old%'").get().n, 1868);
});

const secretRow = id => db.prepare("select expires_at as expiresAt, never_expires as neverExpires, rotated_at as rotatedAt, last_authenticated_at as lastAuth, token_hash as hash, version from agent_tokens where id = ?").get(id);
const DAY_MS = 86_400_000;

test("extending sets a new lifetime from now, can go permanent and back, and is recorded", async () => {
  fresh(); const a = await issue({ name: "Extendable", expiresInDays: 30 });
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { version: 1 }, owner), 400);
  for (const days of [0, 366, 1.5, "30"]) await rejects(tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: days }, owner), 400);
  for (const ack of [undefined, false, "true"]) await rejects(tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: null, acknowledgePermanentRisk: ack }, owner), 400);
  const before = Date.now(), longer = await tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: 365, version: 1 }, member);
  assert.equal(longer.version, 2); assert.equal(longer.neverExpires, false);
  assert.ok(longer.expiresAt >= before + 365 * DAY_MS && longer.expiresAt <= Date.now() + 365 * DAY_MS);
  const forever = await tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: null, acknowledgePermanentRisk: true }, owner);
  assert.deepEqual([forever.neverExpires, forever.expiresAt, forever.version], [true, null, 3]);
  assert.equal(secretRow(a.id).expiresAt, db.prepare("select created_at from agent_tokens where id = ?").get(a.id).created_at);
  const again = await tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: null, acknowledgePermanentRisk: true }, owner);
  assert.equal(again.version, 4);
  const shorter = await tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: 7 }, owner);
  assert.equal(shorter.neverExpires, false); assert.ok(shorter.expiresAt <= Date.now() + 7 * DAY_MS);
  const extended = history().filter(event => event.kind === "extended");
  assert.equal(extended.length, 3, "permanent to permanent changes nothing worth recording");
  assert.deepEqual([extended[0].actorName, typeof extended[0].detail.from, typeof extended[0].detail.to], ["Same Name", "number", "number"]);
  assert.deepEqual([extended[1].detail.to, typeof extended[1].detail.from], [null, "number"]);
  assert.deepEqual([extended[2].detail.from, typeof extended[2].detail.to], [null, "number"]);
  await tokens.rotateAgentToken(owner, a.id, {});
  // The history API reports every kind as recorded, not just the ones it knew first.
  const listed = await tokens.listConnectionEvents(owner.owner, {});
  assert.deepEqual([...new Set(listed.events.map(event => event.kind))].sort(), ["created", "extended", "rotated"]);
  // Newest first: the shortened lifetime, the permanent one (to: null), then the longer one.
  assert.deepEqual(listed.events.filter(event => event.kind === "extended").map(event => typeof event.detail.to), ["number", "object", "number"]);
  await tokens.revokeAgentToken(owner.owner, a.id, owner);
  await rejects(tokens.updateAgentToken(owner.owner, a.id, { expiresInDays: 30 }, owner), 409);
});

test("rotating replaces the secret at once, resets use, and only the issuer may do it", async () => {
  fresh(); const mine = await issue({ name: "Mine" }), theirs = await issue({ name: "Theirs" }, member);
  await auth.actorFromAgent(new Request("https://example.test/x", { headers: { Authorization: `Bearer ${mine.token}` } }));
  assert.ok(secretRow(mine.id).lastAuth > 0);
  await rejects(tokens.rotateAgentToken(owner, theirs.id, {}), 403);
  await rejects(tokens.rotateAgentToken(member, mine.id, {}), 403);
  await rejects(tokens.rotateAgentToken(owner, mine.id, { version: 7 }), 409);
  await rejects(tokens.rotateAgentToken(owner, mine.id, { version: "1" }), 400);
  await rejects(tokens.rotateAgentToken(owner, "nope", {}), 404);
  await rejects(tokens.rotateAgentToken({ ...owner, owner: "other-owner" }, mine.id, {}), 404);
  assert.equal(secretRow(mine.id).version, 1); assert.deepEqual(history().map(event => event.kind), ["created", "created"]);
  const oldHash = secretRow(mine.id).hash, before = Date.now();
  const rotated = await tokens.rotateAgentToken(owner, mine.id, { version: 1 });
  assert.match(rotated.token, /^agentrelay_[a-f0-9]{64}$/); assert.notEqual(rotated.token, mine.token);
  assert.deepEqual([rotated.version, rotated.lastAuthenticatedAt, rotated.id, rotated.issuedByViewer], [2, null, mine.id, true]);
  assert.ok(rotated.rotatedAt >= before); assert.notEqual(secretRow(mine.id).hash, oldHash);
  await rejects(tokens.resolveAgentToken(mine.token), 401); assert.equal((await tokens.resolveAgentToken(rotated.token)).id, mine.id);
  assert.ok(!JSON.stringify(await tokens.listAgentTokens(owner.owner, owner.userId)).includes(rotated.token));
  assert.deepEqual(history().at(-1), { kind: "rotated", tokenId: mine.id, tokenName: "Mine", actorName: "Same Name", detail: null });
  assert.equal((await tokens.resolveAgentToken((await tokens.rotateAgentToken(owner, mine.id, {})).token)).id, mine.id);
  db.prepare("update agent_tokens set created_by_user_id = null, created_by_name = null where id = ?").run(theirs.id);
  await rejects(tokens.rotateAgentToken(member, theirs.id, {}), 403);
  assert.equal((await tokens.rotateAgentToken(owner, theirs.id, {})).id, theirs.id);
  await tokens.revokeAgentToken(owner.owner, mine.id, owner);
  await rejects(tokens.rotateAgentToken(owner, mine.id, {}), 409);
});

test("a rotation that loses a race changes nothing and records nothing", async () => {
  fresh(); const a = await issue({ name: "Racer" }); const hash = secretRow(a.id).hash; let raced = false;
  env.DB = createD1(db, { beforeBatch: () => { if (raced) return; raced = true; db.prepare("update agent_tokens set version = version + 1 where id = ?").run(a.id); } });
  await rejects(tokens.rotateAgentToken(owner, a.id, {}), 409);
  assert.equal(secretRow(a.id).hash, hash); assert.equal(secretRow(a.id).rotatedAt, null); assert.deepEqual(history().map(event => event.kind), ["created"]);
});

test("revoking an exact set is all or nothing and says who and why", async () => {
  fresh(); const a = await issue({ name: "A" }), b = await issue({ name: "B" }), c = await issue({ name: "C" }, member), gone = await issue({ name: "Gone" });
  await tokens.revokeAgentToken(owner.owner, gone.id, owner);
  for (const input of [{}, { ids: [] }, { ids: "a" }, { ids: [a.id, a.id] }, { ids: [a.id, 5] }, { ids: [a.id], reason: "device_deleted" }, { ids: Array.from({ length: 101 }, (_, i) => `x${i}`) }])
    await rejects(tokens.revokeTokenSet(owner.owner, input, owner), 400);
  for (const ids of [[a.id, "missing"], [a.id, gone.id]]) await rejects(tokens.revokeTokenSet(owner.owner, { ids }, owner), 409);
  await rejects(tokens.revokeTokenSet("other-owner", { ids: [a.id] }, owner), 409);
  assert.equal(row(a.id).revokedAt, null); assert.equal(history().filter(event => event.kind === "bulk_revoked").length, 0);
  const result = await tokens.revokeTokenSet(owner.owner, { ids: [a.id, b.id] }, member);
  assert.deepEqual(result.revoked.sort(), [a.id, b.id].sort());
  assert.deepEqual([row(a.id).revokedReason, row(a.id).revokedByName, row(a.id).version], ["bulk", "Same Name", 2]); assert.equal(row(c.id).revokedAt, null);
  const summary = history().filter(event => event.kind === "bulk_revoked");
  assert.deepEqual(summary.map(event => event.detail), [{ count: 2, reason: "bulk", issuer: "Same Name" }]);
  assert.deepEqual(history().filter(event => event.kind === "revoked" && event.detail?.reason === "bulk").map(event => event.tokenName).sort(), ["A", "B"]);
  const d = await issue({ name: "D" }), e = await issue({ name: "E" }, member);
  await tokens.revokeTokenSet(owner.owner, { ids: [d.id, e.id], reason: "offboarding" }, owner);
  assert.deepEqual(history().filter(event => event.kind === "bulk_revoked").at(-1).detail, { count: 2, reason: "offboarding", issuer: null });
  assert.equal(row(e.id).revokedReason, "offboarding");
});

test("a connection retired between the read and the write refuses the whole set", async () => {
  fresh(); const a = await issue({ name: "A" }), b = await issue({ name: "B" }); let raced = false;
  env.DB = createD1(db, { beforeBatch: () => { if (raced) return; raced = true; db.prepare("update agent_tokens set revoked_at = ? where id = ?").run(Date.now(), b.id); } });
  await rejects(tokens.revokeTokenSet(owner.owner, { ids: [a.id, b.id] }, owner), 409);
  assert.equal(row(a.id).revokedAt, null); assert.deepEqual(history().map(event => event.kind), ["created", "created"]);
});

test("the agent profile is recorded when a connection is made and only its shape is checked", async () => {
  fresh();
  const known = await issue({ clientProfile: "codex" }), other = await issue({ clientProfile: "other" }), future = await issue({ clientProfile: "my-new-agent-2" });
  const none = await issue({}), nulled = await issue({ clientProfile: null });
  assert.deepEqual([known.clientProfile, other.clientProfile, future.clientProfile, none.clientProfile, nulled.clientProfile], ["codex", "other", "my-new-agent-2", null, null]);
  assert.ok([known, other, future, none].every(item => item.lastClient === null));
  for (const bad of ["", "Codex", "has space", "-lead", "a".repeat(33), 5, true, {}]) await rejects(issue({ clientProfile: bad }), 400);
  const listed = await tokens.listAgentTokens(owner.owner, owner.userId);
  assert.equal(listed.find(item => item.id === known.id).clientProfile, "codex");
  assert.ok(!JSON.stringify(listed).includes("lastClientName"));
});

test("what an agent reports about itself is kept as display text, never trusted, and never counted as a member's change", async () => {
  fresh(); const a = await issue({ name: "Reporter" });
  const stored = () => db.prepare("select last_client_name as name, last_client_version as version, version as rev from agent_tokens where id = ?").get(a.id);
  const listedClient = async () => (await tokens.listAgentTokens(owner.owner, owner.userId)).find(item => item.id === a.id).lastClient;
  await tokens.recordAgentClient(owner.owner, a.id, { name: "  claude-code ", version: "2.1.4", capabilities: { sampling: {} } });
  assert.deepEqual(await listedClient(), { name: "claude-code", version: "2.1.4" }); assert.equal(stored().rev, 1);
  const changes = () => db.prepare("select total_changes() as n").get().n, before = changes();
  await tokens.recordAgentClient(owner.owner, a.id, { name: "claude-code", version: "2.1.4" });
  assert.equal(changes(), before, "an unchanged report writes nothing");
  await tokens.recordAgentClient(owner.owner, a.id, { name: "codex" });
  assert.deepEqual(await listedClient(), { name: "codex", version: null });
  await tokens.recordAgentClient(owner.owner, a.id, { name: "codex", version: `1.0\n2` });
  assert.deepEqual(await listedClient(), { name: "codex", version: null }, "a bad version only drops the version");
  const ignored = ["", "   ", "x".repeat(65), "two\nlines", "zero\u200bwidth", "\u202eevil", 5, null, {}, ["codex"], "tab\there"];
  for (const name of ignored) await tokens.recordAgentClient(owner.owner, a.id, { name, version: "9" });
  for (const info of [undefined, null, "codex", 7, [], { version: "1" }]) await tokens.recordAgentClient(owner.owner, a.id, info);
  assert.deepEqual(await listedClient(), { name: "codex", version: null }, "unusable reports leave the last good one");
  await tokens.recordAgentClient(owner.owner, a.id, { name: "<b>bold</b> \"quoted\" & 😀", version: "😀".repeat(64) });
  assert.deepEqual(await listedClient(), { name: "<b>bold</b> \"quoted\" & 😀", version: "😀".repeat(64) });
  await tokens.recordAgentClient(owner.owner, a.id, { name: "😀".repeat(64), version: "😀".repeat(65) });
  assert.deepEqual(await listedClient(), { name: "😀".repeat(64), version: null }, "64 characters fit and 65 do not, counted as characters");
  assert.equal(stored().rev, 1); assert.deepEqual(history().map(event => event.kind), ["created"]);
});

test("a report only reaches a usable connection of the same workspace, and rotating forgets it", async () => {
  fresh(); const a = await issue({ name: "Live" }), gone = await issue({ name: "Gone" });
  await tokens.revokeAgentToken(owner.owner, gone.id, owner);
  await tokens.recordAgentClient("other-owner", a.id, { name: "intruder" });
  await tokens.recordAgentClient(owner.owner, gone.id, { name: "late" });
  await tokens.recordAgentClient(owner.owner, "no-such-id", { name: "nobody" });
  assert.equal(db.prepare("select count(*) as n from agent_tokens where last_client_name is not null").get().n, 0);
  await tokens.recordAgentClient(owner.owner, a.id, { name: "claude-code", version: "2" });
  const rotated = await tokens.rotateAgentToken(owner, a.id, {});
  assert.equal(rotated.lastClient, null); assert.equal(db.prepare("select last_client_name as n from agent_tokens where id = ?").get(a.id).n, null);
});

test("MCP initialize records the client for the connection that made the request, and only that", async () => {
  fresh(); const a = await issue({ name: "Via MCP" }), b = await issue({ name: "Bystander" });
  const request = token => new Request("https://example.test/api/agent/mcp", { headers: { Authorization: `Bearer ${token}` } });
  const actor = await auth.actorFromAgent(request(a.token));
  assert.equal(actor.connectionId, a.id);
  await auth.noteAgentClient(actor, { name: "codex", version: "0.9" });
  const listed = await tokens.listAgentTokens(owner.owner, owner.userId);
  assert.deepEqual([listed.find(item => item.id === a.id).lastClient, listed.find(item => item.id === b.id).lastClient], [{ name: "codex", version: "0.9" }, null]);
  await auth.noteAgentClient({ owner: owner.owner, userId: owner.userId, name: "Browser" }, { name: "browser-session" });
  await auth.noteAgentClient({ ...actor, connectionId: "missing" }, { name: "ghost" });
  assert.equal(db.prepare("select count(*) as n from agent_tokens where last_client_name = 'browser-session' or last_client_name = 'ghost'").get().n, 0);
});
