import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const health = await loadTypeScriptModule("src/shared/formatting/connection-health.ts");
const relative = await loadTypeScriptModule("src/shared/formatting/relative-time.ts");
const view = await loadTypeScriptModule("src/features/agent-access/connection-view.ts");

const HOUR = 3_600_000, DAY = 24 * HOUR, now = Date.UTC(2026, 9, 26, 12);
const token = (extra = {}) => ({
  id: "t", name: "Connection", createdAt: now - 90 * DAY, expiresAt: now + 200 * DAY, neverExpires: false, lastAuthenticatedAt: now - HOUR,
  revokedAt: null, deviceId: null, issuerRef: "a", createdByName: "Alex Kim", issuedByViewer: true, ...extra,
});
const device = (id, name) => ({ id, name, line: "blue", version: 1 });

test("status follows credential use: pending, unused, active, idle, retired", () => {
  assert.equal(health.connectionStatus(token({ createdAt: now - 2 * HOUR, lastAuthenticatedAt: null }), now), "pending");
  assert.equal(health.connectionStatus(token({ createdAt: now - 25 * HOUR, lastAuthenticatedAt: null }), now), "unused");
  assert.equal(health.connectionStatus(token({ lastAuthenticatedAt: now - 30 * DAY }), now), "active");
  assert.equal(health.connectionStatus(token({ lastAuthenticatedAt: now - 31 * DAY }), now), "idle");
  assert.equal(health.connectionStatus(token({ revokedAt: now - DAY }), now), "revoked");
  assert.equal(health.connectionStatus(token({ expiresAt: now - 1 }), now), "expired");
  assert.equal(health.connectionStatus(token({ neverExpires: true, expiresAt: null, lastAuthenticatedAt: null, createdAt: now - 400 * DAY }), now), "unused");
});

test("attention lists unused, 60-day stale and expiring connections, never retired ones", () => {
  assert.deepEqual(health.connectionAttention(token(), now), []);
  assert.deepEqual(health.connectionAttention(token({ lastAuthenticatedAt: null }), now), ["unused"]);
  assert.deepEqual(health.connectionAttention(token({ lastAuthenticatedAt: now - 59 * DAY }), now), []);
  assert.deepEqual(health.connectionAttention(token({ lastAuthenticatedAt: now - 60 * DAY }), now), ["stale"]);
  assert.deepEqual(health.connectionAttention(token({ expiresAt: now + 14 * DAY }), now), ["expiring"]);
  assert.deepEqual(health.connectionAttention(token({ expiresAt: now + 15 * DAY }), now), []);
  assert.deepEqual(health.connectionAttention(token({ lastAuthenticatedAt: null, expiresAt: now + DAY }), now), ["unused", "expiring"]);
  assert.deepEqual(health.connectionAttention(token({ neverExpires: true, expiresAt: null }), now), []);
  assert.deepEqual(health.connectionAttention(token({ lastAuthenticatedAt: null, revokedAt: now - 1 }), now), []);
});

test("relative time reads naturally in English and Chinese", () => {
  assert.equal(relative.formatRelative(now - 10_000, now, "en"), "now");
  assert.equal(relative.formatRelative(now - 3 * 60_000, now, "en"), "3 minutes ago");
  assert.equal(relative.formatRelative(now - 5 * HOUR, now, "en"), "5 hours ago");
  assert.equal(relative.formatRelative(now + 12 * DAY, now, "en"), "in 12 days");
  assert.equal(relative.formatRelative(now - 3 * 60_000, now, "zh-CN"), "3分钟前");
  assert.equal(relative.formatRelative(now + 12 * DAY, now, "zh-CN"), "12天后");
});

test("filters combine, match names, devices and members, and treat unregistered devices as none", () => {
  const devices = [device("laptop", "Laptop")];
  const tokens = [
    token({ id: "1", name: "Codex", deviceId: "laptop" }),
    token({ id: "2", name: "Antigravity", deviceId: "gone", issuerRef: "b", createdByName: "Sam Rivera", issuedByViewer: false, lastAuthenticatedAt: null }),
  ];
  const ids = filters => view.filterConnections(tokens, { ...view.NO_FILTERS, ...filters }, devices, now).map(item => item.id);
  assert.deepEqual(ids({}), ["1", "2"]);
  assert.deepEqual(ids({ issuer: "mine" }), ["1"]);
  assert.deepEqual(ids({ issuer: "b" }), ["2"]);
  assert.deepEqual(ids({ device: "none" }), ["2"]);
  assert.deepEqual(ids({ device: "laptop" }), ["1"]);
  assert.deepEqual(ids({ status: "unused" }), ["2"]);
  assert.deepEqual(ids({ status: "attention" }), ["2"]);
  assert.deepEqual(ids({ query: "  RIVERA " }), ["2"]);
  assert.deepEqual(ids({ query: "laptop" }), ["1"]);
  assert.deepEqual(ids({ issuer: "b", status: "active" }), []);
  assert.equal(view.filtersActive(view.NO_FILTERS), false);
  assert.equal(view.filtersActive({ ...view.NO_FILTERS, query: " " }), false);
  assert.equal(view.filtersActive({ ...view.NO_FILTERS, device: "none" }), true);
});

test("member groups put the viewer first and keep same-named issuers apart; device groups end with unbound", () => {
  const devices = [device("laptop", "Laptop"), device("desk", "Desk")];
  const tokens = [
    token({ id: "1", issuerRef: "b", createdByName: "Same Name", issuedByViewer: false, deviceId: "desk" }),
    token({ id: "2", issuerRef: "a", createdByName: "Same Name", deviceId: "laptop" }),
    token({ id: "3", issuerRef: "b", createdByName: "Same Name", issuedByViewer: false }),
  ];
  const members = view.groupConnections(tokens, "member", devices);
  assert.deepEqual(members.map(group => [group.issuerRef, group.viewer, group.items.map(item => item.id)]), [["a", true, ["2"]], ["b", false, ["1", "3"]]]);
  const byDevice = view.groupConnections(tokens, "device", devices);
  assert.deepEqual(byDevice.map(group => [group.key, group.items.map(item => item.id)]), [["laptop", ["2"]], ["desk", ["1"]], ["unbound", ["3"]]]);
  assert.deepEqual(view.issuersOf(tokens).map(issuer => issuer.ref), ["b", "a"]);
  const currentFirst = view.groupConnections(tokens, "device", devices, [], "desk");
  assert.deepEqual(currentFirst.map(group => group.key), ["desk", "laptop", "unbound"]);
});

test("inside its device group a default name drops the repeated device prefix", () => {
  const laptop = device("laptop", "Laptop");
  assert.equal(view.nameWithinDevice("Laptop · Codex", laptop), "Codex");
  assert.equal(view.nameWithinDevice("Laptop · Codex", null), "Laptop · Codex");
  assert.equal(view.nameWithinDevice("Desk · Codex", laptop), "Desk · Codex");
  assert.equal(view.nameWithinDevice("Laptop · ", laptop), "Laptop · ");
  assert.equal(view.nameWithinDevice("Laptop", laptop), "Laptop");
});

test("attention summary counts rows once and each reason separately", () => {
  const tokens = [token({ lastAuthenticatedAt: null, expiresAt: now + DAY }), token({ lastAuthenticatedAt: now - 70 * DAY }), token()];
  assert.deepEqual(view.summarizeAttention(tokens, now), { unused: 1, stale: 1, expiring: 1, total: 2 });
});

test("a rotation starts the pending window again, so a rotated connection is not flagged unused", () => {
  const rotated = token({ createdAt: now - 200 * DAY, lastAuthenticatedAt: null, rotatedAt: now - 2 * HOUR });
  assert.equal(health.connectionStatus(rotated, now), "pending");
  assert.deepEqual(health.connectionAttention(rotated, now), []);
  const waited = token({ createdAt: now - 200 * DAY, lastAuthenticatedAt: null, rotatedAt: now - 25 * HOUR });
  assert.equal(health.connectionStatus(waited, now), "unused"); assert.deepEqual(health.connectionAttention(waited, now), ["unused"]);
  assert.equal(health.connectionStatus(token({ createdAt: now - 25 * HOUR, lastAuthenticatedAt: null, rotatedAt: null }), now), "unused");
});

test("connections group by agent profile with unknown ones under other, and search finds them by agent", () => {
  const profiles = [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }];
  const tokens = [
    token({ id: "1", clientProfile: "codex" }), token({ id: "2", clientProfile: "claude-code" }), token({ id: "3", clientProfile: null }),
    token({ id: "4", clientProfile: "retired-agent" }), token({ id: "5", clientProfile: "other" }), token({ id: "6", clientProfile: "codex", lastClient: { name: "Cursor", version: "1" } }),
  ];
  const groups = view.groupConnections(tokens, "client", [], profiles);
  assert.deepEqual(groups.map(group => [group.clientId, group.items.map(item => item.id)]), [["claude-code", ["2"]], ["codex", ["1", "6"]], ["other", ["3", "4", "5"]]]);
  assert.ok(groups.every(group => group.issuerRef === null && group.device === null));
  assert.deepEqual(view.groupConnections(tokens.slice(0, 1), "client", [], profiles).map(group => group.clientId), ["codex"]);
  const ids = query => view.filterConnections(tokens, { ...view.NO_FILTERS, query }, [], now, profiles).map(item => item.id);
  assert.deepEqual(ids("claude"), ["2"]); assert.deepEqual(ids("CODEX"), ["1", "6"]); assert.deepEqual(ids("cursor"), ["6"]);
  assert.deepEqual(view.groupConnections(tokens, "member", [], profiles).map(group => group.clientId), [null]);
});
