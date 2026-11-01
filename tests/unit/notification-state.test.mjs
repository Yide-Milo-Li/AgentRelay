import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const state = await loadTypeScriptModule("src/features/handoffs/notification-state.ts"), { decideNotification } = state;
const browserId = crypto.randomUUID();
const row = (extra = {}) => ({ browserId, deviceId: "laptop", locale: "en", version: 1, disabledAt: null, lastAttemptAt: null, lastAcceptedAt: null, lastError: null,
  notifyRequeue: true, notifyAny: false, showDetails: true, label: "Chrome on Windows", ...extra });
/** A healthy, enabled browser; each test changes one thing. */
const observed = (extra = {}) => ({
  support: { supported: true, browser: "Chrome", label: "Chrome on Windows" }, permission: "granted",
  settings: { available: true, publicKey: "key", subscription: row() }, local: { keyMatches: true, endpointDigest: "digest-a" }, registeredDigest: "digest-a",
  worker: { browserId, locale: "en" }, browserId, locale: "en", previouslyOn: true, ...extra,
});
const decide = extra => decideNotification(observed(extra));
const withRow = (subscription, extra = {}) => observed({ settings: { available: true, publicKey: "key", subscription }, ...extra });

test("a healthy subscription needs nothing", () => {
  assert.deepEqual({ ...decide() }, { state: "on", repairs: [] });
});

test("an unsupported browser stays unsupported and its leftover subscription is deleted", () => {
  const unsupported = { supported: false, reason: "browser" };
  assert.deepEqual({ ...decide({ support: unsupported }) }, { state: "unsupported", reason: "browser", repairs: ["delete-row"] });
  assert.deepEqual({ ...decideNotification(withRow(null, { support: { supported: false, reason: "mobile" } })) }, { state: "unsupported", reason: "mobile", repairs: [] });
});

test("a Site without push keys is unavailable and nothing is touched", () => {
  assert.deepEqual({ ...decide({ settings: { available: false, publicKey: null, subscription: row() } }) }, { state: "unavailable", repairs: [] });
});

test("a blocked permission is reported, and no push is left aimed at a blocked browser", () => {
  assert.deepEqual({ ...decide({ permission: "denied" }) }, { state: "blocked", repairs: ["delete-row"] });
  assert.deepEqual({ ...decideNotification(withRow(null, { permission: "denied" })) }, { state: "blocked", repairs: [] });
});

test("with no subscription on the Site the browser is off and local leftovers are cleared", () => {
  assert.deepEqual({ ...decideNotification(withRow(null, { local: null, worker: null, previouslyOn: false })) }, { state: "off", repairs: [] });
  assert.deepEqual({ ...decideNotification(withRow(null, { local: null, worker: { browserId: null, locale: "en" }, previouslyOn: false })) }, { state: "off", repairs: [] });
  assert.deepEqual({ ...decideNotification(withRow(null, { previouslyOn: false })) }, { state: "off", repairs: ["drop-local", "clear-worker"] });
});

test("a browser that was on and lost its subscription on the Site says so", () => {
  const decision = decideNotification(withRow(null, { local: null, worker: null, previouslyOn: true }));
  assert.deepEqual({ ...decision }, { state: "off", hint: "removed", repairs: [] });
  assert.equal(decideNotification(withRow(null, { local: null, worker: null, previouslyOn: false })).hint, undefined);
});

test("a permission that was reset cannot be repaired silently", () => {
  assert.deepEqual({ ...decide({ permission: "default" }) }, { state: "reconnect", repairs: [] });
});

test("a missing, foreign-keyed or retired push subscription is replaced", () => {
  for (const extra of [{ local: null }, { local: { keyMatches: false, endpointDigest: "digest-a" } }])
    assert.deepEqual({ ...decide(extra) }, { state: "on", repairs: ["resubscribe"] }, JSON.stringify(extra));
  assert.deepEqual({ ...decideNotification(withRow(row({ disabledAt: 5 }))) }, { state: "on", repairs: ["resubscribe"] });
});

test("an endpoint that changed since it was registered is registered again", () => {
  assert.deepEqual({ ...decide({ registeredDigest: "digest-old" }) }, { state: "on", repairs: ["reregister"] });
  assert.deepEqual({ ...decide({ registeredDigest: null }) }, { state: "on", repairs: ["reregister"] });
});

test("the language is kept in step on the Site and in the worker", () => {
  assert.deepEqual({ ...decide({ locale: "zh" }) }, { state: "on", repairs: ["sync-row", "sync-worker"] });
  assert.deepEqual({ ...decide({ worker: { browserId, locale: "zh" } }) }, { state: "on", repairs: ["sync-worker"] });
});

test("a worker that lost or mislaid its configuration is configured again", () => {
  for (const worker of [null, { browserId: null, locale: "en" }, { browserId: crypto.randomUUID(), locale: "en" }])
    assert.deepEqual({ ...decide({ worker }) }, { state: "on", repairs: ["sync-worker"] }, JSON.stringify(worker));
});

test("several drifts are repaired together, in a stable order", () => {
  assert.deepEqual({ ...decide({ registeredDigest: null, locale: "zh", worker: null }) }, { state: "on", repairs: ["reregister", "sync-row", "sync-worker"] });
});

test("permission steps are shown for a block, and for an open or unanswered request while notifications are not on", () => {
  const { permissionGuide } = state;
  assert.equal(permissionGuide("blocked", null), "blocked");
  assert.equal(permissionGuide("blocked", "dismissed"), "blocked");
  for (const where of ["off", "reconnect"]) {
    assert.equal(permissionGuide(where, "waiting"), "waiting");
    assert.equal(permissionGuide(where, "dismissed"), "dismissed");
    assert.equal(permissionGuide(where, null), null);
  }
  // Once notifications work, or cannot be offered at all, an earlier unanswered request no longer matters.
  for (const where of ["on", "unsupported", "unavailable", "loading", "error"]) assert.equal(permissionGuide(where, "dismissed"), null, where);
});
