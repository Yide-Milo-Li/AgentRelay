import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { createBridge } from "../../tooling/agents/mcp-bridge.mjs";

const TOKEN = `agentrelay_${"a".repeat(64)}`;
const GATEWAY = "synthetic-gateway-secret";
const ENDPOINT = "https://relay.example.com/api/agent/mcp";

const reply = (body, status = 200) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
function bridgeWith(fetchImpl) {
  const written = [];
  const bridge = createBridge({ endpoint: ENDPOINT, agentToken: TOKEN, gatewayToken: GATEWAY, fetchImpl, write: (message) => written.push(message) });
  return { bridge, written };
}

test("a request is forwarded with both credentials and the site's answer is relayed unchanged", async () => {
  let sent;
  const { bridge, written } = bridgeWith(async (url, init) => { sent = { url, init }; return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "create_handoff" }] } }) }; });
  await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
  assert.equal(sent.url, ENDPOINT);
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.init.headers["OAI-Sites-Authorization"], `Bearer ${GATEWAY}`);
  assert.equal(sent.init.headers.Origin, undefined, "no Origin header: terminal clients must omit it");
  assert.deepEqual(JSON.parse(sent.init.body), { jsonrpc: "2.0", id: 7, method: "tools/list" });
  assert.deepEqual(written, [{ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "create_handoff" }] } }]);
});

test("core schemas reduce tools/list parameters to the subset and keep each dropped bound in the description", async () => {
  const schema = { type: "object", additionalProperties: false, required: ["title"], properties: {
    title: { type: "string", description: "Title." },
    expiresInDays: { type: "integer", minimum: 1, maximum: 365, description: "Lifetime." },
    attachmentIds: { type: "array", maxItems: 10, items: { type: "string", pattern: "^[a-f0-9]+$" } },
  } };
  const site = { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "create_handoff", inputSchema: schema, annotations: { readOnlyHint: false } }] } };
  const core = bridgeWith(reply(site));
  core.bridge = createBridge({ endpoint: ENDPOINT, agentToken: TOKEN, gatewayToken: GATEWAY, fetchImpl: reply(site), coreSchemas: true, write: (message) => core.written.push(message) });
  await core.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  const reduced = core.written[0].result.tools[0];
  assert.deepEqual(reduced.inputSchema, { type: "object", additionalProperties: false, required: ["title"], properties: {
    title: { type: "string", description: "Title." },
    expiresInDays: { type: "integer", description: "Lifetime. (minimum 1, maximum 365)" },
    attachmentIds: { type: "array", description: "(maxItems 10)", items: { type: "string", description: "(pattern ^[a-f0-9]+$)" } },
  } });
  assert.deepEqual(reduced.annotations, { readOnlyHint: false });
  // Other replies and bridges without the option are relayed unchanged.
  const plain = bridgeWith(reply(site));
  await plain.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  assert.deepEqual(plain.written[0], site);
  const call = { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "{}" }] } };
  core.bridge = createBridge({ endpoint: ENDPOINT, agentToken: TOKEN, gatewayToken: GATEWAY, fetchImpl: reply(call), coreSchemas: true, write: (message) => core.written.push(message) });
  await core.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_handoffs" } }));
  assert.deepEqual(core.written[1], call);
});

test("initialize-only refuses server/discover locally and forwards everything else", async () => {
  const sent = [], written = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).method); return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) }; };
  const bridge = createBridge({ endpoint: ENDPOINT, agentToken: TOKEN, gatewayToken: GATEWAY, fetchImpl, initializeOnly: true, write: (message) => written.push(message) });
  await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: "probe-1", method: "server/discover" }));
  await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
  assert.deepEqual(sent, ["initialize"]);
  assert.deepEqual(written[0], { jsonrpc: "2.0", id: "probe-1", error: { code: -32601, message: "Method not found" } });
  // Without the option discovery reaches the Site as before.
  const plain = bridgeWith(async (url, init) => { sent.push(JSON.parse(init.body).method); return { status: 200, text: async () => "{}" }; });
  await plain.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: "probe-2", method: "server/discover" }));
  assert.equal(sent.at(-1), "server/discover");
});

test("a notification is forwarded and produces no output", async () => {
  let calls = 0;
  const { bridge, written } = bridgeWith(async () => { calls++; return { status: 202, text: async () => "" }; });
  await bridge.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(calls, 1);
  assert.deepEqual(written, []);
});

test("client replies, blank lines and batches never reach the site", async () => {
  let calls = 0;
  const { bridge, written } = bridgeWith(async () => { calls++; return { status: 200, text: async () => "{}" }; });
  await bridge.handle("");
  await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  await bridge.handle(JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "ping" }]));
  await bridge.handle("not json");
  assert.equal(calls, 0);
  assert.deepEqual(written.map((message) => message.error.code), [-32600, -32700]);
});

test("refusals become protocol errors that say what to check, without echoing the response", async () => {
  for (const [status, expected] of [[401, /credentials \(401\)/], [403, /\(403\)/], [413, /too large/]]) {
    const { bridge, written } = bridgeWith(reply({ jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text: "secret-detail" }] } }, status));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }));
    assert.equal(written[0].id, 3);
    assert.match(written[0].error.message, expected);
    assert.equal(JSON.stringify(written).includes("secret-detail"), false);
  }
});

test("an HTML login page and a network failure are explained, and neither leaks a credential", async () => {
  const html = bridgeWith(reply("<html>Sign in</html>", 200));
  await html.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
  assert.match(html.written[0].error.message, /without MCP data.*gateway token/);

  const down = bridgeWith(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
  await down.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
  assert.match(down.written[0].error.message, /Cannot reach the AgentRelay site \(ENOTFOUND\)/);
  assert.equal(JSON.stringify([html.written, down.written]).match(new RegExp(`${TOKEN}|${GATEWAY}`)), null);
});

test("idle waits for requests that are still in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { bridge, written } = bridgeWith(async () => { await gate; return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 6, result: {} }) }; });
  void bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }));
  let idle = false;
  const waiting = bridge.idle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false);
  release();
  await waiting;
  assert.equal(written.length, 1);
});

test("the bridge process speaks newline-delimited JSON-RPC and exits when its input closes", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const message = JSON.parse(raw);
      seen.push({ auth: request.headers.authorization, gateway: request.headers["oai-sites-authorization"], origin: request.headers.origin, method: message.method });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.execPath, ["scripts/agents/mcp-bridge.mjs"], {
    cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTRELAY_MCP_URL: `http://127.0.0.1:${server.address().port}/api/agent/mcp`, AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: GATEWAY },
  });
  const outputs = [];
  createInterface({ input: child.stdout }).on("line", (line) => outputs.push(JSON.parse(line)));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.deepEqual(outputs.map((message) => [message.id, message.result.echoed]).sort(), [[1, "initialize"], [2, "tools/list"]]);
    assert.equal(seen.length, 3);
    for (const call of seen) assert.deepEqual([call.auth, call.gateway, call.origin], [`Bearer ${TOKEN}`, `Bearer ${GATEWAY}`, undefined]);
    assert.equal(stderr, "", "nothing is written to stderr during normal use");
  } finally {
    child.kill();
    server.close();
  }
});

test("the bridge refuses to start without a site URL or credentials, and says which is missing", async () => {
  const run = async (env) => {
    const child = spawn(process.execPath, ["scripts/agents/mcp-bridge.mjs"], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let stderr = "", stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    return { code, stderr, stdout };
  };
  const noUrl = await run({ AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: GATEWAY });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.stderr, /set AGENTRELAY_MCP_URL/);
  const noGateway = await run({ AGENTRELAY_MCP_URL: ENDPOINT, AGENTRELAY_AGENT_TOKEN: TOKEN });
  assert.equal(noGateway.code, 1);
  assert.match(noGateway.stderr, /Set AGENTRELAY_SITES_GATEWAY_TOKEN/);
  const plainHttp = await run({ AGENTRELAY_MCP_URL: "http://relay.example.com/api/agent/mcp", AGENTRELAY_AGENT_TOKEN: TOKEN, AGENTRELAY_SITES_GATEWAY_TOKEN: GATEWAY });
  assert.match(plainHttp.stderr, /HTTPS/);
  for (const result of [noUrl, noGateway, plainHttp]) assert.equal(result.stdout, "", "stdout stays empty on failure");
});
