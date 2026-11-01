import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs") }, inProject: true };
const lifecycle = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const { createHandoff } = await loadTypeScriptModule("src/server/handoffs/index.ts", options);
const tokens = await loadTypeScriptModule("src/server/agent-tokens/index.ts", options);
const actor = { owner: "workspace-a", userId: "member-a", name: "Member A" };
const other = { owner: "workspace-b", userId: "member-b", name: "Member B" };
let db;
const fresh = hooks => { db?.close(); db = openDatabase(); env.DB = createD1(db, hooks); };
const handoff = (extra = {}) => createHandoff(actor, { title: "Task", content: "Do it", requestKey: crypto.randomUUID(), ...extra });
const handoffRow = id => db.prepare("select source_device as sourceDevice, source_device_id as sourceDeviceId, target_device as targetDevice, target_device_id as targetDeviceId, version from handoffs where id = ?").get(id);
const tokenRow = id => db.prepare("select device_id as deviceId, revoked_at as revokedAt, revoked_reason as revokedReason, revoked_by_name as revokedByName, version from agent_tokens where id = ?").get(id);
const events = () => db.prepare("select id, token_id as tokenId, kind, actor_name as actorName, detail from connection_events order by id").all();
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);

test("creating a device adopts legacy handoffs that only carry its name or id", async () => {
  fresh();
  const legacy = await handoff({ sourceDevice: "Desk", targetDevice: "Somewhere else" });
  assert.equal(handoffRow(legacy.id).sourceDeviceId, null);
  await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  assert.deepEqual([handoffRow(legacy.id).sourceDeviceId, handoffRow(legacy.id).targetDeviceId], ["desk", null]);
  await rejects(lifecycle.createDevice(actor.owner, { name: "Desk again", id: "desk" }), 409);
});

test("a device does not adopt another workspace's handoffs", async () => {
  fresh();
  const foreign = await createHandoff(other, { title: "Task", content: "Do it", sourceDevice: "Desk", targetDevice: "any", requestKey: "foreign" });
  await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  assert.equal(handoffRow(foreign.id).sourceDeviceId, null);
});

test("deleting a device detaches its handoffs and either unbinds or revokes its connections, recording history", async () => {
  fresh();
  const desk = await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  const sent = await handoff({ sourceDevice: "desk", targetDevice: "any" }), toDesk = await handoff({ sourceDevice: "Agent", targetDevice: "desk" });
  const live = await tokens.createAgentToken(actor, { name: "On desk", deviceId: desk.id }), old = await tokens.createAgentToken(actor, { name: "Old", deviceId: desk.id });
  await tokens.revokeAgentToken(actor.owner, old.id, actor);
  const before = events().length;
  const deleted = await lifecycle.deleteDevice(actor.owner, desk.id, { version: desk.version, connections: "revoke" }, "Member A");
  assert.deepEqual(deleted, { id: "desk", detachedHandoffs: 2, revokedConnections: 1, unboundConnections: 1 });
  assert.deepEqual([handoffRow(sent.id).sourceDevice, handoffRow(sent.id).sourceDeviceId, handoffRow(toDesk.id).targetDevice, handoffRow(toDesk.id).targetDeviceId], ["Desk", null, "Desk", null]);
  assert.equal(handoffRow(sent.id).version, 1);
  assert.deepEqual([tokenRow(live.id).revokedReason, tokenRow(live.id).revokedByName, tokenRow(live.id).deviceId], ["device_deleted", "Member A", null]);
  assert.deepEqual([tokenRow(old.id).revokedReason, tokenRow(old.id).deviceId], ["manual", null]);
  const added = events().filter(event => event.id.startsWith("device-deleted:"));
  assert.deepEqual(added.map(event => [event.id, event.tokenId, event.kind, event.actorName, event.detail]), [[`device-deleted:${live.id}`, live.id, "revoked", "Member A", '{"reason":"device_deleted"}']]);
  assert.equal(events().length, before + 1);
  await rejects(lifecycle.getDeviceDetail(actor.owner, "desk"), 404);
});

test("unbinding keeps connections usable, detaches them, and writes no revocation", async () => {
  fresh();
  const desk = await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  const live = await tokens.createAgentToken(actor, { name: "On desk", deviceId: desk.id });
  const deleted = await lifecycle.deleteDevice(actor.owner, desk.id, { version: desk.version });
  assert.deepEqual([deleted.revokedConnections, deleted.unboundConnections], [0, 1]);
  assert.deepEqual([tokenRow(live.id).revokedAt, tokenRow(live.id).deviceId], [null, null]);
  assert.equal(events().filter(event => event.kind === "revoked").length, 0);
  assert.equal((await tokens.resolveAgentToken(live.token)).id, live.id);
});

test("a delete whose device changed after it was planned touches nothing", async () => {
  let armed = false;
  fresh({ beforeBatch: () => { if (armed) db.prepare("update devices set version = version + 1").run(); } });
  const desk = await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  const sent = await handoff({ sourceDevice: "desk", targetDevice: "desk" }), live = await tokens.createAgentToken(actor, { name: "On desk", deviceId: desk.id });
  const before = { events: events(), handoff: handoffRow(sent.id), token: tokenRow(live.id) };
  armed = true;
  await rejects(lifecycle.deleteDevice(actor.owner, desk.id, { version: desk.version, connections: "revoke" }, "Member A"), 409);
  assert.deepEqual({ events: events(), handoff: handoffRow(sent.id), token: tokenRow(live.id) }, before);
  assert.equal(db.prepare("select count(*) as n from devices where id = 'desk'").get().n, 1);
});

test("a stale version is refused before anything is planned, and other workspaces cannot delete the device", async () => {
  fresh();
  const desk = await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  await rejects(lifecycle.deleteDevice(actor.owner, desk.id, { version: desk.version + 1 }), 409);
  await rejects(lifecycle.deleteDevice(other.owner, desk.id, { version: desk.version }), 404);
  await rejects(lifecycle.deleteDevice(actor.owner, desk.id, {}), 400);
  assert.equal(db.prepare("select count(*) as n from devices").get().n, 1);
});

test("device usage counts open handoffs, all handoffs and only usable connections", async () => {
  fresh();
  const desk = await lifecycle.createDevice(actor.owner, { name: "Desk", id: "desk" });
  const first = await handoff({ sourceDevice: "desk", targetDevice: "any" }), second = await handoff({ sourceDevice: "Agent", targetDevice: "desk" });
  db.prepare("update handoffs set status = 'done' where id = ?").run(first.id);
  await tokens.createAgentToken(actor, { name: "A", deviceId: desk.id });
  const retired = await tokens.createAgentToken(actor, { name: "B", deviceId: desk.id });
  await tokens.revokeAgentToken(actor.owner, retired.id, actor);
  assert.deepEqual((await lifecycle.getDeviceDetail(actor.owner, "desk")).usage, { totalHandoffs: 2, openHandoffs: 1, connections: 1 });
  assert.equal(second.targetDeviceId, "desk");
});

test("the backfill migration records past device-deletion revocations once, under the ids the feed used to synthesize", () => {
  fresh();
  const insert = db.prepare("insert into agent_tokens (id, owner_id, name, token_hash, created_at, expires_at, revoked_at, revoked_reason, revoked_by_name) values (?, ?, ?, ?, 1, 2, ?, ?, ?)");
  insert.run("t-deleted", "workspace-a", "On desk", "h1", 50, "device_deleted", "Member A");
  insert.run("t-manual", "workspace-a", "Manual", "h2", 60, "manual", "Member A");
  insert.run("t-active", "workspace-a", "Active", "h3", null, null, null);
  const sql = readFileSync(path.join(projectRoot, "drizzle/0013_connection_event_backfill.sql"), "utf8");
  db.exec("delete from connection_events"); db.exec(sql); db.exec(sql);
  assert.deepEqual(db.prepare("select id, owner_id as ownerId, token_id as tokenId, token_name as tokenName, kind, actor_name as actorName, at, detail from connection_events").all().map(row => ({ ...row })),
    [{ id: "device-deleted:t-deleted", ownerId: "workspace-a", tokenId: "t-deleted", tokenName: "On desk", kind: "revoked", actorName: "Member A", at: 50, detail: '{"reason":"device_deleted"}' }]);
});
