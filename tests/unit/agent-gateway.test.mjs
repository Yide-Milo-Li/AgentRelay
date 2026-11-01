// The gateway command, the repository bootstrap and client upgrades, with injected stores, fetch and processes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentConnection, copyGateway, installSummary, saveGateway, verifySummary } from "../../tooling/agents/client.mjs";
import { checkGateway, copyToClipboard, gatewayRef, siteOrigin } from "../../tooling/agents/gateway.mjs";
import { CLIENT_FILES, CLIENT_VERSION, copyClient, ensureClient, hasKeyring, installClient, rollbackClient } from "../../tooling/agents/client-install.mjs";
import { isClientCopy, runEntry } from "../../tooling/agents/client-bootstrap.mjs";
import { credentialRefs } from "../../tooling/agents/credential-store.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const site = "https://relay.example.chatgpt.site", gateway = "synthetic-gateway-token";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-gateway-")), data = new Map();
  return { root, data, home: path.join(root, "state"), store: { get: ref => data.get(ref) ?? null, set: (ref, value) => data.set(ref, value), remove: ref => data.delete(ref) },
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// What AgentRelay answers when the gateway let a request through without an Agent Token.
const passed = async () => new Response(JSON.stringify({ error: "A valid personal Agent Token is required." }), { status: 401, headers: { "Content-Type": "application/json" } });
const gated = async () => new Response("<html>Sign in</html>", { status: 403, headers: { "Content-Type": "text/html" } });

test("the gateway is keyed by Site origin, the same entry connect uses", () => {
  assert.equal(siteOrigin(`${site}/`), site);
  assert.equal(siteOrigin(`${site}/api/agent/mcp`), site);
  assert.equal(siteOrigin("http://127.0.0.1:5178"), "http://127.0.0.1:5178");
  for (const bad of ["http://relay.example.com", `${site}/other`, `${site}/?token=x`, "not a url"]) assert.throws(() => siteOrigin(bad));
  assert.equal(gatewayRef(site).ref, credentialRefs(site, "any-connection").gateway);
});

test("gateway --stdin saves only a token the Site lets through, and never echoes it", async () => {
  const f = fixture();
  try {
    await assert.rejects(saveGateway({ url: site }, `${gateway}\n`, { store: f.store, fetchImpl: gated }), /did not accept/);
    assert.equal(f.data.size, 0);
    await assert.rejects(saveGateway({ url: site }, "two words", { store: f.store, fetchImpl: passed }), /one line/);
    const saved = await saveGateway({ url: site }, `${gateway}\n`, { store: f.store, fetchImpl: passed });
    assert.equal(f.data.get(gatewayRef(site).ref), gateway);
    assert.ok(!JSON.stringify(saved).includes(gateway));
    let persisted;
    await saveGateway({ url: site, storage: "env" }, gateway, { fetchImpl: passed, env: {}, persist: (names, options) => { persisted = { names, value: options.env[names[0]] }; return { where: "profile", restart: "restart" }; } });
    assert.deepEqual(persisted, { names: [gatewayRef(site).variable], value: gateway });
  } finally { f.close(); }
});

test("the gateway check sends only the gateway header and counts only AgentRelay's own answer", async () => {
  let headers;
  await checkGateway(site, gateway, async (url, init) => { headers = init.headers; assert.equal(String(url), `${site}/api/agent/connection`); return passed(); });
  assert.deepEqual(Object.keys(headers), ["OAI-Sites-Authorization"]);
  await assert.rejects(checkGateway(site, gateway, async () => new Response(null, { status: 302, headers: { Location: "/signin-with-chatgpt" } })), /HTTP 302/);
  await assert.rejects(checkGateway(site, gateway, async () => { throw new TypeError("offline"); }), /Could not reach/);
});

test("gateway --copy hands the saved token to the clipboard tool on stdin only, and never prints it", async () => {
  const f = fixture(), calls = [];
  try {
    f.store.set(gatewayRef(site).ref, gateway);
    const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
    const result = await copyGateway({ url: site }, { store: f.store, platform: "win32", run });
    assert.deepEqual(result, { origin: site });
    assert.equal(calls.length, 1); assert.equal(calls[0].command, "clip.exe");
    assert.equal(calls[0].options.input, gateway); assert.ok(!calls[0].args.join(" ").includes(gateway));
    assert.deepEqual(calls[0].options.stdio, ["pipe", "ignore", "ignore"]);
    // Linux tries each tool in turn; none working is an error, not a fallback to printing.
    const tried = [];
    assert.throws(() => copyToClipboard(gateway, { platform: "linux", run: command => { tried.push(command); return { status: 1 }; } }), /Nothing was copied/);
    assert.deepEqual(tried, ["wl-copy", "xclip", "xsel"]);
    await assert.rejects(copyGateway({ url: "https://other.example.chatgpt.site" }, { store: f.store, platform: "win32", run }), /No gateway token is saved/);
    assert.equal(calls.length, 1);
    await copyGateway({ url: site, storage: "env" }, { env: { [gatewayRef(site).variable]: gateway }, platform: "darwin", run });
    assert.equal(calls[1].command, "pbcopy"); assert.equal(calls[1].options.input, gateway);
  } finally { f.close(); }
});

test("the gateway command prints no token when it fails", () => {
  // Never reaches the real clipboard: the copy path is covered above with an injected process runner.
  const f = fixture();
  try {
    const env = { ...process.env, HOME: f.root, USERPROFILE: f.root };
    const unreachable = spawnSync(process.execPath, ["scripts/agents/agentrelay.mjs", "gateway", "--url", "http://127.0.0.1:9", "--stdin"], { encoding: "utf8", env, cwd: projectRoot, input: gateway });
    assert.equal(unreachable.status, 1); assert.match(unreachable.stderr, /Could not reach/);
    assert.ok(!unreachable.stdout.includes(gateway) && !unreachable.stderr.includes(gateway));
    const both = spawnSync(process.execPath, ["scripts/agents/agentrelay.mjs", "gateway", "--url", site, "--copy", "--stdin"], { encoding: "utf8", env, cwd: projectRoot, input: gateway });
    assert.equal(both.status, 1); assert.match(both.stderr, /Choose --stdin/); assert.ok(!both.stderr.includes(gateway));
  } finally { f.close(); }
});

test("the repository entry installs its client version, then hands the same arguments to it", async () => {
  const calls = [];
  const ensure = ({ source }) => { calls.push(["ensure", source]); return "/installed/0.9.9"; };
  const run = (command, args, options) => { calls.push(["run", command, args, options.stdio]); return { status: 3 }; };
  await runEntry(["connect", "--profile", "codex"], projectRoot, { ensure, run });
  assert.deepEqual(calls, [["ensure", projectRoot], ["run", process.execPath, [path.join("/installed/0.9.9", "scripts/agents/agentrelay.mjs"), "connect", "--profile", "codex"], "inherit"]]);
  assert.equal(process.exitCode, 3); process.exitCode = 0;
  assert.equal(isClientCopy(projectRoot), false);
});

test("a checkout without dependencies gets the keyring from npm, and a failed install leaves nothing behind", () => {
  const f = fixture();
  try {
    // A synthetic checkout: the client files and no node_modules.
    const source = path.join(f.root, "checkout");
    for (const file of CLIENT_FILES) { fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.copyFileSync(path.join(projectRoot, file), path.join(source, file)); }
    assert.equal(hasKeyring(source), false);
    assert.throws(() => ensureClient({ source, home: f.home, npm: () => { throw new Error("offline"); } }));
    const versions = path.join(f.home, "client/versions");
    assert.deepEqual(fs.readdirSync(versions), []);
    // A stand-in for npm that installs the pinned addon the way npm would.
    const npm = target => { for (const name of ["keyring", path.basename(fs.readdirSync(path.join(projectRoot, "node_modules/@napi-rs")).find(n => n !== "keyring"))]) fs.cpSync(path.join(projectRoot, "node_modules/@napi-rs", name), path.join(target, "node_modules/@napi-rs", name), { recursive: true }); };
    const root = ensureClient({ source, home: f.home, npm });
    assert.equal(root, path.join(versions, CLIENT_VERSION)); assert.ok(hasKeyring(root)); assert.ok(isClientCopy(root));
    assert.deepEqual(fs.readdirSync(versions), [CLIENT_VERSION]);
    assert.equal(fs.existsSync(path.join(f.home, "client/current.json")), false, "installing a version does not select it");
    // A copy from a checkout with dependencies never calls npm.
    copyClient(projectRoot, path.join(f.root, "copied"), { npm: () => assert.fail("npm must not run") });
  } finally { f.close(); }
});

test("an existing 0.3.0 install upgrades in place and can roll back", () => {
  const f = fixture();
  try {
    const old = path.join(f.home, "client/versions/0.3.0"); fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(f.home, "client/current.json"), JSON.stringify({ version: "0.3.0", previous: null }));
    const manifest = JSON.stringify({ version: 1, connections: { c1: { id: "c1", profile: "codex", endpoint: `${site}/api/agent/mcp` } } });
    fs.writeFileSync(path.join(f.home, "connections.json"), manifest);
    const result = installClient({ home: f.home });
    assert.equal(result.version, CLIENT_VERSION); assert.equal(result.replaced, "0.3.0");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, "client/current.json"), "utf8")), { version: CLIENT_VERSION, previous: "0.3.0" });
    assert.equal(fs.readFileSync(path.join(f.home, "connections.json"), "utf8"), manifest);
    assert.match(installSummary(result), new RegExp(`client ${CLIENT_VERSION.replaceAll(".", "\\.")} \\(updated from 0\\.3\\.0\\)`));
    assert.match(installSummary(installClient({ home: f.home })), /is already installed and selected/);
    assert.equal(rollbackClient(f.home), "0.3.0");
  } finally { f.close(); }
});

test("verify reads as a sentence per fact and names the fix", () => {
  const text = verifySummary({ connection: { id: "c1", name: "Laptop · Codex", deviceId: "laptop", expiresAt: Date.UTC(2027, 0, 2) }, workspace: { shared: false },
    skill: { state: "missing", fix: "node agentrelay.mjs skill --connection c1" } });
  assert.match(text, /^Connection c1 works/); assert.ok(!text.includes("Laptop · Codex"), "the name stays out of console output");
  assert.ok(/^[\x00-\x7f]*$/.test(text), "the report is plain ASCII, which every console shows as written"); assert.match(text, /Device: +laptop/); assert.match(text, /Expires: +2027-01-02/);
  assert.match(text, /Skill: +missing/); assert.match(text, /Fix: +node agentrelay\.mjs skill --connection c1/);
  assert.match(verifySummary({ connection: { id: "c2", name: "x", deviceId: null, expiresAt: null }, workspace: { shared: true }, skill: { state: "not-bound" } }), /not bound to a device[\s\S]*shared[\s\S]*never/);
});

test("--agent picks the connection that agent uses on this device, and nothing else", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.home, { recursive: true });
    fs.writeFileSync(path.join(f.home, "connections.json"), JSON.stringify({ version: 1, active: { codex: "c-codex", antigravity: "c-agy" },
      connections: { "c-codex": { id: "c-codex", profile: "codex" }, "c-agy": { id: "c-agy", profile: "antigravity" } } }));
    assert.equal(agentConnection("antigravity", { home: f.home, userHome: f.root }), "c-agy");
    assert.equal(agentConnection("codex", { home: f.home, userHome: f.root }), "c-codex");
    assert.throws(() => agentConnection("claude-code", { home: f.home, userHome: f.root }), /No connection is set up for claude-code/);
    assert.throws(() => agentConnection("nobody", { home: f.home, userHome: f.root }), /Unknown agent profile/);
  } finally { f.close(); }
});

test("an image command's own error reaches the person instead of the generic failure", () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/agents/agentrelay.mjs", "download", "--agent", "codex", "not a handoff id"], { encoding: "utf8", cwd: projectRoot, env: { ...process.env, HOME: f.root, USERPROFILE: f.root } });
    assert.equal(result.status, 1); assert.match(result.stderr, /No connection is set up for codex/);
  } finally { f.close(); }
});
