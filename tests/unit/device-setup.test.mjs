import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { CONFIG_BEGIN, ENV_BEGIN, RULE_BEGIN, RULE_END, expandHome, persistUserEnv, persistValues, registerWithCli, registerWithFile, renderProfileConfig, requireSecrets, resolveSite, shellProfileFor, upsertRuleBlock, verifyConnection } from "../../tooling/agents/device-setup.mjs";
import { renderDeviceRule } from "../../src/shared/formatting/device-rule.mjs";

const TOKEN = `agentrelay_${"a".repeat(64)}`;
const profile = { label: "Test Agent", secrets: ["AGENTRELAY_AGENT_TOKEN", "AGENTRELAY_SITES_GATEWAY_TOKEN"] };
const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => { if (body === undefined) throw new Error("not json"); return body; } });

test("the site endpoint must be https, or a loopback Worker, and end with /api/agent/mcp", () => {
  assert.equal(resolveSite({ url: "https://relay.example.com/api/agent/mcp" }).siteUrl, "https://relay.example.com");
  assert.equal(resolveSite({ url: "http://127.0.0.1:5178/api/agent/mcp" }).siteUrl, "http://127.0.0.1:5178");
  assert.equal(resolveSite({ env: { AGENTRELAY_MCP_URL: "https://relay.example.com/base/api/agent/mcp" } }).siteUrl, "https://relay.example.com/base");
  assert.throws(() => resolveSite({ url: "http://relay.example.com/api/agent/mcp" }), /HTTPS/);
  assert.throws(() => resolveSite({ url: "https://relay.example.com/mcp" }), /must end with \/api\/agent\/mcp/);
});

test("secrets are required, and retired Agent Tokens are rejected without echoing them", () => {
  assert.throws(() => requireSecrets(profile, { AGENTRELAY_AGENT_TOKEN: TOKEN }), /Set AGENTRELAY_SITES_GATEWAY_TOKEN/);
  const retired = `relay_agent_${"b".repeat(64)}`;
  assert.throws(() => requireSecrets(profile, { AGENTRELAY_AGENT_TOKEN: retired, AGENTRELAY_SITES_GATEWAY_TOKEN: "g" }), (error) => /retired credentials/.test(error.message) && !error.message.includes(retired));
  assert.doesNotThrow(() => requireSecrets(profile, { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "g" }));
});

test("verifyConnection sends both credentials and reports the listed tools", async () => {
  let sent;
  const verdict = await verifyConnection({ endpoint: "https://relay.example.com/api/agent/mcp", agentToken: TOKEN, gatewayToken: "gateway", fetchImpl: async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ({ result: { tools: ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"].map(name => ({ name })) } }) };
  } });
  assert.deepEqual(verdict, { ok: true, tools: ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"] });
  assert.equal(sent.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.init.headers["OAI-Sites-Authorization"], "Bearer gateway");
  assert.equal(JSON.parse(sent.init.body).method, "tools/list");
});

test("verifyConnection explains each way the site can refuse", async () => {
  const call = (fetchImpl) => verifyConnection({ endpoint: "https://relay.example.com/api/agent/mcp", agentToken: TOKEN, gatewayToken: "gateway", fetchImpl });
  const rejected = await call(reply({ result: { isError: true, content: [{ type: "text", text: "The Agent Token is invalid, expired or revoked." }] } }, 401));
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /rejected the Agent Token \(The Agent Token is invalid/);
  const html = await call(reply(undefined, 401));
  assert.match(html.detail, /answered 401 without MCP data.*gateway token/);
  const offline = await call(async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
  assert.match(offline.detail, /Cannot reach the site \(ENOTFOUND\)/);
  for (const verdict of [rejected, html, offline]) assert.equal(JSON.stringify(verdict).includes(TOKEN), false);
});

test("the rule block is appended once, replaced in place and leaves other text alone", () => {
  const rule = renderDeviceRule("en", "https://relay.example.com", "laptop");
  const fresh = upsertRuleBlock("", rule);
  assert.ok(fresh.startsWith(RULE_BEGIN) && fresh.trimEnd().endsWith(RULE_END));
  assert.ok(fresh.includes("This device id: `laptop`"));

  const mine = "# My instructions\n\nUse tabs.\n";
  const appended = upsertRuleBlock(mine, rule);
  assert.ok(appended.startsWith(`${mine.trimEnd()}\n\n${RULE_BEGIN}`));
  assert.equal(upsertRuleBlock(appended, rule), appended, "running it again changes nothing");

  const moved = upsertRuleBlock(`before\n${appended.slice(mine.length)}\nafter\n`, renderDeviceRule("en", "https://relay.example.com", "desktop"));
  assert.ok(moved.startsWith("before\n") && moved.endsWith("\nafter\n"));
  assert.ok(moved.includes("`desktop`") && !moved.includes("`laptop`"));
  assert.equal(moved.split(RULE_BEGIN).length, 2);
});

test("both rule languages say where the project name comes from and to check it before claiming", () => {
  for (const lang of ["en", "zh"]) {
    const rule = renderDeviceRule(lang, "https://relay.example.com");
    assert.ok(rule.includes("git remote origin") && rule.includes(".git"), `${lang}: project source`);
    assert.ok(rule.includes("projectId"), `${lang}: projectId in results`);
  }
});

test("an existing CRLF file keeps its line endings", () => {
  const result = upsertRuleBlock("# Notes\r\n\r\nKeep.\r\n", "line one\nline two");
  assert.ok(!/(?<!\r)\n/.test(result), "no bare LF");
  assert.ok(result.includes(`${RULE_BEGIN}\r\nline one\r\nline two\r\n${RULE_END}`));
});

test("expandHome only expands a leading ~", () => {
  assert.equal(expandHome("~/.claude/CLAUDE.md", "/home/u"), path.join("/home/u", ".claude/CLAUDE.md"));
  assert.equal(expandHome("/etc/rule.md", "/home/u"), "/etc/rule.md");
  assert.equal(expandHome("a~/b", "/home/u"), "a~/b");
});


test("persisting on Windows hands values to PowerShell through its environment, not its arguments", () => {
  const calls = [];
  const env = { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "gateway-secret-value" };
  const saved = persistUserEnv(Object.keys(env), { env, platform: "win32", home: "C:/Users/x", run: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  const script = calls[0].args.join(" ");
  assert.match(script, /SetEnvironmentVariable\('AGENTRELAY_AGENT_TOKEN', \$env:AGENTRELAY_AGENT_TOKEN, 'User'\)/);
  assert.equal(script.includes(TOKEN) || script.includes("gateway-secret-value"), false);
  assert.equal(calls[0].options.env.AGENTRELAY_SITES_GATEWAY_TOKEN, "gateway-secret-value");
  assert.match(saved.where, /Windows user environment/);
  assert.throws(() => persistUserEnv(Object.keys(env), { env, platform: "win32", home: "C:/Users/x", run: () => ({ status: 1 }) }), /did not accept/);
});

test("persisting elsewhere writes one marked, shell-quoted block to the login shell's profile", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-env-"));
  const env = { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "it's a $secret `x`", SHELL: "/bin/zsh" };
  try {
    fs.writeFileSync(path.join(home, ".zshrc"), "export PATH=$PATH:/opt/bin\n");
    const saved = persistUserEnv(["AGENTRELAY_AGENT_TOKEN", "AGENTRELAY_SITES_GATEWAY_TOKEN"], { env, platform: "linux", home });
    assert.equal(saved.where, path.join(home, ".zshrc"));
    persistUserEnv(["AGENTRELAY_AGENT_TOKEN", "AGENTRELAY_SITES_GATEWAY_TOKEN"], { env, platform: "linux", home });
    const profile = fs.readFileSync(saved.where, "utf8");
    assert.ok(profile.startsWith("export PATH=$PATH:/opt/bin\n"));
    assert.equal(profile.split(ENV_BEGIN).length, 2, "the block is replaced, not duplicated");
    assert.ok(profile.includes(`export AGENTRELAY_AGENT_TOKEN='${TOKEN}'`));
    assert.ok(profile.includes("export AGENTRELAY_SITES_GATEWAY_TOKEN='it'\\''s a $secret `x`'"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the profile file follows the shell and platform, and unsupported shells are refused", () => {
  assert.equal(shellProfileFor({ platform: "darwin", shell: "/bin/zsh", home: "/h" }), path.join("/h", ".zshrc"));
  assert.equal(shellProfileFor({ platform: "darwin", shell: "/bin/bash", home: "/h" }), path.join("/h", ".bash_profile"));
  assert.equal(shellProfileFor({ platform: "linux", shell: "/bin/bash", home: "/h" }), path.join("/h", ".bashrc"));
  assert.equal(shellProfileFor({ platform: "linux", shell: "/bin/sh", home: "/h" }), path.join("/h", ".profile"));
  assert.equal(shellProfileFor({ platform: "linux", shell: "/usr/bin/fish", home: "/h" }), null);
  assert.throws(() => persistUserEnv(["AGENTRELAY_AGENT_TOKEN"], { env: { AGENTRELAY_AGENT_TOKEN: TOKEN, SHELL: "/usr/bin/fish" }, platform: "linux", home: "/h" }), /Cannot edit the profile/);
});

test("persisting refuses unsafe names and unset values", () => {
  assert.throws(() => persistUserEnv(["X'; Remove-Item *"], { env: { "X'; Remove-Item *": "v" }, platform: "win32", home: "C:\\" }), /not a plain environment variable name/);
  assert.throws(() => persistUserEnv(["AGENTRELAY_AGENT_TOKEN"], { env: {}, platform: "win32", home: "C:\\" }), /not set in this terminal/);
});


const codex = JSON.parse(fs.readFileSync(new URL("../../src/shared/agent-profiles/profiles.json", import.meta.url), "utf8")).profiles.find((profile) => profile.id === "codex");
const codexConfig = codex.config.template.replaceAll("{siteUrl}", "https://relay.example.com");

test("persistValues fills the two tokens into each profile's variables", () => {
  const env = { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "gateway-value" };
  assert.deepEqual(persistValues(codex, env), { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_HEADER: "Bearer gateway-value" });
});

test("a file-based profile writes one managed block and keeps the rest of the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-codex-"));
  const file = path.join(dir, ".codex", "config.toml");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    registerWithFile(codex, codexConfig, { file, home: dir });
    registerWithFile(codex, codexConfig, { file, home: dir });
    const written = fs.readFileSync(file, "utf8");
    assert.ok(written.startsWith('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n'));
    assert.equal(written.split(CONFIG_BEGIN).length, 2, "running again replaces the block");
    assert.ok(written.includes('url = "https://relay.example.com/api/agent/mcp"'));
    assert.equal(written.includes(TOKEN), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an AgentRelay table written by hand is reported, not duplicated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-codex-"));
  const file = path.join(dir, "config.toml");
  try {
    const handWritten = '[mcp_servers.agentrelay]\nurl = "https://old.example.com/api/agent/mcp"\n';
    fs.writeFileSync(file, handWritten);
    assert.throws(() => registerWithFile(codex, codexConfig, { file, home: dir }), /already defines \[mcp_servers\.agentrelay\] outside AgentRelay's managed block/);
    assert.equal(fs.readFileSync(file, "utf8"), handWritten, "the file is untouched");
    // Once the hand-written entry is gone the block can be written, and a later run still works.
    fs.writeFileSync(file, "");
    registerWithFile(codex, codexConfig, { file, home: dir });
    registerWithFile(codex, codexConfig, { file, home: dir });
    assert.equal(fs.readFileSync(file, "utf8").split("[mcp_servers.agentrelay]").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const antigravity = JSON.parse(fs.readFileSync(new URL("../../src/shared/agent-profiles/profiles.json", import.meta.url), "utf8")).profiles.find((profile) => profile.id === "antigravity");

test("a bridge profile registers the bridge command with its CLI and keeps the credentials out of the arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-agy-"));
  const out = path.join(dir, "argv.json");
  const endpoint = "https://relay.example.com/api/agent/mcp";
  // The real CLI is replaced by node writing its argument list, so the test needs no Antigravity install.
  const capture = ["-e", "require('fs').writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(1)))"];
  const cli = { ...antigravity.cli, command: process.execPath, remove: capture, args: [...capture, ...antigravity.cli.args] };
  const previous = { OUT: process.env.OUT, AGENTRELAY_AGENT_TOKEN: process.env.AGENTRELAY_AGENT_TOKEN };
  try {
    process.env.OUT = out;
    process.env.AGENTRELAY_AGENT_TOKEN = TOKEN;
    const config = renderProfileConfig(antigravity, "https://relay.example.com");
    assert.equal(registerWithCli({ ...antigravity, cli }, config, { endpoint }), 0);
    const argv = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(argv.slice(0, 4), ["mcp", "add", "-e", `AGENTRELAY_MCP_URL=${endpoint}`]);
    assert.deepEqual(argv.slice(4, 6), ["agentrelay", "node"]);
    assert.ok(path.isAbsolute(argv[6]) && argv[6].endsWith("mcp-bridge.mjs"));
    assert.equal(argv.length, 7);
    assert.equal(JSON.stringify(argv).includes(TOKEN), false);
    assert.throws(() => registerWithCli({ ...antigravity, cli: { ...cli, command: path.join(dir, "missing-cli") } }, config, { endpoint }), /Cannot start the Antigravity CLI/);
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persistValues keeps the two raw tokens for a bridge profile", () => {
  const env = { AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "gateway-value" };
  assert.deepEqual(persistValues(antigravity, env), env);
});



test("legacy setup refuses verification bypasses without writing files or exposing credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-legacy-wrapper-"));
  try {
    for (const profile of ["claude-code", "codex", "antigravity"]) {
      const file = path.join(dir, profile + ".md");
      const result = spawnSync(process.execPath, ["scripts/agents/connect-device.mjs", "--profile", profile, "--skip-verify", "--rule-file", file], {
        cwd: projectRoot, encoding: "utf8", env: { ...process.env, AGENTRELAY_AGENT_TOKEN: TOKEN },
      });
      assert.equal(result.status, 1); assert.match(result.stderr, /skip flags are no longer supported/);
      assert.equal(fs.existsSync(file), false); assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
