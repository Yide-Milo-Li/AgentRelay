import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const identity = await loadTypeScriptModule("src/shared/formatting/device-identity.ts");
const { deviceNameKey, slugifyDeviceId, suggestDeviceId, randomDeviceSuffix, isValidDeviceId, heuristicLine, defaultDeviceLine, indexDevices, lookupDevice, resolveStop } = identity;
const device = (id, name, line = "blue") => ({ id, name, line, createdAt: 1, updatedAt: 1, version: 1 });

test("name keys fold width, case and whitespace", () => {
  assert.equal(deviceNameKey("  Work   LAPTOP "), "work laptop");
  assert.equal(deviceNameKey("ＬＡＰＴＯＰ"), "laptop");
  assert.equal(deviceNameKey("Ｃafé"), "café");
});

test("slugs are lowercase ASCII and fit the id rules", () => {
  assert.equal(slugifyDeviceId("Work Laptop"), "work-laptop");
  assert.equal(slugifyDeviceId("  Café — Mac  "), "cafe-mac");
  assert.equal(slugifyDeviceId("笔记本"), "");
  const long = slugifyDeviceId("a".repeat(40));
  assert.equal(long.length, 32);
  assert.ok(isValidDeviceId(long));
  assert.equal(slugifyDeviceId(`${"a".repeat(31)}-b`), "a".repeat(31));
});

test("ids reject reserved words, bad edges and overlong values", () => {
  for (const id of ["laptop", "a", "pc-2", "0day"]) assert.equal(isValidDeviceId(id), true, id);
  for (const id of ["any", "all", "none", "-a", "a-", "Laptop", "a_b", "", "a".repeat(33)]) assert.equal(isValidDeviceId(id), false, id);
});

test("suggested ids avoid taken ids, reserved ids and overflow the length limit cleanly", () => {
  assert.equal(suggestDeviceId("Laptop"), "laptop");
  assert.equal(suggestDeviceId("Laptop", ["laptop"]), "laptop-2");
  assert.equal(suggestDeviceId("Laptop", ["laptop", "laptop-2"]), "laptop-3");
  assert.equal(suggestDeviceId("Any"), "any-2");
  const full = "a".repeat(32);
  const next = suggestDeviceId(full, [full]);
  assert.equal(next, `${"a".repeat(30)}-2`);
  assert.ok(isValidDeviceId(next));
});

test("names without ASCII letters fall back to a stable device-<suffix> id", () => {
  assert.equal(suggestDeviceId("笔记本", [], "k3x9"), "device-k3x9");
  assert.equal(suggestDeviceId("笔记本", ["device-k3x9"], "k3x9"), "device-k3x9-2");
  assert.match(randomDeviceSuffix(), /^[a-z2-7]{4}$/);
  assert.match(suggestDeviceId("手机"), /^device-[a-z2-7]{4}$/);
});

test("heuristic colours keep the common devices and spread the rest", () => {
  assert.equal(heuristicLine("Laptop"), "amber");
  assert.equal(heuristicLine("笔记本"), "amber");
  assert.equal(heuristicLine("Desktop"), "blue");
  assert.equal(heuristicLine("Phone"), "green");
  assert.equal(heuristicLine("Any device"), "neutral");
  assert.equal(heuristicLine("任意设备"), "neutral");
  assert.ok(["violet", "teal", "brown"].includes(heuristicLine("Build server")));
  assert.equal(heuristicLine("Build server"), heuristicLine("  build   SERVER "));
});

test("default colours prefer the heuristic, then the first free line, and are never neutral", () => {
  assert.equal(defaultDeviceLine("Laptop", []), "amber");
  assert.equal(defaultDeviceLine("Laptop", ["amber"]), "blue");
  assert.equal(defaultDeviceLine("Laptop", ["amber", "blue"]), "green");
  const all = ["blue", "amber", "green", "violet", "teal", "brown"];
  assert.equal(defaultDeviceLine("Laptop", all), "amber");
  assert.notEqual(defaultDeviceLine("Any device", []), "neutral");
  assert.notEqual(defaultDeviceLine("Any device", all), "neutral");
});

test("lookup resolves ids and names case-insensitively, and an id match wins", () => {
  const index = indexDevices([device("laptop", "Work laptop", "amber"), device("desk", "laptop", "blue")]);
  assert.equal(lookupDevice(index, "LAPTOP").name, "Work laptop");
  assert.equal(lookupDevice(index, " work  Laptop ").id, "laptop");
  assert.equal(lookupDevice(index, "desk").id, "desk");
  assert.equal(lookupDevice(index, "unknown"), undefined);
  assert.equal(lookupDevice(index, "   "), undefined);
});

test("stops show the registry name and colour, and fall back to the stored snapshot", () => {
  const index = indexDevices([device("laptop", "Work laptop", "teal")]);
  assert.deepEqual(resolveStop(index, "laptop", "Laptop"), { id: "laptop", name: "Work laptop", line: "teal", registered: true });
  assert.equal(resolveStop(index, null, "work laptop").id, "laptop");
  assert.deepEqual(resolveStop(index, "gone", "Build server"), { id: null, name: "Build server", line: heuristicLine("Build server"), registered: false });
  assert.deepEqual(resolveStop(index, null, "Any device", "Any device"), { id: null, name: "Any device", line: "neutral", registered: false });
  assert.equal(resolveStop(index, null, "任意设备", "Any device").name, "Any device");
});

test("unregistered names list each unknown device once and skip registered and reserved ones", () => {
  const { unregisteredNames } = identity;
  const index = indexDevices([device("laptop", "Work laptop")]);
  const row = (sourceDevice, targetDevice, ids = {}) => ({ sourceDevice, targetDevice, sourceDeviceId: null, targetDeviceId: null, ...ids });
  const names = unregisteredNames([
    row("Tablet", "Work laptop"), row("tablet ", "Build box"), row("laptop", "Any device"), row("任意设备", "Tablet"), row("Gone", "Phone", { sourceDeviceId: "missing" }),
  ], index);
  assert.deepEqual(names, ["Tablet", "Build box", "Gone", "Phone"]);
  assert.deepEqual(unregisteredNames([], index), []);
});
