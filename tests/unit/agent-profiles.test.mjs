import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const { profiles } = JSON.parse(readFileSync(new URL("../../src/shared/agent-profiles/profiles.json", import.meta.url), "utf8"));
const run = (args, env = {}) => spawnSync(process.execPath, ["scripts/agents/configure-agent.mjs", ...args], { cwd: projectRoot, encoding: "utf8", env: { ...process.env, ...env } });
const at = (node, path) => path.reduce((value, key) => value?.[key], node);

/** Environment variable names a config refers to: `${NAME}` in JSON values, a bare quoted NAME in TOML, or `process.env.NAME` in YAML. */
function referencedVariables(template) {
  const text = typeof template === "string" ? template : JSON.stringify(template);
  const names = [...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
  if (typeof template === "string") names.push(...[...text.matchAll(/"([A-Z][A-Z0-9_]*)"|process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? match[2]));
  return names;
}

test("profile ids are unique kebab-case slugs", () => {
  const ids = profiles.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
});

for (const profile of profiles) {
  test(`${profile.id}: carries the fields the wizard, rule and setup script read`, () => {
    for (const key of ["label", "ruleFile"]) assert.ok(profile[key]?.trim(), key);
    for (const lang of ["en", "zh"]) assert.ok(profile.description?.[lang]?.trim(), `description.${lang}`);
    assert.deepEqual(profile.secrets, ["AGENTRELAY_AGENT_TOKEN", "AGENTRELAY_SITES_GATEWAY_TOKEN"], "every profile takes the same two inputs");
    assert.ok(profile.persist.AGENTRELAY_AGENT_TOKEN, "the Agent Token is always saved");
    for (const template of Object.values(profile.persist)) assert.match(template, /\{agentToken\}|\{gatewayToken\}/);
    if (profile.config.entryPath) assert.ok(at(profile.config.template, profile.config.entryPath), "entryPath resolves inside the template");
    // An agent is registered either by its own CLI or by editing its config file.
    assert.ok(profile.cli || (profile.config.file && (profile.config.table || profile.config.rowId)), "a CLI, or a config file and its table or row");
    if (profile.home) for (const file of [profile.ruleFile, profile.config.file, profile.skillDir]) assert.ok(file.startsWith(`${profile.home.path}/`), `${file} lives under the movable home`);
    assert.match(profile.skillDir, /^~\/.+\/agentrelay$/, "the skill folder is named after the skill, under the user's home");
    assert.match(profile.skillCommand, /^[/$]agentrelay$/, "the setup summary tells people how to invoke the skill");
    assert.notEqual(path.dirname(profile.skillDir), path.dirname(profile.ruleFile), "skills and instructions are separate folders");
    if (profile.cli) {
      assert.ok(profile.cli.command && profile.cli.missing);
      // A CLI is handed either the JSON entry, or arguments built from {endpoint} and {bridgePath}.
      const entryArgs = profile.cli.args.filter((arg) => arg === "{entry}").length;
      if (profile.bridge) assert.equal(entryArgs, 0);
      else {
        assert.equal(entryArgs, 1);
        assert.ok(profile.config.entryPath, "a CLI is given the entry at entryPath");
      }
      if (profile.cli.remove) assert.ok(Array.isArray(profile.cli.remove) && profile.cli.remove.every((arg) => typeof arg === "string"));
    }
    if (profile.config.table) assert.ok(profile.config.template.startsWith(`[${profile.config.table}]`), "a TOML template defines its table");
    if (profile.config.rowId) assert.ok(profile.config.template.startsWith(`- insert:\n    - id: ${profile.config.rowId}\n`), "a YAML template inserts its patch row");
    if (profile.bridgeCompatibility) {
      assert.ok(profile.bridge, "only a bridge profile adjusts the bridge");
      for (const value of profile.bridgeCompatibility) assert.ok(["core-schemas", "initialize-only"].includes(value), value);
      // The manual template starts the repository bridge with the same adjustments.
      for (const value of profile.bridgeCompatibility) assert.ok(profile.config.template.includes(`"--${value}"`), `template passes --${value}`);
    }
  });

  test(`${profile.id}: the config holds variable references only, never values`, () => {
    const text = typeof profile.config.template === "string" ? profile.config.template : JSON.stringify(profile.config.template);
    assert.ok(text.includes("{siteUrl}"));
    assert.equal(/agentrelay_[a-f0-9]{16,}/i.test(text), false);
    const references = referencedVariables(profile.config.template);
    if (profile.bridge) {
      // The agent starts the bridge, which inherits the tokens, so the config holds no credential. An agent that
      // scrubs inherited secrets (DeepSeek Harness) may only forward a saved variable under its own name.
      assert.ok(text.includes("{bridgePath}"));
      assert.equal(/authorization|bearer/i.test(text), false);
      for (const name of references) {
        assert.ok(name in profile.persist, `${name} is saved by --persist-env`);
        assert.ok(text.includes(`${name}: !!js process.env.${name}`), `${name} is forwarded unchanged`);
      }
      if (!profile.config.rowId) assert.equal(references.length, 0);
    } else {
      assert.ok(references.length > 0);
      for (const name of references) assert.ok(name in profile.persist, `${name} is saved by --persist-env`);
    }
  });
}

test("--print renders the profile with the site URL filled in", () => {
  const result = run(["--profile", "claude-code", "--print"], { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mcpServers.agentrelay.url, "https://relay.example.com/api/agent/mcp");
});

test("--print renders a file-based profile as its own config text", () => {
  const result = run(["--profile", "codex", "--print"], { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[mcp_servers\.agentrelay\]\nurl = "https:\/\/relay\.example\.com\/api\/agent\/mcp"\n/);
  assert.match(result.stdout, /bearer_token_env_var = "AGENTRELAY_AGENT_TOKEN"/);
  assert.match(result.stdout, /env_http_headers = \{ "OAI-Sites-Authorization" = "AGENTRELAY_SITES_GATEWAY_HEADER" \}/);
});

test("--print renders a bridge profile with the bridge script on this device", () => {
  const result = run(["--profile", "antigravity", "--print"], { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" });
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).mcpServers.agentrelay;
  assert.equal(entry.command, "node");
  assert.ok(path.isAbsolute(entry.args[0]) && entry.args[0].endsWith(path.join("scripts", "agents", "mcp-bridge.mjs")));
  assert.deepEqual(entry.env, { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" });
});

test("--print renders a YAML patch row that forwards the bridge variables by name", () => {
  const result = run(["--profile", "deepseek-harness", "--print"], { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- insert:\n    - id: mcp-agentrelay\n      name: "@deepseek-ai\/dsh-mcp-client"\n      config:\n        serverName: agentrelay\n        transport: stdio\n/);
  assert.match(result.stdout, /mcp-bridge\.mjs", "--core-schemas", "--initialize-only"\]/);
  assert.match(result.stdout, /AGENTRELAY_MCP_URL: "https:\/\/relay\.example\.com\/api\/agent\/mcp"/);
  assert.match(result.stdout, /AGENTRELAY_AGENT_TOKEN: !!js process\.env\.AGENTRELAY_AGENT_TOKEN/);
  assert.ok(result.stdout.includes(path.join(projectRoot, "scripts", "agents", "mcp-bridge.mjs")));
});

test("--print --no-gateway leaves exactly the gateway header and variables out of each profile", () => {
  const env = { AGENTRELAY_MCP_URL: "https://relay.example.com/api/agent/mcp" }, gatewayLine = /OAI-Sites-Authorization|SITES_GATEWAY/;
  const print = (id, ...flags) => { const result = run(["--profile", id, "--print", ...flags], env); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  // Text configs (TOML, YAML) lose the lines that name the gateway and nothing else.
  for (const id of ["codex", "deepseek-harness"]) {
    const full = print(id), bare = print(id, "--no-gateway");
    assert.ok(gatewayLine.test(full), id);
    assert.equal(bare, full.split("\n").filter(line => !gatewayLine.test(line)).join("\n"), id);
  }
  // The JSON config keeps its Agent Token header and loses the gateway header.
  const claude = JSON.parse(print("claude-code")), bareClaude = JSON.parse(print("claude-code", "--no-gateway"));
  delete claude.mcpServers.agentrelay.headers["OAI-Sites-Authorization"];
  assert.deepEqual(bareClaude, claude);
  assert.deepEqual(Object.keys(bareClaude.mcpServers.agentrelay.headers), ["Authorization"]);
  // A bridge profile's config never named the gateway, so it is unchanged.
  assert.equal(print("antigravity", "--no-gateway"), print("antigravity"));
});

test("the endpoint must be https and end with /api/agent/mcp", () => {
  assert.match(run(["--print"], { AGENTRELAY_MCP_URL: "http://relay.example.com/api/agent/mcp" }).stderr, /HTTPS/);
  assert.match(run(["--print"], { AGENTRELAY_MCP_URL: "https://relay.example.com/mcp" }).stderr, /must end with \/api\/agent\/mcp/);
});

test("an unknown profile is rejected with the available ids", () => {
  const result = run(["--profile", "nope", "--print"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown profile "nope"\. Available: claude-code, codex, antigravity, deepseek-harness/);
});

test("--list prints every profile", () => {
  const result = run(["--list"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => line.split("\t")[0]), profiles.map((profile) => profile.id));
});
