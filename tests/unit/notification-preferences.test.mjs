import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs") }, inProject: true };
const validation = await loadTypeScriptModule("src/server/handoffs/notification-validation.ts", options);
const service = await loadTypeScriptModule("src/server/handoffs/notification-subscriptions.ts", options);
const { createDevice } = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const { createHandoff } = await loadTypeScriptModule("src/server/handoffs/index.ts", options);

const uuid = () => crypto.randomUUID();
const base64 = bytes => Buffer.from(bytes).toString("base64url");
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-subscription", keys: {
  p256dh: base64(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth: base64(crypto.getRandomValues(new Uint8Array(16))) } };
const actor = { owner: "workspace-a", userId: "viewer-a", name: "Synthetic viewer" };
globalThis.fetch = async () => new Response(null, { status: 201 });

let db;
async function fresh() {
  db = openDatabase(); db.exec("PRAGMA foreign_keys = ON"); env.DB = createD1(db);
  Object.assign(env, { AGENTRELAY_WEB_PUSH_ENABLED: "1", AGENTRELAY_VAPID_PUBLIC_KEY: base64(await crypto.subtle.exportKey("raw", vapidPair.publicKey)),
    AGENTRELAY_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d, AGENTRELAY_VAPID_SUBJECT: "https://example.com" });
  await createDevice(actor.owner, { id: "laptop", name: "Laptop", line: "blue" });
}
const input = (browserId = uuid(), extra = {}) => ({ browserId, deviceId: "laptop", locale: "en", subscription, ...extra });
const handoff = (extra = {}) => createHandoff(actor, { title: "Synthetic title", content: "Private prompt", project: "Synthetic project", sourceDevice: "desktop", targetDevice: "laptop", requestKey: uuid(), ...extra });

test("preferences default to requeues on, Any device off, details shown and no label", async () => {
  await fresh();
  const saved = (await service.saveNotificationSubscription(actor.owner, input())).subscription;
  assert.deepEqual([saved.notifyRequeue, saved.notifyAny, saved.showDetails, saved.label], [true, false, true, null]);
});

test("preferences are stored when given and kept when a later registration omits them", async () => {
  await fresh(); const id = uuid();
  const set = { notifyRequeue: false, notifyAny: true, showDetails: false, label: "Chrome on Windows" };
  const saved = (await service.saveNotificationSubscription(actor.owner, input(id, set), actor)).subscription;
  assert.deepEqual([saved.notifyRequeue, saved.notifyAny, saved.showDetails, saved.label], [false, true, false, "Chrome on Windows"]);
  const again = (await service.saveNotificationSubscription(actor.owner, input(id, { locale: "zh" }), actor)).subscription;
  assert.deepEqual([again.notifyRequeue, again.notifyAny, again.showDetails, again.label], [false, true, false, "Chrome on Windows"]);
  assert.equal(again.locale, "zh");
});

test("the member who enabled a browser is recorded by name and never returned by id", async () => {
  await fresh(); const id = uuid();
  const saved = await service.saveNotificationSubscription(actor.owner, input(id), actor);
  const row = db.prepare("SELECT created_by_user_id AS id, created_by_name AS name FROM notification_subscriptions WHERE browser_id = ?").get(id);
  assert.deepEqual({ ...row }, { id: "viewer-a", name: "Synthetic viewer" });
  assert.ok(!JSON.stringify(saved).includes("viewer-a"));
});

test("preference values are validated strictly", () => {
  for (const bad of [{ notifyAny: "yes" }, { notifyRequeue: 1 }, { showDetails: null }, { label: "" }, { label: "   " }, { label: "x".repeat(41) },
    { label: "bell\u0007" }, { label: "line\nbreak" }, { label: 5 }])
    assert.throws(() => validation.notificationInput(input(uuid(), bad)), error => error.status === 400, JSON.stringify(bad));
  const ok = validation.notificationInput(input(uuid(), { label: "Edge on macOS", notifyAny: true }));
  assert.equal(ok.label, "Edge on macOS"); assert.equal(ok.notifyAny, true); assert.ok(!("notifyRequeue" in ok));
  assert.ok(!("label" in validation.notificationInput(input())));
});

test("metadata hides the title and project when details are off, without changing who may read it", async () => {
  await fresh(); const id = uuid();
  await service.saveNotificationSubscription(actor.owner, input(id, { showDetails: false }));
  const created = await handoff();
  assert.deepEqual({ ...(await service.getNotificationHandoff(actor.owner, created.id, id)) }, { id: created.id, title: "", project: "", version: 1 });
  await service.saveNotificationSubscription(actor.owner, input(id, { showDetails: true }));
  const shown = await service.getNotificationHandoff(actor.owner, created.id, id);
  assert.equal(shown.title, "Synthetic title"); assert.equal(shown.project, "Synthetic project");
});

test("metadata for an Any-device handoff is readable only with the opt-in", async () => {
  await fresh(); const id = uuid();
  await service.saveNotificationSubscription(actor.owner, input(id));
  const created = await handoff({ targetDevice: "any" });
  await assert.rejects(service.getNotificationHandoff(actor.owner, created.id, id), error => error.status === 404);
  await service.saveNotificationSubscription(actor.owner, input(id, { notifyAny: true }));
  assert.equal((await service.getNotificationHandoff(actor.owner, created.id, id)).id, created.id);
  const elsewhere = await handoff({ targetDevice: "Phone" });
  await assert.rejects(service.getNotificationHandoff(actor.owner, elsewhere.id, id), error => error.status === 404);
});

test("an update changes only the options it names, keeps the subscription and bumps its version", async () => {
  await fresh(); const id = uuid();
  await createDevice(actor.owner, { id: "desktop", name: "Desktop", line: "green" });
  await service.saveNotificationSubscription(actor.owner, input(id, { label: "Chrome on Windows" }));
  const first = await service.updateNotificationSubscription(actor.owner, { browserId: id, notifyAny: true, locale: "zh" });
  assert.deepEqual([first.subscription.notifyAny, first.subscription.locale, first.subscription.notifyRequeue, first.subscription.label, first.subscription.deviceId], [true, "zh", true, "Chrome on Windows", "laptop"]);
  assert.equal(first.subscription.version, 2);
  const moved = await service.updateNotificationSubscription(actor.owner, { browserId: id, deviceId: "desktop", label: null });
  assert.deepEqual([moved.subscription.deviceId, moved.subscription.label, moved.subscription.notifyAny], ["desktop", null, true]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM notification_subscriptions").get().n, 1);
});

test("an update needs an existing subscription of the same workspace and a registered device", async () => {
  await fresh(); const id = uuid();
  await assert.rejects(service.updateNotificationSubscription(actor.owner, { browserId: id, notifyAny: true }), error => error.status === 404);
  await service.saveNotificationSubscription(actor.owner, input(id));
  await assert.rejects(service.updateNotificationSubscription("workspace-b", { browserId: id, notifyAny: true }), error => error.status === 404);
  await assert.rejects(service.updateNotificationSubscription(actor.owner, { browserId: id, deviceId: "missing" }), error => error.status === 404);
  assert.equal((await service.getNotificationSettings(actor.owner, id)).subscription.version, 1);
});

test("update input is validated strictly and cannot carry a subscription or an owner", () => {
  const ok = validation.notificationPatch({ browserId: uuid(), notifyRequeue: false, label: null });
  assert.deepEqual({ ...ok.changes }, { notifyRequeue: false, label: null });
  for (const bad of [{}, { notifyAny: "yes" }, { locale: "fr" }, { deviceId: "" }, { deviceId: "x".repeat(33) }, { label: "" }, { label: "bell\u0007" },
    { subscription }, { ownerId: "workspace-b" }, { endpoint: "https://fcm.googleapis.com/x" }])
    assert.throws(() => validation.notificationPatch({ browserId: uuid(), ...bad }), error => error.status === 400, JSON.stringify(bad));
  assert.throws(() => validation.notificationPatch({ notifyAny: true }), error => error.status === 400);
});

test("the settings list the workspace's other browsers by label, device and member name, and never expose credentials or ids", async () => {
  await fresh(); const mine = uuid(), laptop = uuid(), phone = uuid(), foreign = uuid();
  const at = (endpoint, deviceId = "laptop") => ({ deviceId, subscription: { ...subscription, endpoint: `https://fcm.googleapis.com/fcm/send/${endpoint}` } });
  await createDevice("workspace-b", { id: "laptop", name: "Laptop", line: "blue" });
  await service.saveNotificationSubscription(actor.owner, input(mine, at("mine")), actor);
  await service.saveNotificationSubscription(actor.owner, input(laptop, { ...at("other-a"), label: "Edge on Windows" }), { userId: "viewer-b", name: "Second member" });
  await service.saveNotificationSubscription(actor.owner, input(phone, at("other-b")));
  await service.saveNotificationSubscription("workspace-b", input(foreign, at("foreign")), actor);
  db.prepare("UPDATE notification_subscriptions SET last_accepted_at = 50, last_error = 'http-400' WHERE browser_id = ?").run(laptop);
  const settings = await service.getNotificationSettings(actor.owner, mine);
  assert.deepEqual(settings.others.map(item => item.browserId), [laptop, phone], "the most recently delivered first, never-delivered last, and not this browser");
  assert.deepEqual({ ...settings.others[0] }, { browserId: laptop, deviceId: "laptop", label: "Edge on Windows", enabledBy: "Second member", lastAcceptedAt: 50, lastError: "http-400", disabledAt: null });
  assert.equal(settings.others[1].enabledBy, null); assert.equal(settings.others[1].label, null);
  assert.ok(!JSON.stringify(settings.others).match(/viewer-|endpoint|p256dh|auth|fcm\.googleapis|hash/i));
  assert.ok(!settings.others.some(item => item.browserId === foreign));
});

test("the list of other browsers is limited, and empty for a workspace with only this browser", async () => {
  await fresh(); const mine = uuid(); await service.saveNotificationSubscription(actor.owner, input(mine));
  assert.deepEqual((await service.getNotificationSettings(actor.owner, mine)).others, []);
  const insert = db.prepare("INSERT INTO notification_subscriptions (owner_id, browser_id, device_id, endpoint, endpoint_hash, p256dh, auth, locale, created_at, updated_at) VALUES (?, ?, 'laptop', ?, ?, 'p', 'a', 'en', ?, ?)");
  for (let index = 0; index < 60; index++) insert.run(actor.owner, uuid(), `https://fcm.googleapis.com/fcm/send/bulk-${index}`, `bulk-${index}`, index, index);
  assert.equal((await service.getNotificationSettings(actor.owner, mine)).others.length, 50);
});
