import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, disconnect, disconnectSummary } from "../../tooling/agents/client.mjs";
import { readManifest, credentialRefs, envName } from "../../tooling/agents/credential-store.mjs";
import { removePatchRow } from "../../tooling/agents/client-config.mjs";
import { clearUserEnv, upsertEnvBlock, upsertRuleBlock, removeRuleBlock, RULE_BEGIN } from "../../tooling/agents/device-setup.mjs";

const tools = ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"];
const site = "https://example.test", endpoint = `${site}/api/agent/mcp`, otherSite = "https://agentrelay-other.example.workers.dev";
const token = n => `agentrelay_${String(n).repeat(64)}`, gatewayToken = "synthetic-gateway";
// Without an Agent Token AgentRelay itself answers, so a gateway-free connect sees a deployment without the Sites gate.
const reply = (id, deviceId = "desk") => async (url, init = {}) => !init.headers?.Authorization && String(url).endsWith("/api/agent/connection")
  ? new Response(JSON.stringify({ error: "A valid personal Agent Token is required." }), { status: 401, headers: { "Content-Type": "application/json" } }) : new Response(JSON.stringify(String(url).endsWith("/api/agent/connection")
  ? { connection: { id, deviceId, createdByName: "Tester" }, workspace: { shared: false } } : { result: { tools: tools.map(name => ({ name })) } }), { headers: { "Content-Type": "application/json" } });
// Any network use fails the test: disconnect must work when the Site no longer exists.
const offline = () => { throw new Error("disconnect must not use the network"); };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-disconnect-")), data = new Map();
  const store = { get: ref => data.get(ref) ?? null, set: (ref, value) => data.set(ref, value), remove: ref => data.delete(ref) };
  const settings = { home: path.join(root, "state"), userHome: path.join(root, "user"), launcher: path.join(root, "agentrelay.mjs") };
  const user = file => path.join(settings.userHome, file), read = file => { try { return fs.readFileSync(user(file), "utf8"); } catch { return null; } };
  return { root, data, store, settings, user, read, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const connectAs = (f, { profile, id, n, url = endpoint, storage, persist, gateway = gatewayToken }) =>
  connect({ profile, url, connection: id, device: "desk", transport: "bridge", storage }, { agentToken: token(n), gatewayToken: gateway }, { ...f.settings, store: f.store, fetchImpl: reply(id), persist });

test("OS storage: removing one connection keeps the shared gateway token; removing the Site's last one removes it", async () => {
  const f = fixture(), gatewayRef = credentialRefs(site, "x").gateway;
  try {
    fs.mkdirSync(f.user(".claude"), { recursive: true });
    fs.writeFileSync(f.user(".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { github: { command: "gh" } } }, null, 2) + "\n");
    fs.writeFileSync(f.user(".claude/CLAUDE.md"), "# My rules\n");
    await connectAs(f, { profile: "claude-code", id: "conn-a", n: 1 });
    await connectAs(f, { profile: "codex", id: "conn-b", n: 2 });
    assert.deepEqual([...f.data.keys()].sort(), ["connection-conn-a", "connection-conn-b", gatewayRef].sort());
    assert.ok(fs.existsSync(f.user(".claude/skills/agentrelay/SKILL.md")));

    const one = await disconnect({ connection: "conn-a" }, { ...f.settings, store: f.store, fetchImpl: offline });
    assert.deepEqual([...f.data.keys()].sort(), ["connection-conn-b", gatewayRef].sort(), "conn-b still uses the gateway token");
    assert.deepEqual(Object.keys(readManifest(f.settings.home).connections), ["conn-b"]);
    assert.equal(readManifest(f.settings.home).active["claude-code"], undefined);
    assert.deepEqual(JSON.parse(f.read(".claude.json")), { theme: "dark", mcpServers: { github: { command: "gh" } } });
    assert.equal(f.read(".claude/CLAUDE.md"), "# My rules\n");
    assert.ok(!fs.existsSync(f.user(".claude/skills/agentrelay")), "the emptied skill folder is pruned");
    assert.ok(f.read(".codex/config.toml").includes("conn-b") && fs.existsSync(f.user(".agents/skills/agentrelay/SKILL.md")), "the other agent is untouched");
    const text = disconnectSummary(one);
    assert.match(text, /conn-a \(Claude Code, https:\/\/example\.test\)/);
    assert.match(text, /AgentRelay\/connection-conn-a/);
    assert.ok(!text.includes(gatewayRef) && !text.includes(token(1)) && !text.includes(gatewayToken));

    const rest = await disconnect({ url: `${site}/api/agent/mcp` }, { ...f.settings, store: f.store, fetchImpl: offline });
    assert.equal(f.data.size, 0);
    assert.deepEqual(readManifest(f.settings.home).connections, {});
    assert.ok(!f.read(".codex/config.toml").includes("agentrelay") && !f.read(".codex/AGENTS.md").includes(RULE_BEGIN));
    assert.ok(disconnectSummary(rest).includes(`AgentRelay/${gatewayRef}`));
    // The device can now move to another deployment.
    await connectAs(f, { profile: "codex", id: "conn-c", n: 3, url: `${otherSite}/api/agent/mcp`, gateway: null });
    assert.deepEqual(Object.keys(readManifest(f.settings.home).connections), ["conn-c"]);
  } finally { f.close(); }
});

test("environment storage: the gateway variable and block go only with the last connection that uses them", async () => {
  const f = fixture(), gatewayRef = credentialRefs(site, "x").gateway, calls = [];
  const clear = (names, options) => { calls.push({ names, blockIds: options.blockIds }); return { where: "a test profile", restart: "Restart." }; };
  try {
    await connectAs(f, { profile: "codex", id: "env-a", n: 1, storage: "env", persist: () => {} });
    await connectAs(f, { profile: "antigravity", id: "env-b", n: 2, storage: "env", persist: () => {} });
    await disconnect({ connection: "env-a" }, { ...f.settings, clear, fetchImpl: offline });
    assert.deepEqual(calls.pop(), { names: [envName("connection-env-a")], blockIds: ["connection-env-a"] });
    const result = await disconnect({ url: site }, { ...f.settings, clear, fetchImpl: offline });
    assert.deepEqual(calls.pop(), { names: [envName("connection-env-b"), envName(gatewayRef)], blockIds: ["connection-env-b", `gateway-${gatewayRef}`] });
    assert.equal(f.data.size, 0, "environment storage never opens the OS store");
    assert.match(disconnectSummary(result), /environment variable AGENTRELAY_CONNECTION_ENV_B \(a test profile\)/);
    // A variable that cannot be cleared is reported, not hidden.
    await connectAs(f, { profile: "codex", id: "env-c", n: 3, storage: "env", persist: () => {} });
    const failed = await disconnect({ connection: "env-c" }, { ...f.settings, clear: () => { throw new Error("synthetic"); }, fetchImpl: offline });
    assert.match(disconnectSummary(failed), /Not removed: {3}environment variable AGENTRELAY_CONNECTION_ENV_C\. Delete it by hand\./);
  } finally { f.close(); }
});

test("POSIX environment removal cuts only the named blocks from the shell profile", () => {
  const f = fixture(), profile = path.join(f.root, ".bashrc"), linux = { platform: "linux", env: { SHELL: "/bin/bash" }, home: f.root };
  try {
    fs.writeFileSync(profile, upsertEnvBlock(upsertEnvBlock("export PATH=/bin\n", { AGENTRELAY_A: "a" }, "connection-a"), { AGENTRELAY_B: "b" }, "connection-b"));
    assert.equal(clearUserEnv(["AGENTRELAY_A"], { ...linux, blockIds: ["connection-a"] }).where, profile);
    assert.equal(fs.readFileSync(profile, "utf8"), upsertEnvBlock("export PATH=/bin\n", { AGENTRELAY_B: "b" }, "connection-b"));
    clearUserEnv(["AGENTRELAY_B"], { ...linux, blockIds: ["connection-b", "gateway-site-x"] });
    assert.equal(fs.readFileSync(profile, "utf8"), "export PATH=/bin\n");
    fs.rmSync(profile);
    assert.doesNotThrow(() => clearUserEnv(["AGENTRELAY_B"], { ...linux, blockIds: ["connection-b"] }), "a missing profile is not an error");
    assert.throws(() => clearUserEnv(["bad name"], linux), /not a plain environment variable name/);
    // Windows deletes the User variables by name; values never reach the command.
    let script;
    clearUserEnv(["AGENTRELAY_A"], { platform: "win32", run: (command, args) => { script = args.at(-1); return { status: 0 }; } });
    assert.equal(script, "[Environment]::SetEnvironmentVariable('AGENTRELAY_A', $null, 'User')");
  } finally { f.close(); }
  assert.equal(removeRuleBlock(upsertRuleBlock("# Mine\r\n", "rule")), "# Mine\r\n");
  assert.equal(removeRuleBlock(upsertRuleBlock("", "rule")), "");
});

test("DeepSeek Harness loses only AgentRelay's insert block", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.user(".dsh"), { recursive: true });
    const mine = "# Your patch layer\r\n- id: locale\r\n  config:\r\n    preference: zh-CN\r\n";
    fs.writeFileSync(f.user(".dsh/cordis.patch.yml"), mine);
    await connectAs(f, { profile: "deepseek-harness", id: "dsh", n: 4 });
    assert.ok(f.read(".dsh/cordis.patch.yml").includes("mcp-agentrelay"));
    await disconnect({ connection: "dsh" }, { ...f.settings, store: f.store, fetchImpl: offline });
    assert.equal(f.read(".dsh/cordis.patch.yml"), mine);
    assert.equal(removePatchRow(mine, "mcp-agentrelay"), mine);
  } finally { f.close(); }
});

test("an agent entry that starts another connection is kept, and the rule and skill still go", async () => {
  const f = fixture();
  try {
    await connectAs(f, { profile: "claude-code", id: "conn-a", n: 1 });
    const config = JSON.parse(f.read(".claude.json"));
    config.mcpServers.agentrelay.args = config.mcpServers.agentrelay.args.map(arg => arg === "conn-a" ? "hand-edited" : arg);
    fs.writeFileSync(f.user(".claude.json"), JSON.stringify(config, null, 2) + "\n");
    const result = await disconnect({ connection: "conn-a" }, { ...f.settings, store: f.store, fetchImpl: offline });
    assert.ok(f.read(".claude.json").includes("hand-edited"));
    assert.ok(!f.read(".claude/CLAUDE.md").includes(RULE_BEGIN) && !fs.existsSync(f.user(".claude/skills/agentrelay")));
    assert.match(disconnectSummary(result), /Kept: .*\.claude\.json, whose AgentRelay entry starts another connection/);
  } finally { f.close(); }
});

test("connect names disconnect for another Site; ambiguous or unknown input and a locked store remove nothing", async () => {
  const f = fixture();
  try {
    await connectAs(f, { profile: "codex", id: "conn-a", n: 1 });
    await assert.rejects(connectAs(f, { profile: "codex", id: "conn-z", n: 9, url: `${otherSite}/api/agent/mcp`, gateway: null }),
      /this device is connected to https:\/\/example\.test\. Remove those connections with disconnect --url https:\/\/example\.test, then connect again/);
    const before = { manifest: fs.readFileSync(path.join(f.settings.home, "connections.json"), "utf8"), config: f.read(".codex/config.toml"), keys: [...f.data.keys()] };
    const settings = { ...f.settings, store: f.store, fetchImpl: offline };
    await assert.rejects(disconnect({}, settings), /Choose what to remove/);
    await assert.rejects(disconnect({ url: site, connection: "conn-a" }, settings), /Choose what to remove/);
    await assert.rejects(disconnect({ url: otherSite }, settings), /No connection to https:\/\/agentrelay-other.example.workers.dev is saved/);
    await assert.rejects(disconnect({ url: `${site}/somewhere` }, settings), /Use the Site URL/);
    await assert.rejects(disconnect({ connection: "conn-z" }, settings), /No connection conn-z is saved/);
    await assert.rejects(disconnect({ connection: "../conn-a" }, settings), /Use the connection id/);
    const locked = { get: () => { throw new Error("locked"); }, set: () => {}, remove: () => {} };
    await assert.rejects(disconnect({ connection: "conn-a" }, { ...settings, store: locked }), /Unlock it and retry; nothing was removed/);
    assert.deepEqual({ manifest: fs.readFileSync(path.join(f.settings.home, "connections.json"), "utf8"), config: f.read(".codex/config.toml"), keys: [...f.data.keys()] }, before);
  } finally { f.close(); }
});
