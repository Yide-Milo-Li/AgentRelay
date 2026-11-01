import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const stubs = { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs") };
const options = { stubs, inProject: true };
const validation = await loadTypeScriptModule("src/server/handoffs/notification-validation.ts", options);
const { deliverNotification } = await loadTypeScriptModule("src/server/handoffs/notification-delivery.ts", options);
const service = await loadTypeScriptModule("src/server/handoffs/notification-subscriptions.ts", options);
const { createDevice, deleteDevice } = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const { createHandoff } = await loadTypeScriptModule("src/server/handoffs/index.ts", options);
const uuid = () => crypto.randomUUID();
const base64 = bytes => Buffer.from(bytes).toString("base64url");
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
const vapid = { publicKey: base64(await crypto.subtle.exportKey("raw", vapidPair.publicKey)), privateKey: vapidPrivate.d, subject: "https://example.com" };
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-subscription", keys: {
  p256dh: base64(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth: base64(crypto.getRandomValues(new Uint8Array(16))),
} };
const destination = { endpoint: subscription.endpoint, ...subscription.keys };
const actor = { owner: "workspace-a", userId: "viewer-a", name: "Synthetic viewer" };
let db;
async function fresh() {
  db = openDatabase(); db.exec("PRAGMA foreign_keys = ON"); env.DB = createD1(db);
  env.AGENTRELAY_WEB_PUSH_ENABLED = "1";
  env.AGENTRELAY_VAPID_PUBLIC_KEY = vapid.publicKey;
  env.AGENTRELAY_VAPID_PRIVATE_KEY = vapid.privateKey;
  env.AGENTRELAY_VAPID_SUBJECT = vapid.subject;
  await createDevice(actor.owner, { id: "laptop", name: "Laptop", line: "blue" });
}
const input = (browserId = uuid(), extra = {}) => ({ browserId, deviceId: "laptop", locale: "en", subscription, ...extra });

test("push destinations reject arbitrary hosts, credentials, ports, query strings and redirects by construction", () => {
  for (const endpoint of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://localhost/x", "https://127.0.0.1/x",
    "https://user:secret@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com/x?secret=1", "https://fcm.googleapis.com/x#fragment"])
    assert.throws(() => validation.pushEndpointOf(endpoint), error => error.status === 400);
  assert.equal(validation.pushEndpointOf(subscription.endpoint), subscription.endpoint);
});

const wns = "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bsynthetic-token_123";
test("Edge's Windows push service is accepted only in its exact shape", () => {
  assert.equal(validation.pushEndpointOf(wns), wns);
  assert.equal(validation.pushEndpointOf("https://db5p.notify.windows.com/w/?token=abc"), "https://db5p.notify.windows.com/w/?token=abc");
  for (const endpoint of [
    "http://wns2-par02p.notify.windows.com/w/?token=abc", "https://notify.windows.com/w/?token=abc", "https://a.b.notify.windows.com/w/?token=abc",
    "https://wns2-par02p.notify.windows.com.evil.example/w/?token=abc", "https://evilnotify.windows.com/w/?token=abc", "https://wns2.notify.windows.com@evil.example/w/?token=abc",
    "https://user:secret@wns2-par02p.notify.windows.com/w/?token=abc", "https://wns2-par02p.notify.windows.com:8443/w/?token=abc",
    "https://wns2-par02p.notify.windows.com/w/", "https://wns2-par02p.notify.windows.com/w/?token=", "https://wns2-par02p.notify.windows.com/w/?other=abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc&extra=1", "https://wns2-par02p.notify.windows.com/w/?token=abc&token=def",
    "https://wns2-par02p.notify.windows.com/w/?token=abc#fragment", "https://wns2-par02p.notify.windows.com/x/?token=abc", "https://wns2-par02p.notify.windows.com/?token=abc",
    "https://wns2-par02p.notify.windows.com/w/%2e%2e/?token=abc"])
    assert.throws(() => validation.pushEndpointOf(endpoint), error => error.status === 400, endpoint);
});

test("Mozilla and Apple push services stay rejected, and the refusal names the supported browsers", () => {
  for (const endpoint of ["https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc"])
    assert.throws(() => validation.pushEndpointOf(endpoint), error => error.status === 400 && /Chrome and Edge/.test(error.message), endpoint);
});

test("an Edge subscription can be saved and its token never appears in the returned settings", async () => {
  await fresh(); const id = uuid();
  const saved = await service.saveNotificationSubscription(actor.owner, input(id, { subscription: { ...subscription, endpoint: wns } }));
  assert.ok(saved.subscription); assert.ok(!JSON.stringify(saved).includes("synthetic-token"));
});

test("settings reject malformed keys, identities and client-supplied ownership", () => {
  assert.throws(() => validation.notificationInput(input(uuid(), { ownerId: "another-workspace" })), /Unknown/);
  assert.throws(() => validation.notificationInput(input("not-a-uuid")), /browser notification ID/);
  assert.throws(() => validation.subscriptionOf({ ...subscription, keys: { ...subscription.keys, auth: "bad" } }), /push key/);
  assert.throws(() => validation.subscriptionOf({ ...subscription, keys: { ...subscription.keys, p256dh: base64(new Uint8Array(65)) } }), /push key/);
});

test("subscription reads and mutations remain owner-scoped and never return delivery credentials", async () => {
  await fresh(); const id = uuid();
  const saved = await service.saveNotificationSubscription(actor.owner, input(id));
  assert.equal(saved.subscription.deviceId, "laptop");
  assert.equal(saved.subscription.version, 1);
  for (const secret of ["endpoint", "endpointHash", "auth", "p256dh", "ownerId"]) assert.ok(!(secret in saved.subscription));
  assert.equal((await service.getNotificationSettings("workspace-b", id)).subscription, null);
  await service.deleteNotificationSubscription("workspace-b", id);
  assert.ok((await service.getNotificationSettings(actor.owner, id)).subscription);
  await service.deleteNotificationSubscription(actor.owner, id);
  assert.equal((await service.getNotificationSettings(actor.owner, id)).subscription, null);
});

test("subscriptions bind only registered devices and follow explicit updates rather than device renames", async () => {
  await fresh(); const id = uuid();
  await assert.rejects(service.saveNotificationSubscription(actor.owner, input(id, { deviceId: "missing" })), error => error.status === 404);
  await service.saveNotificationSubscription(actor.owner, input(id));
  await createDevice(actor.owner, { id: "desktop", name: "Desktop", line: "green" });
  const updated = await service.saveNotificationSubscription(actor.owner, input(id, { deviceId: "desktop", locale: "zh" }));
  assert.equal(updated.subscription.version, 2); assert.equal(updated.subscription.deviceId, "desktop");
  assert.equal(updated.subscription.locale, "zh");
});

test("device deletion cascades subscription removal atomically and recreation cannot inherit it", async () => {
  await fresh(); const id = uuid(); await service.saveNotificationSubscription(actor.owner, input(id));
  await assert.rejects(deleteDevice(actor.owner, "laptop", { version: 99, connections: "unbind" }), error => error.status === 409);
  assert.ok((await service.getNotificationSettings(actor.owner, id)).subscription);
  await deleteDevice(actor.owner, "laptop", { version: 1, connections: "unbind" });
  await createDevice(actor.owner, { id: "laptop", name: "Laptop again", line: "blue" });
  assert.equal((await service.getNotificationSettings(actor.owner, id)).subscription, null);
});

test("notification metadata omits prompt text and images, and checks current target, state, expiry and workspace", async () => {
  await fresh(); const id = uuid(); await service.saveNotificationSubscription(actor.owner, input(id));
  const handoff = await createHandoff(actor, { title: "Synthetic title", content: "Private prompt must never be returned", project: "Synthetic project",
    targetDevice: "laptop", sourceDevice: "desktop", requestKey: uuid() });
  const metadata = await service.getNotificationHandoff(actor.owner, handoff.id, id);
  assert.deepEqual(Object.keys(metadata).sort(), ["id", "project", "title", "version"]);
  assert.equal(metadata.title, handoff.title);
  for (const foreignId of [handoff.id, uuid()]) await assert.rejects(service.getNotificationHandoff("workspace-b", foreignId, id), error => error.status === 404);
  db.prepare("UPDATE handoffs SET status = 'claimed' WHERE id = ?").run(handoff.id);
  await assert.rejects(service.getNotificationHandoff(actor.owner, handoff.id, id), error => error.status === 404);
  db.prepare("UPDATE handoffs SET status = 'ready', expires_at = 1 WHERE id = ?").run(handoff.id);
  await assert.rejects(service.getNotificationHandoff(actor.owner, handoff.id, id), error => error.status === 404);
});

test("missing VAPID configuration leaves notification registration disabled", async () => {
  await fresh(); delete env.AGENTRELAY_WEB_PUSH_ENABLED;
  const settings = await service.getNotificationSettings(actor.owner, uuid());
  assert.equal(settings.available, false); assert.equal(settings.publicKey, null);
  await assert.rejects(service.saveNotificationSubscription(actor.owner, input()), error => error.status === 503);
});

test("a browser that lost its site storage re-enables without colliding with its own earlier subscription", async () => {
  await fresh(); const before = uuid(), after = uuid();
  await service.saveNotificationSubscription(actor.owner, input(before));
  const saved = await service.saveNotificationSubscription(actor.owner, input(after, { locale: "zh" }));
  assert.equal(saved.subscription.browserId, after); assert.equal(saved.subscription.version, 1); assert.equal(saved.subscription.locale, "zh");
  assert.equal((await service.getNotificationSettings(actor.owner, before)).subscription, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM notification_subscriptions WHERE owner_id = ?").get(actor.owner).n, 1);
});

test("replacing a subscription by endpoint never touches another workspace or another endpoint", async () => {
  await fresh(); const mine = uuid(), other = uuid(), foreign = uuid();
  const second = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/second-browser" };
  await service.saveNotificationSubscription(actor.owner, input(mine));
  await service.saveNotificationSubscription(actor.owner, input(other, { subscription: second }));
  await createDevice("workspace-b", { id: "laptop", name: "Laptop", line: "blue" });
  await service.saveNotificationSubscription("workspace-b", input(foreign));
  await service.saveNotificationSubscription(actor.owner, input(uuid()));
  assert.equal((await service.getNotificationSettings(actor.owner, mine)).subscription, null);
  assert.ok((await service.getNotificationSettings(actor.owner, other)).subscription);
  assert.ok((await service.getNotificationSettings("workspace-b", foreign)).subscription);
});

test("a test notification always asks for a system notification, while a handoff event does not", () => {
  const test = service.buildNotificationEvent(null, "event-1");
  assert.deepEqual(test, { type: "agentrelay.test", eventId: "event-1", system: true });
  const handoff = service.buildNotificationEvent({ id: uuid(), title: "t", project: "p", version: 3 });
  assert.equal(handoff.type, "agentrelay.handoff-ready"); assert.equal(handoff.eventId, `${handoff.handoffId}:3`);
  assert.equal(handoff.version, 3); assert.ok(!("system" in handoff));
});

const event = { type: "agentrelay.test", eventId: uuid() };
test("real Web Crypto builds encrypted payloads with VAPID and never follows redirects", async () => {
  let calls = 0;
  const result = await deliverNotification(destination, event, vapid, { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, subscription.endpoint); assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-encoding"), "aes128gcm"); assert.equal(headers.get("ttl"), "86400");
    assert.match(headers.get("authorization"), /^vapid /);
    assert.equal(new Uint8Array(init.body).byteLength, 4096);
    assert.ok(!new TextDecoder().decode(init.body).includes(event.eventId));
    return new Response(null, { status: 201 });
  } });
  assert.equal(calls, 1); assert.deepEqual(result, { accepted: true, disabled: false, error: null });
});

test("temporary push errors retry at most three times within the overall budget", async () => {
  let calls = 0, clock = 0;
  const result = await deliverNotification(destination, event, vapid, { now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async () => { calls++; return new Response("private provider diagnostic", { status: 503 }); } });
  assert.equal(calls, 3); assert.ok(clock < 20_000); assert.equal(result.error, "http-503");
  assert.ok(!JSON.stringify(result).includes("private provider"));
});

test("Retry-After beyond the remaining budget stops instead of extending request lifetime", async () => {
  let calls = 0;
  const result = await deliverNotification(destination, event, vapid, { now: () => 0, sleep: async () => assert.fail("must not wait beyond budget"),
    fetchImpl: async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "120" } }); } });
  assert.equal(calls, 1); assert.equal(result.error, "http-429");
});

test("expired subscriptions stop immediately; permanent refusals do not retry", async () => {
  for (const status of [404, 410, 400, 401, 403, 302]) {
    let calls = 0;
    const result = await deliverNotification(destination, event, vapid, { fetchImpl: async () => { calls++; return new Response(null, { status }); } });
    assert.equal(calls, 1); assert.equal(result.disabled, status === 404 || status === 410);
    assert.equal(result.accepted, false);
  }
});

test("configuration errors cannot contact arbitrary destinations or expose key material", async () => {
  const result = await deliverNotification({ ...destination, endpoint: "https://localhost/secret" }, event, vapid, {
    fetchImpl: async () => assert.fail("untrusted endpoint must never be fetched"),
  });
  assert.deepEqual(result, { accepted: false, disabled: false, error: "configuration" });
});
