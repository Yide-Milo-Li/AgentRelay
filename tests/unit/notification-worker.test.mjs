// Exercise the actual deployed script with synthetic browser APIs; real Chrome delivery remains a separate acceptance gate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const source = readFileSync(path.join(projectRoot, "public/sw.js"), "utf8");
const origin = "https://example.chatgpt.site", browserId = crypto.randomUUID(), handoffId = crypto.randomUUID(), connectionId = crypto.randomUUID();
function browser({ brokenStorage = false, foreground = false, closed = false, acknowledge = true, opens = true, authorized = true, gone = false, redirect = false, handoff = false, connection = false, progress = false, storage } = {}) {
  const handlers = new Map(), notifications = [], shown = [], messages = [], navigations = [], requests = [], focused = [], state = { version: 1 };
  const records = storage ?? new Map([["configuration", { browserId, locale: "en" }]]);
  const db = { createObjectStore() {}, close() {}, transaction() {
    const transaction = { objectStore: () => ({
      get: key => { const request = { result: records.get(key) }; queueMicrotask(() => transaction.oncomplete?.()); return request; },
      put: (value, key) => { records.set(key, value); const request = { result: key }; queueMicrotask(() => transaction.oncomplete?.()); return request; },
    }) }; return transaction;
  } };
  const client = { url: `${origin}/`, visibilityState: foreground ? "visible" : "hidden", focused: foreground,
    // A page answers on the channel it is given; an older page that predates a message type never answers it.
    postMessage: (data, ports) => {
      messages.push(data);
      const answer = data.type === "agentrelay.open-handoff" || data.type === "agentrelay.open-connections" ? opens && { handled: true } : acknowledge && { displayed: true };
      if (answer) ports[0].postMessage(answer);
    },
    focus: async () => { focused.push(true); return client; },
    navigate: async value => { navigations.push(value); return { focus: async () => { focused.push(true); } }; },
  };
  const self = { location: { origin }, addEventListener: (type, handler) => handlers.set(type, handler), skipWaiting: async () => {},
    registration: {
      showNotification: async (title, options) => { notifications.push({ title, ...options }); shown.push({ tag: options.tag, closed: false, close() { this.closed = true; } }); },
      getNotifications: async () => shown.filter(item => !item.closed),
    },
    clients: { claim: async () => {}, matchAll: async () => closed ? [] : [client], openWindow: async url => navigations.push(url) },
  };
  const context = vm.createContext({ self, URL, AbortSignal, MessageChannel, setTimeout, clearTimeout,
    indexedDB: { open: () => { const request = { result: db }; queueMicrotask(() => brokenStorage ? request.onerror() : request.onsuccess()); return request; } },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (redirect) throw new TypeError("Failed to fetch");
      if (!authorized) return new Response("Sign in", { status: 401 });
      if (gone) return Response.json({ error: "This notification no longer has a waiting handoff." }, { status: 404 });
      if (connection) return Response.json({ id: connectionId, name: state.name, expiresAt: state.expiresAt });
      if (progress) return Response.json({ id: handoffId, title: state.title, project: "Synthetic project", version: state.version, status: state.status, device: state.device });
      return Response.json(handoff ? { id: handoffId, title: "Synthetic title", project: "Synthetic project", version: state.version }
        : { subscription: { browserId, disabledAt: null } });
    },
  });
  vm.runInContext(source, context);
  const dispatch = async (type, event) => { let promise; handlers.get(type)({ ...event, waitUntil: value => { promise = value; } }); await promise; };
  // `served` is the version the server still reports; `version` is the one the push event claims.
  const push = (eventId = "synthetic-event", { version = 1, served = version, ...extra } = {}) => {
    state.version = served;
    return dispatch("push", { data: { json: () => handoff
      ? { type: "agentrelay.handoff-ready", eventId, handoffId, version, ...extra } : { type: "agentrelay.test", eventId, ...extra } } });
  };
  /** Send the worker a message from a page of the Site and collect its reply, if it sends one. */
  const post = async (data, source = { url: `${origin}/` }) => {
    let reply;
    const replyPort = { postMessage: value => { reply = value; } };
    await dispatch("message", { source, data, ports: [replyPort] });
    return reply === undefined ? undefined : JSON.parse(JSON.stringify(reply));
  };
  /** An expiry reminder for a connection that expires in `left` ms; `served` is the expiry the Site reports now. */
  const remind = (left, { eventId = "synthetic-reminder", expiresAt = Date.now() + left, served = expiresAt, name = "Laptop agent", ...extra } = {}) => {
    Object.assign(state, { expiresAt: served, name });
    return dispatch("push", { data: { json: () => ({ type: "agentrelay.connection-expiring", eventId, connectionId, expiresAt, ...extra }) } });
  };
  /** A progress event for `step` at `version`; the Site answers with `served`, `status`, `device` and `title`. */
  const advance = (step, { eventId = `synthetic-progress-${step}`, version = 2, served = version, status = step, device = "Desktop", title = "Synthetic title", ...extra } = {}) => {
    Object.assign(state, { version: served, status, device, title });
    return dispatch("push", { data: { json: () => ({ type: "agentrelay.handoff-progress", eventId, handoffId, version, progress: step, ...extra }) } });
  };
  return { push, remind, advance, post, dispatch, handlers, records, notifications, shown, messages, navigations, requests, focused };
}

test("push-only worker never installs a fetch interceptor", () => {
  assert.equal(browser().handlers.has("fetch"), false);
});
test("hidden and closed-page delivery requests a system notification after authenticated metadata fetch", async () => {
  for (const closed of [false, true]) {
    const b = browser({ handoff: true, closed }); await b.push();
    assert.equal(b.notifications.length, 1); assert.equal(b.notifications[0].title, "Synthetic title");
    assert.equal(b.notifications[0].body, "Synthetic project");
    assert.equal(b.requests[0].init.credentials, "same-origin"); assert.equal(b.requests[0].init.redirect, "error");
    assert.equal(b.records.get("lastReceipt").authenticated, true);
    assert.equal(b.records.get("lastReceipt").foreground, false);
  }
});
test("a visible page acknowledges a notice before the worker suppresses the system notification", async () => {
  const b = browser({ foreground: true }); await b.push();
  assert.equal(b.messages.length, 1); assert.equal(b.notifications.length, 0);
  assert.equal(b.records.get("lastReceipt").foreground, true);
});
test("an unhandled foreground message falls back to a system notification", async () => {
  const b = browser({ foreground: true, acknowledge: false }); await b.push();
  assert.equal(b.notifications.length, 1); assert.equal(b.records.get("lastReceipt").foreground, false);
});
test("missing login shows only a generic reminder and never uses task metadata from the payload", async () => {
  const b = browser({ authorized: false, handoff: true }); await b.push();
  assert.equal(b.notifications[0].title, "AgentRelay");
  assert.match(b.notifications[0].body, /sign in/);
  assert.ok(!JSON.stringify(b.notifications).includes("Synthetic title"));
  assert.equal(b.records.get("lastReceipt").authenticated, false);
});
test("an unreadable answer is treated as unavailable, never as a handoff that is no longer waiting", async () => {
  for (const options of [{ redirect: true }, { authorized: false }]) {
    const b = browser({ handoff: true, ...options }); await b.push();
    assert.match(b.notifications[0].body, /sign in/); assert.equal(b.records.get("lastReceipt").authenticated, false);
    assert.notEqual(b.notifications[0].silent, true);
  }
});
test("a handoff that is no longer waiting gets a quiet notice instead of a sign-in request", async () => {
  const b = browser({ gone: true, handoff: true }); await b.push();
  assert.equal(b.notifications.length, 1); assert.equal(b.notifications[0].title, "AgentRelay");
  assert.match(b.notifications[0].body, /no longer waiting/); assert.ok(!/sign in/i.test(b.notifications[0].body));
  assert.equal(b.notifications[0].silent, true); assert.equal(b.notifications[0].data.handoffId, handoffId);
  assert.equal(b.records.get("lastReceipt").authenticated, true);
  const zh = browser({ gone: true, handoff: true, storage: new Map([["configuration", { browserId, locale: "zh" }]]) }); await zh.push();
  assert.match(zh.notifications[0].body, /不在等待/);
});
test("a gone handoff reaches a visible page marked as gone so it can stay silent", async () => {
  const b = browser({ gone: true, handoff: true, foreground: true }); await b.push();
  assert.equal(b.notifications.length, 0); assert.equal(b.messages[0].gone, true);
});
test("a delivery for a version the server no longer reports is shown as no longer waiting", async () => {
  const b = browser({ handoff: true }); await b.push("a:2", { version: 2, served: 3 });
  assert.match(b.notifications[0].body, /no longer waiting/); assert.equal(b.notifications[0].silent, true);
});
test("a newer version of the same handoff replaces the earlier notification and alerts again", async () => {
  const b = browser({ handoff: true }); await b.push("a:1", { version: 1 }); await b.push("a:2", { version: 2 });
  assert.equal(b.notifications.length, 2);
  assert.equal(b.notifications[0].tag, `agentrelay:handoff:${handoffId}`); assert.equal(b.notifications[1].tag, b.notifications[0].tag);
  assert.equal(b.notifications[1].renotify, true);
});
test("a test event asks for a system notification even while a page is visible and willing to show a notice", async () => {
  const b = browser({ foreground: true }); await b.push("test-1", { system: true });
  assert.equal(b.messages.length, 0); assert.equal(b.notifications.length, 1);
  assert.equal(b.notifications[0].tag, "agentrelay:test-1"); assert.equal(b.records.get("lastReceipt").foreground, false);
});
test("the system flag must be a boolean", async () => {
  const b = browser({ foreground: true }); await b.push("test-2", { system: "yes" });
  assert.equal(b.notifications.length, 0); assert.equal(b.messages.length, 0);
});
test("simultaneous duplicate deliveries show one notice, including after restarting the worker", async () => {
  const b = browser(); await Promise.all([b.push(), b.push()]);
  assert.equal(b.notifications.length, 1);
  await b.push(); assert.equal(b.notifications.length, 1);
  const restarted = browser({ storage: b.records }); await restarted.push();
  assert.equal(restarted.notifications.length, 0);
});
test("click focuses an open window and hands the handoff to the page without reloading it", async () => {
  const b = browser({ handoff: true, foreground: true }); let closed = false;
  await b.dispatch("notificationclick", { notification: { data: { handoffId }, close: () => { closed = true; } } });
  assert.equal(closed, true); assert.equal(b.navigations.length, 0); assert.equal(b.focused.length, 1);
  // The worker runs in its own realm, so compare plain data rather than prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(b.messages)), [{ type: "agentrelay.open-handoff", id: handoffId }]); assert.equal(b.requests.length, 0);
});
test("a page that does not understand the message is navigated instead, and a closed browser opens a window", async () => {
  const stale = browser({ handoff: true, opens: false });
  await stale.dispatch("notificationclick", { notification: { data: { handoffId }, close() {} } });
  assert.deepEqual(stale.navigations, [`/?handoff=${handoffId}`]); assert.equal(stale.focused.length, 2);
  const noWindows = browser({ closed: true });
  await noWindows.dispatch("notificationclick", { notification: { data: { handoffId }, close() {} } });
  assert.deepEqual(noWindows.navigations, [`/?handoff=${handoffId}`]);
});
test("click targets stay same-origin: a bad id or a test notification opens the inbox, never the probe page", async () => {
  const b = browser({ closed: true });
  for (const data of [{ handoffId: "https://evil.example/" }, { handoffId: null }, undefined])
    await b.dispatch("notificationclick", { notification: { data, close() {} } });
  assert.deepEqual(b.navigations, ["/", "/", "/"]); assert.equal(b.requests.length, 0);
  const open = browser({ foreground: true });
  await open.dispatch("notificationclick", { notification: { data: { handoffId: null }, close() {} } });
  assert.equal(open.messages.length, 0); assert.equal(open.navigations.length, 0); assert.equal(open.focused.length, 1);
});
test("disabled browser configuration cannot process another task", async () => {
  const b = browser(); b.records.set("configuration", { browserId: null }); await b.push();
  assert.equal(b.requests.length, 0); assert.equal(b.notifications.length, 0);
});
test("the worker reports its stored configuration to a page of the Site", async () => {
  const b = browser();
  assert.deepEqual(await b.post({ type: "agentrelay.read-configuration" }), { browserId, locale: "en" });
  assert.deepEqual(await b.post({ type: "agentrelay.configure-notifications", browserId, locale: "zh" }), { ok: true });
  assert.deepEqual(await b.post({ type: "agentrelay.read-configuration" }), { browserId, locale: "zh" });
  b.records.delete("configuration");
  assert.equal(await b.post({ type: "agentrelay.read-configuration" }), null);
});
test("configuration messages from another origin or without a source are ignored", async () => {
  const b = browser();
  assert.equal(await b.post({ type: "agentrelay.read-configuration" }, { url: "https://evil.example/" }), undefined);
  assert.equal(await b.post({ type: "agentrelay.read-configuration" }, null), undefined);
  assert.equal(await b.post({ type: "agentrelay.sync-waiting", ids: [] }, { url: "https://evil.example/" }), undefined);
});
test("notifications for handoffs that are no longer waiting are closed, and the rest are left alone", async () => {
  const other = crypto.randomUUID(), b = browser({ handoff: true });
  await b.push("a:1");
  b.shown.push({ tag: `agentrelay:handoff:${other}`, closed: false, close() { this.closed = true; } }, { tag: "agentrelay:test-1", closed: false, close() { this.closed = true; } },
    { tag: undefined, closed: false, close() { this.closed = true; } });
  await b.post({ type: "agentrelay.sync-waiting", ids: [handoffId] });
  assert.deepEqual(b.shown.map(item => item.closed), [false, true, false, false]);
  await b.post({ type: "agentrelay.sync-waiting", ids: [] });
  assert.deepEqual(b.shown.map(item => item.closed), [true, true, false, false]);
});
test("a malformed list of waiting handoffs closes nothing", async () => {
  const b = browser({ handoff: true }); await b.push("a:1");
  for (const ids of [undefined, "all", [handoffId, "not-a-uuid"], Array.from({ length: 501 }, () => crypto.randomUUID())]) {
    await b.post({ type: "agentrelay.sync-waiting", ids }); assert.equal(b.shown[0].closed, false, JSON.stringify(ids)?.slice(0, 40));
  }
});
test("a visible page is told the handoff title, and only when the details were read", async () => {
  const shownTo = async options => { const b = browser({ foreground: true, ...options }); await b.push(); return b.messages[0]; };
  assert.equal((await shownTo({ handoff: true })).detail, "Synthetic title");
  for (const options of [{ handoff: true, gone: true }, { handoff: true, authorized: false }, {}]) assert.equal((await shownTo(options)).detail, null, JSON.stringify(options));
});
test("a worker that cannot store its settings says so instead of staying silent, and ignores pushes it cannot place", async () => {
  const b = browser({ brokenStorage: true });
  assert.deepEqual(await b.post({ type: "agentrelay.configure-notifications", browserId, locale: "en" }), { ok: false });
  assert.equal(await b.post({ type: "agentrelay.read-configuration" }), null);
  await b.push(); assert.equal(b.notifications.length, 0);
});

test("an expiry reminder names the connection and the time left, one notification per connection", async () => {
  const b = browser({ connection: true });
  await b.remind(3 * 86_400_000 - 5000, { eventId: "r-3d" }); await b.remind(3_540_000, { eventId: "r-1h" });
  assert.equal(b.requests[0].url, `/api/notifications/connections/${connectionId}?browserId=${browserId}`);
  assert.equal(b.notifications[0].title, "Agent connection expiring");
  assert.equal(b.notifications[0].body, "“Laptop agent” expires in 3 days. Renew it in AgentRelay.");
  assert.equal(b.notifications[1].body, "“Laptop agent” expires in 59 minutes. Renew it in AgentRelay.");
  for (const shown of b.notifications) { assert.equal(shown.tag, `agentrelay:connection:${connectionId}`); assert.equal(shown.renotify, true); assert.equal(shown.data.connectionId, connectionId); }
});
test("an expiry reminder follows the language and hides the name when details are off", async () => {
  const b = browser({ connection: true, storage: new Map([["configuration", { browserId, locale: "zh" }]]) });
  await b.remind(86_400_000 - 60_000, { name: "" });
  assert.equal(b.notifications[0].title, "Agent 连接即将过期");
  assert.equal(b.notifications[0].body, "有一个 Agent 连接将在 1 天后过期，请在 AgentRelay 中续期。");
});
test("a reminder for a renewed connection is quiet, and a signed-out one names nothing", async () => {
  const renewed = browser({ connection: true }); const expiresAt = Date.now() + 3_000_000;
  await renewed.remind(0, { expiresAt, served: expiresAt + 30 * 86_400_000 });
  assert.equal(renewed.notifications[0].silent, true); assert.equal(renewed.notifications[0].body, "A connection expiry reminder is no longer needed.");
  const signedOut = browser({ connection: true, authorized: false }); await signedOut.remind(3_000_000);
  assert.equal(signedOut.notifications[0].body, "An agent connection expires soon. Open AgentRelay and sign in to renew it.");
});
test("a visible page shows an expiry reminder itself, and malformed reminders are ignored", async () => {
  const b = browser({ connection: true, foreground: true }); await b.remind(3 * 86_400_000);
  assert.equal(b.notifications.length, 0);
  assert.equal(b.messages[0].connectionId, connectionId); assert.equal(b.messages[0].detail, "“Laptop agent” expires in 3 days. Renew it in AgentRelay.");
  const bad = browser({ connection: true });
  await bad.remind(1000, { connectionId: "../agent-tokens" }); await bad.remind(1000, { eventId: "other", expiresAt: "soon" });
  assert.equal(bad.requests.length, 0); assert.equal(bad.notifications.length, 0);
});
test("clicking an expiry reminder opens the connection list, in the open tab when there is one", async () => {
  const open = browser({ foreground: true });
  await open.dispatch("notificationclick", { notification: { data: { handoffId: null, connectionId }, close() {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(open.messages)), [{ type: "agentrelay.open-connections" }]); assert.equal(open.navigations.length, 0);
  const stale = browser({ opens: false });
  await stale.dispatch("notificationclick", { notification: { data: { handoffId: null, connectionId }, close() {} } });
  assert.deepEqual(stale.navigations, ["/?view=agent"]);
  const closed = browser({ closed: true });
  await closed.dispatch("notificationclick", { notification: { data: { handoffId: null, connectionId }, close() {} } });
  assert.deepEqual(closed.navigations, ["/?view=agent"]);
});
test("a progress event asks for the sender's view and shows the step and the claiming device", async () => {
  const b = browser({ progress: true });
  await b.advance("claimed"); await b.advance("done", { version: 3 });
  assert.match(b.requests[0].url, /^\/api\/notifications\/handoffs\/[0-9a-f-]+\?browserId=[0-9a-f-]+&kind=progress$/);
  assert.deepEqual(b.notifications.map(item => [item.title, item.body, item.tag, item.renotify, item.data.handoffId]), [
    ["Synthetic title", "Claimed on Desktop", `agentrelay:progress:${handoffId}`, true, handoffId],
    ["Synthetic title", "Done on Desktop", `agentrelay:progress:${handoffId}`, true, handoffId]]);
  const zh = browser({ progress: true, storage: new Map([["configuration", { browserId, locale: "zh" }]]) }); await zh.advance("done");
  assert.equal(zh.notifications[0].body, "已在 Desktop 完成");
});
test("hidden details give a generic progress line, and a moved-on handoff a quiet one", async () => {
  const hidden = browser({ progress: true }); await hidden.advance("done", { title: "", device: "" });
  assert.equal(hidden.notifications[0].title, "AgentRelay"); assert.equal(hidden.notifications[0].body, "A handoff you sent is done");
  for (const stale of [{ served: 4 }, { status: "claimed" }]) {
    const b = browser({ progress: true }); await b.advance("done", stale);
    assert.equal(b.notifications[0].silent, true); assert.equal(b.notifications[0].body, "A handoff you sent has changed again since.");
    assert.ok(!JSON.stringify(b.notifications).includes("Synthetic title"));
  }
  const signedOut = browser({ progress: true, authorized: false }); await signedOut.advance("done");
  assert.equal(signedOut.notifications[0].body, "A handoff you sent has moved on. Open AgentRelay and sign in to view it.");
});
test("a visible page shows progress itself, and malformed progress events are ignored", async () => {
  const b = browser({ progress: true, foreground: true }); await b.advance("done");
  assert.equal(b.notifications.length, 0);
  assert.equal(b.messages[0].progress, "done"); assert.equal(b.messages[0].handoffId, handoffId);
  assert.equal(b.messages[0].detail, "Done on Desktop: Synthetic title");
  const bad = browser({ progress: true });
  await bad.advance("started"); await bad.advance("done", { eventId: "bad-id", handoffId: "../handoffs" }); await bad.advance("done", { eventId: "bad-version", version: "2" });
  assert.equal(bad.requests.length, 0); assert.equal(bad.notifications.length, 0);
});
