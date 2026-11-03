import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { agentHeaders, agentTokenFrom, gatewayAuthorization, prepareFiles, uploadImages } from "../../tooling/agents/upload-attachments.mjs";
import { flat } from "../support/image-fixtures.mjs";

const TOKEN = `agentrelay_${"a".repeat(64)}`;
const SITE = "https://agentrelay.example.chatgpt.site";

test("gateway authorization accepts Codex's whole header or a bare token, and is absent without either", () => {
  assert.equal(gatewayAuthorization({ AGENTRELAY_SITES_GATEWAY_HEADER: "Bearer abc", AGENTRELAY_SITES_GATEWAY_TOKEN: "ignored" }), "Bearer abc");
  assert.equal(gatewayAuthorization({ AGENTRELAY_SITES_GATEWAY_TOKEN: "abc" }), "Bearer abc");
  assert.equal(gatewayAuthorization({ AGENTRELAY_SITES_GATEWAY_TOKEN: " " }), null);
  assert.equal(gatewayAuthorization({}), null);
  assert.deepEqual(agentHeaders("t", null), { Authorization: "Bearer t" });
  assert.deepEqual(agentHeaders("t", "Bearer g"), { Authorization: "Bearer t", "OAI-Sites-Authorization": "Bearer g" });
});

test("the Agent Token must be set and current", () => {
  assert.equal(agentTokenFrom({ AGENTRELAY_AGENT_TOKEN: TOKEN }), TOKEN);
  assert.throws(() => agentTokenFrom({}), /AGENTRELAY_AGENT_TOKEN/);
  assert.throws(() => agentTokenFrom({ AGENTRELAY_AGENT_TOKEN: `relay_agent_${"a".repeat(64)}` }), /retired/);
});

test("every file is checked before any upload starts", async () => {
  const good = await flat({ format: "png" });
  const reads = { "good.png": good, "bad.png": new TextEncoder().encode("not an image") };
  const read = async file => { if (!(file in reads)) throw Object.assign(new Error("x"), { code: "ENOENT" }); return reads[file]; };
  let fetched = 0;
  await assert.rejects(uploadImages({ files: ["good.png", "bad.png"], siteUrl: SITE, agentToken: TOKEN, authorization: "Bearer g", retryKey: "k", read, fetchImpl: async () => { fetched++; } }), /bad\.png: Only PNG, JPEG and WebP/);
  await assert.rejects(prepareFiles(["missing.png"], { read }), /Cannot read missing\.png \(ENOENT\)/);
  await assert.rejects(prepareFiles([], { read }), /at least one/);
  await assert.rejects(prepareFiles(Array.from({ length: 11 }, () => "good.png"), { read }), /at most 10/);
  assert.equal(fetched, 0);
});

test("uploads run in argument order with per-file retry keys and the required headers", async () => {
  const files = { "a.png": await flat({ format: "png", width: 3, height: 3 }), "b.webp": await flat({ format: "webp", width: 4, height: 4 }) };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: `id-${calls.length}`, filename: "x" }), { status: 201 });
  };
  const result = await uploadImages({ files: ["a.png", "b.webp"], siteUrl: SITE, agentToken: TOKEN, authorization: "Bearer gate", retryKey: "run1", read: async file => files[file], fetchImpl });
  assert.deepEqual(result.map(item => item.id), ["id-1", "id-2"]);
  assert.equal(calls[0].url, `${SITE}/api/agent/attachments`);
  assert.deepEqual(calls.map(call => call.init.headers["X-Upload-Key"]), ["run1-0", "run1-1"]);
  assert.deepEqual(calls.map(call => call.init.headers["Content-Type"]), ["image/png", "image/webp"]);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["OAI-Sites-Authorization"], "Bearer gate");
  assert.equal(calls[1].init.headers["X-Filename"], "b.webp");
});

test("server and gateway refusals are reported without echoing a credential", async () => {
  const read = async () => await flat({ format: "png" });
  const run = fetchImpl => uploadImages({ files: ["a.png"], siteUrl: SITE, agentToken: TOKEN, authorization: "Bearer secret-gateway", retryKey: "k", read, fetchImpl });
  await assert.rejects(run(async () => new Response(JSON.stringify({ error: "The image is 5 bytes over." }), { status: 413 })), /a\.png: The image is 5 bytes over\./);
  await assert.rejects(run(async () => new Response("<html>login</html>", { status: 200 })), /without upload data/);
  const refused = await run(async () => new Response("", { status: 401 })).catch(error => error.message);
  assert.match(refused, /refused the credentials \(401\)/);
  assert.equal(refused.includes(TOKEN) || refused.includes("secret-gateway"), false);
  const unreachable = await run(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }).catch(error => error.message);
  assert.match(unreachable, /ECONNREFUSED/);
  assert.equal(unreachable.includes(TOKEN), false);
});

test("the command prints JSON only on success and never prints credentials on failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-upload-"));
  try {
    const image = path.join(dir, "shot.png");
    fs.writeFileSync(image, await flat({ format: "png" }));
    const env = { ...process.env, AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: "synthetic-gateway-secret", AGENTRELAY_MCP_URL: "http://127.0.0.1:9/api/agent/mcp" };
    const result = spawnSync(process.execPath, ["scripts/agents/upload-attachments.mjs", image], { cwd: projectRoot, encoding: "utf8", env });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot reach the AgentRelay site/);
    assert.equal((result.stdout + result.stderr).includes(TOKEN) || (result.stdout + result.stderr).includes("synthetic-gateway-secret"), false);
    const missing = spawnSync(process.execPath, ["scripts/agents/upload-attachments.mjs", image], { cwd: projectRoot, encoding: "utf8", env: { ...env, AGENTRELAY_AGENT_TOKEN: "" } });
    assert.match(missing.stderr, /AGENTRELAY_AGENT_TOKEN/);
    const usage = spawnSync(process.execPath, ["scripts/agents/upload-attachments.mjs", "--bogus"], { cwd: projectRoot, encoding: "utf8", env });
    assert.match(usage.stderr, /usage:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
