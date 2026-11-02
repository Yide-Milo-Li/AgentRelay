import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env, scheduled } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs") }, inProject: true };
const service = await loadTypeScriptModule("src/server/handoffs/notification-subscriptions.ts", options);
const events = await loadTypeScriptModule("src/server/handoffs/notification-events.ts", options);
const { createDevice } = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const { createHandoff, changeHandoff } = await loadTypeScriptModule("src/server/handoffs/index.ts", options);

const uuid = () => crypto.randomUUID();
const base64 = bytes => Buffer.from(bytes).toString("base64url");
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapid = { publicKey: base64(await crypto.subtle.exportKey("raw", vapidPair.publicKey)), privateKey: (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d, subject: "https://example.com" };
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const keys = { p256dh: base64(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth: base64(crypto.getRandomValues(new Uint8Array(16))) };
const actor = { owner: "workspace-a", userId: "viewer-a", name: "Synthetic viewer" };
const endpointOf = name => `https://fcm.googleapis.com/fcm/send/${name}`;

// Every push goes to this synthetic provider; no unit test reaches the network.
const push = { requests: [], status: 201, gate: null };
globalThis.fetch = async url => {
  push.requests.push(String(url));
  await push.gate;
  return new Response(null, { status: push.status });
};
const flush = async () => { while (scheduled.length) await Promise.all(scheduled.splice(0)); };
const sent = () => push.requests.map(url => url.slice(url.lastIndexOf("/") + 1)).sort();

let db;
async function fresh() {
  db = openDatabase(); db.exec("PRAGMA foreign_keys = ON"); env.DB = createD1(db);
  Object.assign(env, { AGENTRELAY_WEB_PUSH_ENABLED: "1", AGENTRELAY_VAPID_PUBLIC_KEY: vapid.publicKey, AGENTRELAY_VAPID_PRIVATE_KEY: vapid.privateKey, AGENTRELAY_VAPID_SUBJECT: vapid.subject });
  Object.assign(push, { requests: [], status: 201, gate: null }); scheduled.length = 0;
  for (const owner of [actor.owner, "workspace-b"]) {
    await createDevice(owner, { id: "laptop", name: "Laptop", line: "blue" });
    await createDevice(owner, { id: "desktop", name: "Desktop", line: "green" });
  }
}
/** Enable notifications for a fake browser; its endpoint name shows up in `sent()`. */
async function subscribe(name, deviceId = "laptop", extra = {}, owner = actor.owner) {
  const browserId = uuid();
  await service.saveNotificationSubscription(owner, { browserId, deviceId, locale: "en", subscription: { endpoint: endpointOf(name), keys }, ...extra });
  return browserId;
}
const send = (extra = {}, who = actor) => createHandoff(who, { title: "Synthetic title", content: "Private prompt", sourceDevice: "desktop", targetDevice: "laptop", requestKey: uuid(), ...extra });

test("a directed handoff reaches active subscriptions bound to its target device, and no others", async () => {
  await fresh();
  await subscribe("laptop-browser"); await subscribe("desktop-browser", "desktop"); await subscribe("foreign-browser", "laptop", {}, "workspace-b");
  const off = await subscribe("disabled-browser"); db.prepare("UPDATE notification_subscriptions SET disabled_at = 1 WHERE browser_id = ?").run(off);
  await send(); await flush();
  assert.deepEqual(sent(), ["laptop-browser"]);
});

test("a delivery is recorded on the subscription: accepted, refused and expired", async () => {
  await fresh(); const id = await subscribe("laptop-browser");
  await send(); await flush();
  let row = (await service.getNotificationSettings(actor.owner, id)).subscription;
  assert.ok(row.lastAcceptedAt); assert.equal(row.lastError, null); assert.equal(row.disabledAt, null);
  push.status = 400; await send(); await flush();
  row = (await service.getNotificationSettings(actor.owner, id)).subscription;
  assert.equal(row.lastError, "http-400"); assert.equal(row.disabledAt, null);
  push.status = 410; await send(); await flush();
  row = (await service.getNotificationSettings(actor.owner, id)).subscription;
  assert.ok(row.disabledAt); assert.equal(row.lastError, "subscription-expired");
  push.requests.length = 0; await send(); await flush();
  assert.deepEqual(push.requests, [], "a retired subscription receives nothing more");
});

test("a replayed request key never notifies again, on either creation path", async () => {
  await fresh(); await subscribe("laptop-browser");
  for (const extra of [{}, { project: "Synthetic project" }]) {
    push.requests.length = 0; const requestKey = uuid();
    const first = await send({ requestKey, ...extra }); await flush();
    const again = await send({ requestKey, ...extra }); await flush();
    assert.equal(again.id, first.id); assert.deepEqual(sent(), ["laptop-browser"], JSON.stringify(extra));
  }
});

test("only a successful return to ready notifies: claim, completion, stale versions and invalid moves stay quiet", async () => {
  await fresh(); await subscribe("laptop-browser");
  const created = await send(); await flush(); push.requests.length = 0;
  const claimed = await changeHandoff(actor.owner, created.id, { status: "claimed", version: created.version, device: "laptop" }); await flush();
  await assert.rejects(changeHandoff(actor.owner, created.id, { status: "ready", version: created.version }), error => error.status === 409); await flush();
  await assert.rejects(changeHandoff(actor.owner, created.id, { status: "claimed", version: claimed.version }), error => error.status === 409); await flush();
  assert.deepEqual(push.requests, []);
  const requeued = await changeHandoff(actor.owner, created.id, { status: "ready", version: claimed.version }); await flush();
  assert.deepEqual(sent(), ["laptop-browser"]);
  const claimedAgain = await changeHandoff(actor.owner, created.id, { status: "claimed", version: requeued.version, device: "laptop" });
  const done = await changeHandoff(actor.owner, created.id, { status: "done", version: claimedAgain.version }); await flush();
  assert.equal(push.requests.length, 1);
  await changeHandoff(actor.owner, created.id, { status: "ready", version: done.version }); await flush();
  assert.equal(push.requests.length, 2);
});

test("a browser can opt out of requeue notifications and keep the ones for new handoffs", async () => {
  await fresh(); await subscribe("laptop-browser", "laptop", { notifyRequeue: false });
  const created = await send(); await flush();
  assert.equal(push.requests.length, 1);
  const claimed = await changeHandoff(actor.owner, created.id, { status: "claimed", version: created.version, device: "laptop" });
  await changeHandoff(actor.owner, created.id, { status: "ready", version: claimed.version }); await flush();
  assert.equal(push.requests.length, 1);
});

test("Any-device handoffs notify only browsers that opted in, wherever they are bound", async () => {
  await fresh();
  await subscribe("quiet-browser"); await subscribe("optin-laptop", "laptop", { notifyAny: true }); await subscribe("optin-desktop", "desktop", { notifyAny: true });
  await subscribe("optin-foreign", "laptop", { notifyAny: true }, "workspace-b");
  await send({ targetDevice: "any" }); await flush();
  assert.deepEqual(sent(), ["optin-desktop", "optin-laptop"]);
  push.requests.length = 0;
  await send({ targetDevice: "Any device" }); await flush();
  assert.deepEqual(sent(), ["optin-desktop", "optin-laptop"]);
});

test("a handoff for a name that is not a registered device notifies nobody", async () => {
  await fresh(); await subscribe("laptop-browser", "laptop", { notifyAny: true });
  await send({ targetDevice: "Phone" }); await flush();
  assert.deepEqual(push.requests, []);
});

test("work that was waiting before notifications were enabled is never announced", async () => {
  await fresh(); await send(); await subscribe("laptop-browser"); await flush();
  assert.deepEqual(push.requests, []);
});

test("a failing push service never fails or delays the handoff", async () => {
  await fresh(); const id = await subscribe("laptop-browser");
  let release; push.gate = new Promise(resolve => { release = resolve; });
  const created = await send({ project: "Synthetic project" });
  assert.ok(created.id);
  // Delivery has been scheduled, yet the response above did not wait for it.
  for (let turn = 0; turn < 50 && !push.requests.length; turn++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(push.requests.length, 1);
  push.status = 503; release();
  // A 503 is retried with growing pauses before it is recorded; skip the pauses by only checking the stored handoff first.
  const stored = db.prepare("SELECT status FROM handoffs WHERE id = ?").get(created.id);
  assert.equal(stored.status, "ready");
  await flush();
  assert.equal((await service.getNotificationSettings(actor.owner, id)).subscription.lastError, "http-503");
});

test("a Site with notifications switched off neither queries subscriptions nor schedules work", async () => {
  await fresh(); await subscribe("laptop-browser"); env.AGENTRELAY_WEB_PUSH_ENABLED = "0";
  await send(); await flush();
  assert.deepEqual(push.requests, []); assert.equal(scheduled.length, 0);
});

test("at most twenty browsers are contacted for one event", async () => {
  await fresh();
  for (let index = 0; index < 25; index++) await subscribe(`browser-${String(index).padStart(2, "0")}`);
  await send(); await flush();
  assert.equal(push.requests.length, 20);
});

test("the event names the handoff and its version, and carries no task text", async () => {
  await fresh(); await subscribe("laptop-browser");
  const delivered = [];
  const created = await send({ title: "Secret title" });
  await flush();
  await events.notifyHandoffReady(actor.owner, created, "requeued", { schedule() {}, deliver: async (destination, event) => { delivered.push({ destination, event }); return { accepted: true, disabled: false, error: null }; } });
  assert.equal(delivered.length, 1); assert.equal(delivered[0].destination.endpoint, endpointOf("laptop-browser"));
  assert.deepEqual(delivered[0].event, { type: "agentrelay.handoff-ready", eventId: `${created.id}:${created.version}`, handoffId: created.id, version: created.version });
  assert.ok(!JSON.stringify(delivered[0].event).includes("Secret"));
});

// Progress: the browsers bound to the source device hear about the claim (when they ask for it) and the completion.
const claim = (row, device = "laptop") => changeHandoff(actor.owner, row.id, { status: "claimed", version: row.version, device });

test("progress reaches only the sender's device, by each browser's choice", async () => {
  await fresh();
  await subscribe("sender-done", "desktop"); await subscribe("sender-all", "desktop", { notifyProgress: "all" });
  await subscribe("sender-off", "desktop", { notifyProgress: "off" }); await subscribe("receiver", "laptop", { notifyProgress: "all" });
  await subscribe("foreign-sender", "desktop", { notifyProgress: "all" }, "workspace-b");
  const created = await send(); await flush();
  assert.deepEqual(sent(), ["receiver"], "a new handoff still reaches only its target");
  push.requests.length = 0;
  const claimed = await claim(created); await flush();
  assert.deepEqual(sent(), ["sender-all"]);
  push.requests.length = 0;
  const done = await changeHandoff(actor.owner, created.id, { status: "done", version: claimed.version, result: "Synthetic receipt" }); await flush();
  assert.deepEqual(sent(), ["sender-all", "sender-done"]);
  push.requests.length = 0;
  await changeHandoff(actor.owner, created.id, { status: "claimed", version: done.version }, { undo: true }); await flush();
  assert.deepEqual(push.requests, [], "an undo is never announced");
});

test("a stale or refused step announces nothing", async () => {
  await fresh(); await subscribe("sender-all", "desktop", { notifyProgress: "all" });
  const created = await send(); await flush(); push.requests.length = 0;
  await claim(created); await flush(); push.requests.length = 0;
  await assert.rejects(claim(created), error => error.status === 409);
  await assert.rejects(changeHandoff(actor.owner, created.id, { status: "done", version: created.version }), error => error.status === 409);
  await flush();
  assert.deepEqual(push.requests, []);
});

test("nobody hears about a handoff its own device claimed, or one sent from an unregistered device", async () => {
  await fresh(); await subscribe("sender-all", "desktop", { notifyProgress: "all" });
  const own = await send({ targetDevice: "any" }); await flush(); push.requests.length = 0;
  const claimedHere = await claim(own, "desktop");
  await changeHandoff(actor.owner, own.id, { status: "done", version: claimedHere.version }); await flush();
  assert.deepEqual(push.requests, [], "claimed and finished on the sending device");
  const stray = await send({ sourceDevice: "Phone" }); await flush(); push.requests.length = 0;
  const strayClaim = await claim(stray);
  await changeHandoff(actor.owner, stray.id, { status: "done", version: strayClaim.version }); await flush();
  assert.deepEqual(push.requests, [], "an unregistered sender has no browsers");
});

test("the progress event names the handoff, its version and the step, and carries no task text or receipt", async () => {
  await fresh(); await subscribe("sender-done", "desktop");
  const created = await send({ title: "Secret title" }); await flush();
  const claimed = await claim(created);
  const done = await changeHandoff(actor.owner, created.id, { status: "done", version: claimed.version, result: "Secret receipt" }); await flush();
  const delivered = [];
  await events.notifyHandoffProgress(actor.owner, done, "done", { schedule() {}, deliver: async (destination, event) => { delivered.push({ destination, event }); return { accepted: true, disabled: false, error: null }; } });
  assert.equal(delivered.length, 1); assert.equal(delivered[0].destination.endpoint, endpointOf("sender-done"));
  assert.deepEqual(delivered[0].event, { type: "agentrelay.handoff-progress", eventId: `${done.id}:${done.version}:progress`, handoffId: done.id, version: done.version, progress: "done" });
  assert.ok(!/Secret/.test(JSON.stringify(delivered[0].event)));
});

test("progress display data is for the sender's browsers only and honours hidden details", async () => {
  await fresh();
  const sender = await subscribe("sender-all", "desktop", { notifyProgress: "all" }), hidden = await subscribe("hidden", "desktop", { showDetails: false });
  const off = await subscribe("off", "desktop", { notifyProgress: "off" }), receiver = await subscribe("receiver", "laptop", { notifyProgress: "all" });
  const foreign = await subscribe("foreign", "desktop", { notifyProgress: "all" }, "workspace-b");
  const created = await send({ title: "Synthetic title", project: "Synthetic project" }); await flush();
  const missing = error => error.status === 404;
  await assert.rejects(service.getNotificationProgress(actor.owner, created.id, sender), missing, "a waiting handoff has no progress");
  const claimed = await claim(created);
  const done = await changeHandoff(actor.owner, created.id, { status: "done", version: claimed.version, result: "Secret receipt" });
  assert.deepEqual(await service.getNotificationProgress(actor.owner, created.id, sender),
    { id: created.id, version: done.version, status: "done", title: "Synthetic title", project: "Synthetic project", device: "Laptop" });
  assert.deepEqual(await service.getNotificationProgress(actor.owner, created.id, hidden), { id: created.id, version: done.version, status: "done", title: "", project: "", device: "" });
  await assert.rejects(service.getNotificationProgress(actor.owner, created.id, off), missing, "a browser that turned progress off");
  await assert.rejects(service.getNotificationProgress(actor.owner, created.id, receiver), missing, "a browser on the receiving device");
  await assert.rejects(service.getNotificationProgress("workspace-b", created.id, foreign), missing, "another workspace");
});

test("the progress preference is validated and defaults to completions", async () => {
  await fresh(); const browserId = await subscribe("sender", "desktop");
  assert.equal((await service.getNotificationSettings(actor.owner, browserId)).subscription.notifyProgress, "done");
  await assert.rejects(subscribe("bad", "desktop", { notifyProgress: "sometimes" }), error => error.status === 400);
  await assert.rejects(service.updateNotificationSubscription(actor.owner, { browserId, notifyProgress: true }), error => error.status === 400);
  assert.equal((await service.updateNotificationSubscription(actor.owner, { browserId, notifyProgress: "off" })).subscription.notifyProgress, "off");
});
