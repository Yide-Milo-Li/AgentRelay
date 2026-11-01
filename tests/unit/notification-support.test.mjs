import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { notificationSupport } = await loadTypeScriptModule("src/shared/browser/notification-support.ts");
const apis = { secureContext: true, serviceWorker: true, pushManager: true, notification: true };
const grease = { brand: "Not A;Brand" };
const chrome = (extra = {}) => ({ ...apis, userAgentData: { mobile: false, platform: "Windows", brands: [grease, { brand: "Chromium" }, { brand: "Google Chrome" }] }, ...extra });
const edge = (extra = {}) => ({ ...apis, userAgentData: { mobile: false, platform: "Windows", brands: [grease, { brand: "Chromium" }, { brand: "Microsoft Edge" }] }, ...extra });

test("desktop Chrome and desktop Edge are the only supported browsers", () => {
  assert.deepEqual(notificationSupport(chrome()), { supported: true, browser: "Chrome", label: "Chrome on Windows" });
  assert.deepEqual(notificationSupport(edge()), { supported: true, browser: "Edge", label: "Edge on Windows" });
  assert.equal(notificationSupport(chrome({ userAgentData: { mobile: false, platform: "macOS", brands: [{ brand: "Google Chrome" }] } })).label, "Chrome on macOS");
  assert.equal(notificationSupport(chrome({ userAgentData: { mobile: false, brands: [{ brand: "Google Chrome" }] } })).label, "Chrome");
});

test("other Chromium browsers are refused because the user agent alone cannot vouch for their push service", () => {
  for (const brand of ["Opera", "Brave", "Vivaldi", "Samsung Internet", "Arc"]) {
    const result = notificationSupport({ ...apis, userAgentData: { mobile: false, platform: "Windows", brands: [grease, { brand: "Chromium" }, { brand }] } });
    assert.deepEqual(result, { supported: false, reason: "browser" }, brand);
  }
  assert.deepEqual(notificationSupport(chrome({ brave: true })), { supported: false, reason: "browser" });
});

test("browsers without user agent data (Firefox, Safari) are refused", () => {
  assert.deepEqual(notificationSupport({ ...apis }), { supported: false, reason: "browser" });
  assert.deepEqual(notificationSupport({ ...apis, userAgentData: null }), { supported: false, reason: "browser" });
  assert.deepEqual(notificationSupport({ ...apis, userAgentData: { mobile: false, platform: "Windows", brands: [] } }), { supported: false, reason: "browser" });
});

test("phones and tablets are refused even when the browser is Chrome or Edge", () => {
  assert.deepEqual(notificationSupport(chrome({ userAgentData: { mobile: true, platform: "Android", brands: [{ brand: "Google Chrome" }] } })), { supported: false, reason: "mobile" });
  // Android tablets report mobile = false, so the platform decides.
  assert.deepEqual(notificationSupport(chrome({ userAgentData: { mobile: false, platform: "Android", brands: [{ brand: "Google Chrome" }] } })), { supported: false, reason: "mobile" });
  assert.deepEqual(notificationSupport(edge({ userAgentData: { mobile: false, platform: "iOS", brands: [{ brand: "Microsoft Edge" }] } })), { supported: false, reason: "mobile" });
});

test("a supported browser without the push APIs or a secure context is reported as an API gap", () => {
  for (const missing of ["secureContext", "serviceWorker", "pushManager", "notification"])
    assert.deepEqual(notificationSupport(chrome({ [missing]: false })), { supported: false, reason: "api" }, missing);
  // The browser verdict wins, so an unsupported browser never advertises an API problem it cannot fix.
  assert.deepEqual(notificationSupport({ secureContext: false, serviceWorker: false, pushManager: false, notification: false }), { supported: false, reason: "browser" });
});

test("the label stays within the stored length and cannot carry markup from an odd platform string", () => {
  const result = notificationSupport(chrome({ userAgentData: { mobile: false, platform: `<b>${"x".repeat(80)}</b>`, brands: [{ brand: "Google Chrome" }] } }));
  assert.equal(result.supported, true);
  assert.ok(result.label.length <= 40); assert.ok(!/[<>]/.test(result.label));
});
