import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs") }, inProject: true };
const { dueReminderLead } = await loadTypeScriptModule("src/shared/formatting/connection-health.ts");
const tokens = await loadTypeScriptModule("src/server/agent-tokens/index.ts", options);
const { createDevice } = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const notifications = await loadTypeScriptModule("src/server/handoffs/notification-subscriptions.ts", options);
const reminders = await loadTypeScriptModule("src/server/connection-reminders/index.ts", options);

const HOUR = 3_600_000, DAY = 24 * HOUR;
const base64 = bytes => Buffer.from(bytes).toString("base64url");
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const keys = { p256dh: base64(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth: base64(crypto.getRandomValues(new Uint8Array(16))) };
Object.assign(env, { AGENTRELAY_WEB_PUSH_ENABLED: "1", AGENTRELAY_VAPID_PUBLIC_KEY: base64(await crypto.subtle.exportKey("raw", vapidPair.publicKey)),
  AGENTRELAY_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d, AGENTRELAY_VAPID_SUBJECT: "https://example.com" });

let db, workspaces = 0;
/** Each test gets its own workspace, because a sweep remembers per workspace when it last ran. */
async function fresh() {
  db?.close(); db = openDatabase(); db.exec("PRAGMA foreign_keys = ON"); env.DB = createD1(db);
  const actor = { owner: `workspace-${++workspaces}`, userId: "viewer", name: "Synthetic viewer" };
  await createDevice(actor.owner, { id: "laptop", name: "Laptop", line: "blue" });
  await createDevice(actor.owner, { id: "desktop", name: "Desktop", line: "green" });
  return actor;
}
const issue = (actor, extra = {}) => tokens.createAgentToken(actor, { name: "Synthetic connection", ...extra });
const leads = list => list.map(reminder => reminder.lead);
/** Enable notifications for a fake browser; its endpoint name identifies it in what was sent. */
async function subscribe(actor, name, deviceId = "laptop", extra = {}) {
  const browserId = crypto.randomUUID();
  await notifications.saveNotificationSubscription(actor.owner, { browserId, deviceId, locale: "en", subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys }, ...extra });
  return browserId;
}
/** Run one sweep at `now` and report which browsers were sent which events; nothing reaches the network. */
async function sweep(actor, now) {
  const sent = [];
  const deliver = async (row, event) => { sent.push({ to: row.endpoint.slice(row.endpoint.lastIndexOf("/") + 1), event }); return { accepted: true, disabled: false, error: null }; };
  await reminders.remindExpiringConnections(actor.owner, { now: () => now, schedule: () => {}, deliver });
  return sent.sort((a, b) => a.to.localeCompare(b.to));
}

test("the due reminder is the shortest lead that the time left fits inside", () => {
  const expiresAt = 100 * DAY;
  assert.equal(dueReminderLead(expiresAt, expiresAt - 8 * DAY), null);
  assert.equal(dueReminderLead(expiresAt, expiresAt - 7 * DAY), 7 * DAY);
  assert.equal(dueReminderLead(expiresAt, expiresAt - 4 * DAY), 7 * DAY);
  assert.equal(dueReminderLead(expiresAt, expiresAt - 3 * DAY), 3 * DAY);
  assert.equal(dueReminderLead(expiresAt, expiresAt - 2 * HOUR), DAY);
  assert.equal(dueReminderLead(expiresAt, expiresAt - HOUR), HOUR);
  assert.equal(dueReminderLead(expiresAt, expiresAt - 1), HOUR);
  assert.equal(dueReminderLead(expiresAt, expiresAt), null, "an expired connection gets no reminder");
});

test("each reminder of a long lifetime is claimed once, and a skipped one is never sent late", async () => {
  const actor = await fresh(), { id, expiresAt } = await issue(actor);
  assert.deepEqual(await tokens.claimExpiryReminders(actor.owner, Date.now()), []);
  assert.deepEqual(leads(await tokens.claimExpiryReminders(actor.owner, expiresAt - 7 * DAY + 1)), [7 * DAY]);
  assert.deepEqual(await tokens.claimExpiryReminders(actor.owner, expiresAt - 6 * DAY), [], "the same reminder is never claimed twice");
  const [threeDays] = await tokens.claimExpiryReminders(actor.owner, expiresAt - 3 * DAY);
  assert.deepEqual(threeDays, { id, name: "Synthetic connection", deviceId: null, expiresAt, lead: 3 * DAY });
  // A quiet day and a half: the 1-day reminder's moment passed unseen, so only the 1-hour one goes out.
  assert.deepEqual(leads(await tokens.claimExpiryReminders(actor.owner, expiresAt - 30 * 60_000)), [HOUR]);
  assert.deepEqual(await tokens.claimExpiryReminders(actor.owner, expiresAt - 60_000), []);
  assert.deepEqual(await tokens.claimExpiryReminders(actor.owner, expiresAt + 1), [], "an expired connection is never reminded");
});

test("a short lifetime skips the reminders it starts inside", async () => {
  const actor = await fresh(), week = await issue(actor, { expiresInDays: 7 }), day = await issue(actor, { expiresInDays: 1 });
  assert.deepEqual(await tokens.claimExpiryReminders(actor.owner, Date.now() + 1000), []);
  const at = (connection, now) => tokens.claimExpiryReminders(actor.owner, now).then(list => list.filter(item => item.id === connection.id).map(item => item.lead));
  assert.deepEqual(await at(day, day.expiresAt - 2 * HOUR), [], "a 1-day connection is never told it has a day left");
  assert.deepEqual(await at(day, day.expiresAt - HOUR), [HOUR]);
  assert.deepEqual(await at(week, week.expiresAt - 3 * DAY), [3 * DAY]);
});

test("permanent and revoked connections are never reminded; renewing starts the reminders again", async () => {
  const actor = await fresh();
  await issue(actor, { expiresInDays: null, acknowledgePermanentRisk: true });
  const revoked = await issue(actor, { expiresInDays: 2 }); await tokens.revokeAgentToken(actor.owner, revoked.id);
  const renewed = await issue(actor, { expiresInDays: 30 });
  assert.deepEqual(leads(await tokens.claimExpiryReminders(actor.owner, renewed.expiresAt - 2 * DAY)), [3 * DAY]);
  const again = await tokens.updateAgentToken(actor.owner, renewed.id, { expiresInDays: 30 });
  assert.notEqual(again.expiresAt, renewed.expiresAt);
  assert.equal(again.version, renewed.version + 1, "claiming a reminder never bumps the version a person edits against");
  assert.deepEqual(leads(await tokens.claimExpiryReminders(actor.owner, again.expiresAt - 7 * DAY)), [7 * DAY]);
});

test("concurrent sweeps claim a reminder once", async () => {
  const actor = await fresh(), { expiresAt } = await issue(actor);
  const results = await Promise.all(Array.from({ length: 5 }, () => tokens.claimExpiryReminders(actor.owner, expiresAt - 7 * DAY)));
  assert.equal(results.flat().length, 1);
});

test("a reminder reaches the browsers that follow the connection, by scope, and names no task content", async () => {
  const actor = await fresh();
  await subscribe(actor, "laptop-device"); await subscribe(actor, "desktop-device", "desktop");
  await subscribe(actor, "desktop-all", "desktop", { notifyExpiry: "all" }); await subscribe(actor, "laptop-off", "laptop", { notifyExpiry: "off" });
  const bound = await issue(actor, { deviceId: "laptop" });
  let sent = await sweep(actor, bound.expiresAt - 7 * DAY);
  assert.deepEqual(sent.map(item => item.to), ["desktop-all", "laptop-device"]);
  assert.deepEqual(sent[0].event, { type: "agentrelay.connection-expiring", eventId: `${bound.id}:${bound.expiresAt}:${7 * DAY}`, connectionId: bound.id, expiresAt: bound.expiresAt });
  await tokens.revokeAgentToken(actor.owner, bound.id);
  const unbound = await issue(actor);
  sent = await sweep(actor, unbound.expiresAt - 7 * DAY + 60_000);
  assert.deepEqual(sent.map(item => item.to), ["desktop-all", "desktop-device", "laptop-device"], "a connection bound to no device reaches every following browser");
});

test("a sweep runs at most once a minute per workspace, and uses nothing up while no browser wants reminders", async () => {
  const actor = await fresh(), { id, expiresAt } = await issue(actor);
  assert.deepEqual(await sweep(actor, expiresAt - 7 * DAY), []);
  assert.equal(db.prepare("select expiry_reminded_lead as lead from agent_tokens where id = ?").get(id).lead, null);
  await subscribe(actor, "laptop-device");
  assert.deepEqual(await sweep(actor, expiresAt - 7 * DAY + 30_000), [], "within a minute of the last sweep");
  assert.equal((await sweep(actor, expiresAt - 7 * DAY + 60_000)).length, 1);
});

test("a reminder's display data answers only for a connection this browser follows", async () => {
  const actor = await fresh();
  const laptop = await subscribe(actor, "laptop-device"), desktop = await subscribe(actor, "desktop-device", "desktop");
  const hidden = await subscribe(actor, "hidden", "laptop", { showDetails: false }), off = await subscribe(actor, "off", "laptop", { notifyExpiry: "off" });
  const connection = await issue(actor, { deviceId: "laptop", name: "Laptop agent" });
  assert.deepEqual(await reminders.getNotificationConnection(actor.owner, connection.id, laptop), { id: connection.id, name: "Laptop agent", expiresAt: connection.expiresAt });
  assert.equal((await reminders.getNotificationConnection(actor.owner, connection.id, hidden)).name, "", "hidden details hide the name");
  for (const browserId of [desktop, off, crypto.randomUUID()])
    await assert.rejects(reminders.getNotificationConnection(actor.owner, connection.id, browserId), error => error.status === 404);
  await assert.rejects(reminders.getNotificationConnection("workspace-other", connection.id, laptop), error => error.status === 404);
  await tokens.revokeAgentToken(actor.owner, connection.id);
  await assert.rejects(reminders.getNotificationConnection(actor.owner, connection.id, laptop), error => error.status === 404);
});

test("the reminder scope is validated and can be changed later", async () => {
  const actor = await fresh(), browserId = await subscribe(actor, "laptop-device");
  assert.equal((await notifications.getNotificationSettings(actor.owner, browserId)).subscription.notifyExpiry, "device");
  await assert.rejects(subscribe(actor, "bad", "laptop", { notifyExpiry: "sometimes" }), error => error.status === 400);
  await assert.rejects(notifications.updateNotificationSubscription(actor.owner, { browserId, notifyExpiry: true }), error => error.status === 400);
  const updated = await notifications.updateNotificationSubscription(actor.owner, { browserId, notifyExpiry: "all" });
  assert.equal(updated.subscription.notifyExpiry, "all");
});
