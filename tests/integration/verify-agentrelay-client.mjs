// Exercise the distributed Node client with a disposable OS home, real OS vault entries and synthetic local credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { systemStore, credentialRefs } from "../../tooling/agents/credential-store.mjs";
import { flat } from "../support/image-fixtures.mjs";
import yaml from "js-yaml";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5190";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Client checks require a local Worker.");
const clientRoot = path.resolve(process.env.AGENTRELAY_CLIENT_ROOT ?? projectRoot), run = crypto.randomUUID(), owner = `client-${run}`;
const parent = path.join(projectRoot, "outputs/client-verification"); mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(path.join(parent, "run-")), userHome = path.join(fixture, "user"), output = [], issued = [];
mkdirSync(userHome);
const childEnv = { ...process.env, USERPROFILE: userHome, HOME: userHome, DSH_HOME: "" }, endpoint = `${base}/api/agent/mcp`;
const vault = await systemStore(), ownHeaders = { "oai-authenticated-user-id": owner, "Content-Type": "application/json", Connection: "close" };
const check = (name, value) => { assert.ok(value, name); output.push(name); };
async function request(url, method = "GET", input, headers = ownHeaders) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(base + url, { method, headers, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    // Cleanup revocation/removal is idempotent. No ambiguous creation or other write is repeated.
    if (["GET", "DELETE"].includes(method) && response.status === 503 && text.includes("worker restarted mid-request") && attempt < 2) continue;
    return { status: response.status, data: JSON.parse(text) };
  }
}
function client(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { env: childEnv, cwd: fixture, encoding: "utf8", input, timeout: 45_000, windowsHide: true });
  assert.equal(result.error, undefined, "client process finishes within its deadline");
  return result;
}
try {
  const profiles = ["claude-code", "codex", "antigravity", "deepseek-harness"], bridgeOnly = ["antigravity", "deepseek-harness"];
  for (const profile of profiles) {
    const { status, data } = await request("/api/agent-tokens", "POST", { name: `Client ${profile}`, expiresInDays: null, acknowledgePermanentRisk: true });
    assert.equal(status, 201); issued.push(data);
    const configured = client(path.join(clientRoot, "scripts/agents/agentrelay.mjs"), ["connect", "--profile", profile, "--connection", data.id, "--url", endpoint, "--transport", bridgeOnly.includes(profile) ? "bridge" : "direct", "--stdin"], JSON.stringify({ agentToken: data.token, gatewayToken: "synthetic-local-gateway" }));
    check(`${profile}: distributed connect succeeds outside the checkout`, configured.status === 0);
    check(`${profile}: setup output contains no credential`, !configured.stdout.includes(data.token) && !configured.stderr.includes(data.token) && !configured.stdout.includes("synthetic-local-gateway"));
  }
  const launcher = path.join(userHome, ".agentrelay/client/agentrelay.mjs");
  const manifest = JSON.parse(readFileSync(path.join(userHome, ".agentrelay/connections.json"), "utf8"));
  check("each agent has an independent credential reference", new Set(Object.values(manifest.connections).map(r => r.credentialRef)).size === profiles.length);
  check("one Site shares one gateway reference", new Set(Object.values(manifest.connections).map(r => r.gatewayRef)).size === 1);
  const headerResult = client(launcher, ["headers", "--connection", issued[1].id]);
  assert.equal(headerResult.status, 0); const headers = JSON.parse(headerResult.stdout);
  const rpc = async (name, args) => {
    const response = await fetch(endpoint, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(20_000) });
    const data = await response.json(); assert.ok(!data.result.isError, "MCP operation succeeds"); return JSON.parse(data.result.content[0].text);
  };
  check("header helper emits only a JSON header map", Object.keys(headers).sort().join() === "Authorization,OAI-Sites-Authorization");
  const wire = client(launcher, ["bridge", "--connection", issued[2].id], JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  check("installed bridge reads OS credentials and lists all five tools", wire.status === 0 && JSON.parse(wire.stdout).result.tools.length === 5 && !wire.stderr);
  // Start exactly the command DeepSeek Harness would, as written into its patch file.
  const dshRow = yaml.load(readFileSync(path.join(userHome, ".dsh/cordis.patch.yml"), "utf8")).flatMap(item => item.insert ?? [item]).find(row => row.id === "mcp-agentrelay").config;
  const dsh = spawnSync(dshRow.command, dshRow.args, { env: childEnv, cwd: fixture, encoding: "utf8", input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", timeout: 45_000, windowsHide: true });
  check("the DeepSeek Harness patch row starts the installed bridge and lists all five tools", dsh.status === 0 && JSON.parse(dsh.stdout).result.tools.length === 5 && !dsh.stderr);
  // dsh registers none of a server's tools when one parameter schema leaves its subset.
  const core = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
  const keys = node => !node || typeof node !== "object" ? [] : [...Object.keys(node), ...Object.values(node.properties ?? {}).flatMap(keys), ...keys(node.items), ...(node.oneOf ?? []).flatMap(keys)];
  check("its tool parameter schemas stay inside DeepSeek Harness's JSON Schema subset", JSON.parse(dsh.stdout).result.tools.every(tool => keys(tool.inputSchema).every(key => core.has(key))));
  // dsh probes server/discover first; the bridge refuses it so dsh's SDK falls back to initialize.
  const probe = spawnSync(dshRow.command, dshRow.args, { env: childEnv, cwd: fixture, encoding: "utf8", input: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "server/discover" }) + "\n", timeout: 45_000, windowsHide: true });
  check("its bridge refuses server/discover so DeepSeek Harness uses initialize", probe.status === 0 && JSON.parse(probe.stdout).error?.code === -32601);
  const file = path.join(fixture, "test.png"), bytes = await flat({ format: "png", width: 16, height: 16 }); writeFileSync(file, bytes);
  const upload = client(launcher, ["upload", "--connection", issued[1].id, file]); assert.equal(upload.status, 0);
  const attachmentIds = JSON.parse(upload.stdout).attachmentIds;
  const handoff = await rpc("create_handoff", { title: "Client image", sourceDevice: "Desk", targetDevice: "Laptop", content: "Synthetic client test", requestKey: run, attachmentIds });
  const download = client(launcher, ["download", "--connection", issued[1].id, "--out", path.join(fixture, "images"), handoff.id]); assert.equal(download.status, 0);
  const downloaded = JSON.parse(download.stdout);
  const imageFile = downloaded.files[0].path;
  check("installed upload/download preserve exact image bytes outside the checkout", readFileSync(imageFile).equals(Buffer.from(bytes)));
  await request(`/api/handoffs/${handoff.id}`, "DELETE");
  await request(`/api/agent-tokens/${issued[0].id}`, "DELETE");
  for (const data of issued.slice(1)) check("other installed connections remain usable", client(launcher, ["verify", "--connection", data.id]).status === 0);
  check("revoking one connection blocks that installed client", client(launcher, ["verify", "--connection", issued[0].id]).status === 1);
} finally {
  for (const item of issued) {
    await request(`/api/agent-tokens/${item.id}`, "DELETE"); await request(`/api/agent-tokens/${item.id}?permanent=1`, "DELETE");
    const refs = credentialRefs(base, item.id); vault.remove(refs.agent); vault.remove(refs.gateway);
  }
  // Only this operation's unique fixture is removed, inside its verified output parent.
  assert.ok(path.resolve(fixture).startsWith(path.resolve(parent) + path.sep)); rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: output.length, checks: output }, null, 2));
