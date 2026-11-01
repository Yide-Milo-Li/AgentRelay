import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const rules = await loadTypeScriptModule("src/server/devices/validation.ts");
const { parseDeviceName, parseDeviceId, parseDeviceLine, parseVersion, parseConnectionAction, assertNoConflicts } = rules;
const status = (action) => { try { action(); } catch (error) { return error.status; } return null; };

test("names are trimmed, collapsed and keyed; bad names are 400", () => {
  assert.deepEqual(parseDeviceName("  Work   Laptop "), { name: "Work Laptop", key: "work laptop" });
  assert.equal(parseDeviceName("a".repeat(80)).name.length, 80);
  for (const bad of ["", "   ", "a".repeat(81), "tab\there", "line\nbreak", "nul\u0000", 7, null, undefined]) assert.equal(status(() => parseDeviceName(bad)), 400, String(bad));
});

test("reserved names are rejected in both languages and with width variants", () => {
  for (const reserved of ["any", "Any Device", "ANY  DEVICE", "任意设备", "ａｎｙ"]) assert.equal(status(() => parseDeviceName(reserved)), 400, reserved);
  assert.equal(status(() => parseDeviceName("Any device 2")), null);
});

test("ids follow the slug rule and the reserved list", () => {
  assert.equal(parseDeviceId("work-laptop-2"), "work-laptop-2");
  for (const bad of ["Any", "any", "all", "none", "-x", "x-", "UPPER", "a b", "", "a".repeat(33), 5]) assert.equal(status(() => parseDeviceId(bad)), 400, String(bad));
});

test("lines, versions and delete actions are validated", () => {
  assert.equal(parseDeviceLine("violet"), "violet");
  assert.equal(status(() => parseDeviceLine("pink")), 400);
  assert.equal(parseVersion({ version: 3 }), 3);
  for (const bad of [{}, { version: 0 }, { version: 1.5 }, { version: "2" }]) assert.equal(status(() => parseVersion(bad)), 400);
  assert.equal(parseConnectionAction(undefined), "unbind");
  assert.equal(parseConnectionAction("revoke"), "revoke");
  assert.equal(status(() => parseConnectionAction("delete")), 400);
});

test("an id or name key may not repeat or shadow another device's, but may match its own", () => {
  const others = [{ id: "laptop", nameKey: "work laptop" }, { id: "pc", nameKey: "desktop" }];
  assert.equal(status(() => assertNoConflicts(others, { id: "laptop", nameKey: "x" })), 409);
  assert.equal(status(() => assertNoConflicts(others, { id: "x", nameKey: "desktop" })), 409);
  assert.equal(status(() => assertNoConflicts(others, { id: "x", nameKey: "pc" })), 409);
  assert.equal(status(() => assertNoConflicts(others, { id: "desktop", nameKey: "x" })), 409);
  assert.equal(status(() => assertNoConflicts(others, { id: "tablet", nameKey: "tablet" })), null);
  assert.equal(status(() => assertNoConflicts([], { id: "laptop", nameKey: "laptop" })), null);
});
