import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { connect, chooseTransport, parseArgs } from "../../tooling/agents/client.mjs";
import yaml from "js-yaml";
import { planConfiguration, applyFileChanges, connectionConfig, upsertPatchRow } from "../../tooling/agents/client-config.mjs";
import { authHeaders, readConnection, readManifest, systemStore } from "../../tooling/agents/credential-store.mjs";
import { installClient, rollbackClient, CLIENT_VERSION } from "../../tooling/agents/client-install.mjs";
import { upsertEnvBlock, loadProfiles, profilePath } from "../../tooling/agents/device-setup.mjs";

const tools = ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"];
const endpoint = "https://example.test/api/agent/mcp";
const secrets = { agentToken: `agentrelay_${"a".repeat(64)}`, gatewayToken: "synthetic-gateway" };
const reply = (id = "a", deviceId = "desk") => async url => new Response(JSON.stringify(String(url).endsWith("/api/agent/connection")
  ? { connection: { id, deviceId, createdByName: "Tester" }, workspace: { shared: false } } : { result: { tools: tools.map(name => ({ name })) } }), { headers: { "Content-Type": "application/json" } });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-client-")), data = new Map();
  return { root, store: { get: ref => data.get(ref) ?? null, set: (ref, value) => data.set(ref, value), remove: ref => data.delete(ref) }, data,
    settings: { home: path.join(root, "state"), userHome: path.join(root, "user"), launcher: path.join(root, "agentrelay.mjs") },
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("every profile keeps separate credentials, preserves unrelated configs and shares one Site gateway", async () => {
  const f = fixture();
  try {
    for (const [i, profile] of ["claude-code", "codex", "antigravity", "deepseek-harness"].entries()) {
      const id = `connection-${i}`;
      await connect({ profile, url: endpoint, connection: id, device: "desk", transport: "bridge" }, { ...secrets, agentToken: `agentrelay_${String(i).repeat(64)}` }, { ...f.settings, store: f.store, fetchImpl: reply(id) });
    }
    assert.equal(f.data.size, 5);
    const files = { "claude-code": ".claude.json", codex: ".codex/config.toml", antigravity: ".gemini/config/mcp_config.json", "deepseek-harness": ".dsh/cordis.patch.yml" };
    for (const [id, record] of Object.entries(readManifest(f.settings.home).connections)) {
      const loaded = await readConnection(id, { home: f.settings.home, store: f.store });
      assert.equal(loaded.agentToken, f.data.get(record.credentialRef));
      const config = fs.readFileSync(path.join(f.settings.userHome, files[record.profile]), "utf8");
      assert.ok(config.includes(id)); assert.ok(!config.includes("AGENTRELAY_AGENT_TOKEN") && !config.includes(loaded.agentToken) && !config.includes(secrets.gatewayToken));
    }
    const manifest = fs.readFileSync(path.join(f.settings.home, "connections.json"), "utf8");
    assert.ok(!manifest.includes(secrets.agentToken) && !manifest.includes(secrets.gatewayToken));
  } finally { f.close(); }
});
test("identity mismatch and config conflicts fail before credential/config writes", async () => {
  const f = fixture();
  try {
    await assert.rejects(connect({ profile: "codex", url: endpoint, connection: "wrong" }, secrets, { ...f.settings, store: f.store, fetchImpl: reply() }), /another connection/);
    const file = path.join(f.root, "config.toml"); fs.writeFileSync(file, '[mcp_servers.agentrelay]\nurl="manual"\n');
    await assert.rejects(connect({ profile: "codex", url: endpoint, transport: "bridge" }, secrets, { ...f.settings, store: f.store, fetchImpl: reply(), configFile: file }), /unmanaged/);
    assert.equal(f.data.size, 0); assert.equal(readManifest(f.settings.home).connections.a, undefined);
  } finally { f.close(); }
});
test("failed vault writes restore the prior credential and do not silently select environment storage", async () => {
  const f = fixture();
  try {
    let sets = 0;
    const store = { ...f.store, set: (ref, value) => { if (++sets === 2) throw new Error("synthetic failure"); return f.store.set(ref, value); } };
    await assert.rejects(connect({ profile: "codex", url: endpoint, transport: "bridge" }, secrets, { ...f.settings, store, fetchImpl: reply() }), /restored/);
    assert.equal(f.data.size, 0); assert.equal(Object.keys(readManifest(f.settings.home).connections).length, 0);
  } finally { f.close(); }
});
test("a config write failure rolls back the first file", () => {
  const f = fixture();
  try {
    const a = path.join(f.root, "a"), b = path.join(f.root, "b"); fs.writeFileSync(a, "original");
    assert.throws(() => applyFileChanges([{ file: a, text: "new" }, { file: b, text: "new" }], { write: (file, text) => { if (file.startsWith(b + ".")) { fs.writeFileSync(file, "partial"); throw new Error(); } fs.writeFileSync(file, text); } }), /rolled back/);
    assert.equal(fs.readFileSync(a, "utf8"), "original"); assert.equal(fs.existsSync(b), false);
  } finally { f.close(); }
});
test("failed recovery reports the exact manual recovery area without exposing a credential", async () => {
  const f = fixture(); let sets = 0;
  try {
    const store = { ...f.store, set: (ref, value) => { if (++sets === 2) throw new Error("store locked"); f.store.set(ref, value); }, remove: () => { throw new Error("still locked"); } };
    await assert.rejects(connect({ profile: "codex", url: endpoint, transport: "bridge" }, secrets, { ...f.settings, store, fetchImpl: reply() }), error =>
      error.message.includes("Automatic recovery could not restore OS credential store") && !error.message.includes(secrets.agentToken));
  } finally { f.close(); }
});
test("managed migration replaces old auth fields and instructions use installed image commands", () => {
  const f = fixture();
  try {
    const configFile = path.join(f.root, "config.toml"), ruleFile = path.join(f.root, "AGENTS.md");
    fs.writeFileSync(configFile, 'model="kept"\n# agentrelay:mcp-config:begin\n[mcp_servers.agentrelay]\nbearer_token_env_var="OLD"\n# agentrelay:mcp-config:end\n');
    fs.writeFileSync(ruleFile, "Other instructions\n");
    const plan = planConfiguration({ record: { profile: "codex", endpoint, id: "test", deviceId: "desk", transport: "direct" }, launcher: f.settings.launcher, home: f.root, configFile, ruleFile });
    applyFileChanges(plan); applyFileChanges(planConfiguration({ record: { profile: "codex", endpoint, id: "test", deviceId: "desk", transport: "direct" }, launcher: f.settings.launcher, home: f.root, configFile, ruleFile }));
    const config = fs.readFileSync(configFile, "utf8"), rule = fs.readFileSync(ruleFile, "utf8");
    assert.match(config, /^model="kept"/); assert.match(config, /http_headers_helper/); assert.ok(!config.includes("bearer_token_env_var"));
    assert.equal(config.split("[mcp_servers.agentrelay]").length, 2); assert.match(rule, /upload --connection test/); assert.match(rule, /^Other instructions/);
  } finally { f.close(); }
});
test("unknown client versions fall back to bridge; verified versions can use dynamic headers", () => {
  const version = stdout => () => ({ status: 0, stdout });
  assert.equal(chooseTransport("codex", "auto", version("codex-cli 0.164.0-alpha.11")), "direct");
  assert.equal(chooseTransport("claude-code", "auto", version("2.1.310 (Claude Code)")), "direct");
  assert.equal(chooseTransport("codex", "auto", version("0.100.0")), "bridge");
  assert.equal(chooseTransport("antigravity"), "bridge");
  assert.equal(chooseTransport("deepseek-harness", "auto", () => { throw new Error("no version probe"); }), "bridge");
  assert.throws(() => chooseTransport("deepseek-harness", "direct"), /DeepSeek Harness requires bridge transport/);
  const config = connectionConfig({ profile: "claude-code", endpoint, id: "c", launcher: "/tmp/client.mjs", node: "/usr/bin/node", transport: "direct", platform: "linux" });
  assert.ok(config.headersHelper.includes("headers --connection")); assert.equal(config.headers, undefined);
});
// dsh resolves `!!js` to tag:yaml.org,2002:js; the tests only need to see the expression it would evaluate.
const dshSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: expression => ({ js: expression }) })]);
const dshRow = (overrides = {}) => connectionConfig({ profile: "deepseek-harness", endpoint, id: "dsh", launcher: String.raw`C:\Users\Some One\.agentrelay\client\agentrelay.mjs`, node: String.raw`C:\Program Files\nodejs\node.exe`, ...overrides });
const userPatch = "# Your patch layer\r\n- id: locale\r\n  config:\r\n    preference: zh-CN\r\n\r\n# MCP 1: GitHub\r\n- id: mcp-github\r\n  name: \"@deepseek-ai/dsh-mcp-client\"\r\n  config:\r\n    serverName: github\r\n    env:\r\n      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN\r\n";

// A patch file is a list of override rows and `insert` blocks; this flattens it to the rows dsh would see.
const patchRows = text => yaml.load(text, { schema: dshSchema }).flatMap(item => item.insert ?? [item]);

test("DeepSeek Harness gets one insert block in its patch file, found by row id, with everything else left as it was", () => {
  const block = dshRow(), once = upsertPatchRow(userPatch, block, "mcp-agentrelay"), twice = upsertPatchRow(once, block, "mcp-agentrelay");
  assert.equal(once, twice); assert.ok(once.startsWith(userPatch.trimEnd())); assert.ok(!once.replaceAll("\r\n", "").includes("\n"));
  const items = yaml.load(once, { schema: dshSchema });
  assert.deepEqual(items.map(item => item.id ?? "insert"), ["locale", "mcp-github", "insert"]);
  assert.deepEqual(items[2].insert.map(row => row.id), ["mcp-agentrelay"]);
  assert.deepEqual(items[2].insert[0].config, { serverName: "agentrelay", transport: "stdio", command: String.raw`C:\Program Files\nodejs\node.exe`,
    args: [String.raw`C:\Users\Some One\.agentrelay\client\agentrelay.mjs`, "bridge", "--connection", "dsh"] });
  // dsh may rewrite the file (settings, quoting, indentation): the block is still found and replaced in place, old auth included.
  const rewritten = `- insert:\n  - id: "mcp-agentrelay"\n    config:\n      serverName: agentrelay\n      env:\n        AGENTRELAY_AGENT_TOKEN: !!js process.env.AGENTRELAY_AGENT_TOKEN\n# kept\n-\n  id: locale\n`;
  const replaced = upsertPatchRow(rewritten, block, "mcp-agentrelay");
  assert.ok(!replaced.includes("AGENTRELAY_AGENT_TOKEN") && replaced.endsWith("# kept\n-\n  id: locale\n"));
  assert.deepEqual(patchRows(replaced).map(row => row.id), ["mcp-agentrelay", "locale"]);
  // A bare row (an override of a row that does not exist, so dsh ignores it) is replaced by the insert block.
  assert.equal(upsertPatchRow("- id: mcp-agentrelay\n  config: {}\n", block, "mcp-agentrelay"), block + "\n");
  assert.equal(upsertPatchRow("", block, "mcp-agentrelay"), block + "\n");
});

test("DeepSeek Harness patch files of another shape or with a competing row are refused", () => {
  const block = dshRow();
  assert.throws(() => upsertPatchRow("locale:\n  preference: zh-CN\n", block, "mcp-agentrelay"), /not a YAML list of patch rows/);
  assert.throws(() => upsertPatchRow("[]\n", block, "mcp-agentrelay"), /not a YAML list of patch rows/);
  assert.throws(() => upsertPatchRow("- id: mine\n  config:\n    serverName: agentrelay\n", block, "mcp-agentrelay"), /already uses serverName agentrelay/);
  assert.throws(() => upsertPatchRow("- insert:\n    - id: mine\n      config:\n        serverName: agentrelay\n", block, "mcp-agentrelay"), /already uses serverName agentrelay/);
  assert.throws(() => upsertPatchRow("- insert:\n    - id: mcp-agentrelay\n    - id: other\n", block, "mcp-agentrelay"), /shares an insert block/);
  assert.throws(() => upsertPatchRow("- insert: [{ id: mcp-agentrelay }]\n", block, "mcp-agentrelay"), /cannot be read safely/);
  assert.throws(() => upsertPatchRow("- id: mcp-agentrelay\n- insert:\n    - id: mcp-agentrelay\n", block, "mcp-agentrelay"), /more than once/);
  assert.throws(() => dshRow({ transport: "direct" }), /requires bridge transport/);
});

test("DeepSeek Harness forwards environment-stored credentials by name only, and DSH_HOME moves its files", () => {
  const block = dshRow({ storage: "env", credentialRef: "connection-dsh", gatewayRef: "site-example-test" });
  assert.deepEqual(patchRows(block)[0].config.env, {
    AGENTRELAY_CONNECTION_DSH: { js: "process.env.AGENTRELAY_CONNECTION_DSH" }, AGENTRELAY_SITE_EXAMPLE_TEST: { js: "process.env.AGENTRELAY_SITE_EXAMPLE_TEST" } });
  const profile = loadProfiles().find(item => item.id === "deepseek-harness"), moved = path.resolve("dsh-home");
  assert.equal(profilePath(profile, profile.config.file, "/home/u", { DSH_HOME: moved }), path.join(moved, "cordis.patch.yml"));
  assert.equal(profilePath(profile, profile.ruleFile, "/home/u", {}), path.join("/home/u", ".dsh", "AGENTS.md"));
});

test("environment compatibility uses isolated variables and independent shell blocks", async () => {
  const f = fixture(); let names;
  try {
    await connect({ profile: "codex", url: endpoint, storage: "env", transport: "bridge" }, secrets, { ...f.settings, fetchImpl: reply(), persist: n => { names = n; } });
    assert.equal(names.length, 2); assert.ok(names.every(n => n.startsWith("AGENTRELAY_") && n !== "AGENTRELAY_AGENT_TOKEN"));
    const text = upsertEnvBlock(upsertEnvBlock("", { AGENTRELAY_A: "a" }, "a"), { AGENTRELAY_B: "b" }, "b");
    assert.ok(text.includes("AGENTRELAY_A") && text.includes("AGENTRELAY_B"));
  } finally { f.close(); }
});
test("repo installation is idempotent, starts outside the checkout and supports previous-version rollback", () => {
  const f = fixture();
  try {
    const first = installClient({ home: f.settings.home }); installClient({ home: f.settings.home });
    const result = spawnSync(process.execPath, [first.launcher, "help"], { cwd: os.tmpdir(), encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /AgentRelay local client/);
    const previous = "0.1.9", folder = path.join(f.settings.home, "client/versions", previous); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(f.settings.home, "client/current.json"), JSON.stringify({ version: CLIENT_VERSION, previous }));
    assert.equal(rollbackClient(f.settings.home), previous);
  } finally { f.close(); }
});
test("header failures never prompt or print secret data; secret argv flags are rejected", () => {
  // The repository entry installs the client into the home folder first, so it gets a disposable one.
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/agents/agentrelay.mjs", "headers", "--connection", crypto.randomUUID()], { encoding: "utf8", env: { ...process.env, HOME: f.root, USERPROFILE: f.root } });
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes(secrets.agentToken));
  } finally { f.close(); }
  assert.throws(() => parseArgs(["connect", "--token", secrets.agentToken]), /Unknown/);
  assert.deepEqual(authHeaders(secrets), { Authorization: `Bearer ${secrets.agentToken}`, "OAI-Sites-Authorization": `Bearer ${secrets.gatewayToken}` });
});
test("Windows OS credential-store synthetic round trip removes its test entry", { skip: process.platform !== "win32" }, async () => {
  const store = await systemStore(), ref = `qa-${crypto.randomUUID()}`;
  try { store.set(ref, "synthetic-round-trip"); assert.equal(store.get(ref), "synthetic-round-trip"); }
  finally { store.remove(ref); }
  assert.equal(store.get(ref), null);
});
