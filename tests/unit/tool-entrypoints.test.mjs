import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

test("legacy environment preload resolves the checkout from another directory", () => {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(`${projectRoot}/scripts/sites-env.mjs`).href, "-e", "console.log(process.cwd())"], {
    cwd: process.env.TEMP || projectRoot, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().replaceAll("\\", "/"), projectRoot.replaceAll("\\", "/").replace(/\/$/, ""));
});

test("agent configuration wrapper prints placeholders without requiring live credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/configure-claude-agentrelay.mjs", "--print"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout).mcpServers.agentrelay;
  assert.equal(config.headers.Authorization, "Bearer ${AGENTRELAY_AGENT_TOKEN}");
  assert.equal(config.headers["OAI-Sites-Authorization"], "Bearer ${AGENTRELAY_SITES_GATEWAY_TOKEN}");
});

test("agent configuration rejects retired credentials before invoking Claude", () => {
  const retired = `relay_agent_${"a".repeat(64)}`;
  const result = spawnSync(process.execPath, ["scripts/configure-claude-agentrelay.mjs"], {
    cwd: projectRoot, encoding: "utf8",
    env: { ...process.env, AGENTRELAY_AGENT_TOKEN: retired, AGENTRELAY_SITES_GATEWAY_TOKEN: "synthetic-gateway" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retired credentials are not supported/);
  assert.equal((result.stdout + result.stderr).includes(retired), false);
});

test("legacy connector preview bridge starts and closes without leaking a session", () => {
  const fixtureRoot = path.join(projectRoot, ".sites-runtime", "tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(fixtureRoot, "layout-bridge-"));
  try {
    const grants = path.join(fixture, "grants.json");
    fs.writeFileSync(grants, "[]");
    const result = spawnSync(process.execPath, ["scripts/connector-preview/connector-preview-session.mjs", fixture, grants], {
      cwd: projectRoot, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ jsonrpc: "2.0", method: "stop" }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(messages.some(message => message.method === "ready"));
    assert.ok(messages.some(message => message.method === "closed"));
    assert.equal(fs.existsSync(path.join(fixture, ".sites-runtime", "connector-preview", "session.json")), false);
  } finally {
    // Only remove the fixture created by this test, inside its known checkout-local parent.
    assert.ok(path.resolve(fixture).startsWith(path.resolve(fixtureRoot) + path.sep));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
