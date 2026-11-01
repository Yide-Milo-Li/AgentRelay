import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { claimedElsewhere, setupEstablished, setupSteps } = await loadTypeScriptModule("src/app/_components/setup-progress.ts");
const row = (extra = {}) => ({ status: "ready", sourceDevice: "Laptop", sourceDeviceId: "laptop", claimedBy: null, claimedByDeviceId: null, ...extra });
const steps = input => Object.fromEntries(setupSteps({ currentId: null, connected: null, record: {}, rows: [], ...input }).map(step => [step.id, step]));

test("a handoff proves two devices only when another device claimed it", () => {
  assert.equal(claimedElsewhere(row()), false);
  assert.equal(claimedElsewhere(row({ status: "claimed", claimedBy: "Laptop", claimedByDeviceId: "laptop" })), false);
  assert.equal(claimedElsewhere(row({ status: "claimed", claimedBy: "Desktop", claimedByDeviceId: "desktop" })), true);
  // Rows saved before the registry compare by name key.
  assert.equal(claimedElsewhere(row({ status: "done", sourceDeviceId: null, claimedBy: "desk top" })), true);
  assert.equal(claimedElsewhere(row({ status: "done", sourceDeviceId: null, claimedBy: "LAPTOP" })), false);
  assert.equal(setupEstablished([row(), row({ status: "done", claimedBy: "Laptop", claimedByDeviceId: "laptop" })]), true, "any finished handoff ends setup");
  assert.equal(setupEstablished([row()]), false);
});

test("a fresh browser starts at choosing its device", () => {
  const s = steps({});
  assert.deepEqual(Object.values(s).map(step => step.done), [false, false, false, false]);
});

test("server evidence completes a step, and wins over the person's statement", () => {
  const s = steps({ currentId: "laptop", connected: new Set(["laptop"]), record: { plugin: ["laptop"] } });
  assert.deepEqual([s.device.done, s.agent.done, s.agent.selfReported], [true, true, false]);
  assert.equal(s.nextDevice.done, false, "this device's own connection is not another device");
  const both = steps({ currentId: "laptop", connected: new Set(["laptop", "desktop"]) });
  assert.deepEqual([both.nextDevice.done, both.nextDevice.selfReported], [true, false]);
});

test("plugin use and another device's setup count only as statements made in this browser", () => {
  const s = steps({ currentId: "desktop", connected: new Set(), record: { plugin: ["desktop"], others: ["desktop"] } });
  assert.deepEqual([s.agent.done, s.agent.selfReported], [true, true]);
  assert.deepEqual([s.nextDevice.done, s.nextDevice.selfReported], [true, true]);
  // A statement made from another device does not complete this device's step 3.
  assert.equal(steps({ currentId: "phone", record: { others: ["desktop"] } }).nextDevice.done, false);
  // The plugin on another device does.
  assert.equal(steps({ currentId: "phone", record: { plugin: ["desktop"] } }).nextDevice.done, true);
});

test("without a chosen device one connected device is not yet another one", () => {
  assert.equal(steps({ connected: new Set(["laptop"]) }).nextDevice.done, false);
  assert.equal(steps({ connected: new Set(["laptop", "desktop"]) }).nextDevice.done, true);
});

test("Chinese copy spaces a name only next to Latin letters or digits", async () => {
  const { around } = await loadTypeScriptModule("src/shared/i18n/zh-spacing.ts");
  assert.equal(`此浏览器是${around("笔记本", { after: false })}。`, "此浏览器是笔记本。");
  assert.equal(`此浏览器是${around("Laptop", { after: false })}。`, "此浏览器是 Laptop。");
  assert.equal(`在${around("Work PC 2")}上`, "在 Work PC 2 上");
  assert.equal(`在${around("家里的 Mac")}上`, "在家里的 Mac 上");
});
