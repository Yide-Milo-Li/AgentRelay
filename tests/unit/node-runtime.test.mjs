import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertSupportedNodeRuntime } from "../../tooling/environment/node-runtime.mjs";

test("Windows rejects vulnerable and unsupported Node release lines before network work", () => {
  // Some 22.x builds report libuv 1.52.1 without the fix, so a libuv-version gate is not sufficient.
  for (const version of ["v22.13.0", "v22.23.2", "v23.11.0", "v24.15.0", "v24.19.9", "v25.9.0", "v26.0.0"]) {
    assert.throws(() => assertSupportedNodeRuntime({ platform: "win32", version }), /Use Node.js 24.21.0.*0xC0000409/);
  }
});

test("Windows accepts the supported fixed release lines and the repository pin", () => {
  const pin = readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim();
  for (const version of ["v24.20.0", `v${pin}`, "v24.22.0", "v26.1.0", "v27.0.0"]) {
    assert.doesNotThrow(() => assertSupportedNodeRuntime({ platform: "win32", version }));
  }
});

test("the Windows workaround preserves existing runtimes on other platforms", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.doesNotThrow(() => assertSupportedNodeRuntime({ platform, version: "v22.13.0" }));
  }
});

test("real entrypoints fail before starting a Worker, suite or build on an affected Windows runtime", () => {
  for (const entry of ["scripts/verify-agentrelay-local.mjs", "tests/integration/run-suites.mjs", "tests/integration/verify-agentrelay-projects.mjs", "scripts/sites-env.mjs", "scripts/run-framework.mjs"]) {
    // Simulate the old runtime before dynamically importing the real entrypoint; no child or HTTP request should start.
    const source = `Object.defineProperty(process, "platform", {value:"win32"}); Object.defineProperty(process, "version", {value:"v24.15.0"}); await import(${JSON.stringify(new URL(`../../${entry}`, import.meta.url).href)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
    assert.match(result.stderr, /Unsupported Windows Node.js v24.15.0/);
    assert.equal(result.stdout, "", entry);
  }
});
