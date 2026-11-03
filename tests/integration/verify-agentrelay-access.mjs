// Cloudflare Access identity over a built `cloudflare` Worker: which tokens it accepts, that Sites identity headers
// grant nothing, and that token agents work without a gateway header. Run through the local verification runner,
// which serves the test signing key and passes AGENTRELAY_TEST_ACCESS_KEY.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders, mintAccessToken, TEST_ACCESS_AUD } from "../support/test-identity.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Access checks only run against a local Worker.");
if (process.env.AGENTRELAY_TEST_TARGET !== "cloudflare") throw new Error("Access checks need a cloudflare build and the runner's test key.");
const key = process.env.AGENTRELAY_TEST_ACCESS_KEY;
const run = crypto.randomUUID(), owner = `access-qa-${run}`, stranger = `access-other-${run}`;
const passed = [], tokens = [], ids = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
const request = (path, method = "GET", data, headers = {}, format) => testRequest(base + path, { method,
  headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }, format ? { format } : {});
const as = token => ({ "cf-access-jwt-assertion": token });
const now = () => Math.floor(Date.now() / 1000);
const user = (claims = {}, header = {}) => mintAccessToken(key, { sub: owner, email: `${owner}@access.test`, ...claims }, header);
const web = (path, method, data, who = owner) => request(path, method, data, identityHeaders(who));
const rpc = (endpoint, headers, method, params) => request(endpoint, "POST", { jsonrpc: "2.0", id: 1, method, params }, headers);

try {
  const workspace = await request("/api/workspace", "GET", undefined, as(user()));
  check("a valid user token signs the person in", workspace.status === 200 && workspace.data.viewerName === `${owner}@access.test`);
  check("an unshared deployment reports the person's own id", workspace.data.shared === false && workspace.data.userId === owner);

  const sitesHeaders = { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": `${owner}@access.test` };
  const spoofed = await request("/api/workspace", "GET", undefined, sitesHeaders);
  check("Sites identity headers alone grant nothing", spoofed.status === 401 && spoofed.data.error === "Sign in first.");
  check("Sites identity headers cannot change who a valid token names",
    (await request("/api/workspace", "GET", undefined, { ...as(user()), "oai-authenticated-user-id": stranger })).data.userId === owner);
  check("no token answers 401 on API routes", (await request("/api/storage")).status === 401);

  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const rejected = {
    "another application": user({ aud: ["f".repeat(64)] }),
    "another team": user({ iss: "https://other-example-team.cloudflareaccess.com" }),
    "an expired token": user({ iat: now() - 7200, nbf: now() - 7200, exp: now() - 3600 }),
    "a token not valid yet": user({ nbf: now() + 3600 }),
    "a service token": user({ sub: "", email: undefined, common_name: "service.access" }),
    "a token signed by another key": mintAccessToken(otherKey, { sub: owner, email: `${owner}@access.test` }),
    "an unknown key id": user({}, { kid: "unknown-key" }),
    "a non-RS256 token": user({}, { alg: "HS256" }),
    "a malformed token": "not.a.token",
  };
  for (const [name, token] of Object.entries(rejected)) check(`${name} is rejected`, (await request("/api/workspace", "GET", undefined, as(token))).status === 401);
  check("a token for this application among several audiences is accepted",
    (await request("/api/workspace", "GET", undefined, as(user({ aud: ["e".repeat(64), TEST_ACCESS_AUD] })))).status === 200);

  const page = await request("/", "GET", undefined, {}, "text");
  check("the page without a token shows the sign-in notice", page.status === 200 && page.text.includes("Sign-in required"));
  const app = await request("/", "GET", undefined, as(user()), "text");
  check("the page with a token renders the app", app.status === 200 && app.text.includes("AgentRelay") && !app.text.includes("Sign-in required"));

  // Records stay with the person the token names.
  assert.equal((await web("/api/devices", "POST", { name: "Access laptop", id: "access-laptop" })).status, 201);
  check("another person's token sees none of the owner's devices", (await web("/api/devices", "GET", undefined, stranger)).data.devices.length === 0);

  // Native MCP signs in with the Access token, like a Managed OAuth client after Access resolves its token.
  const native = await rpc("/mcp", as(user()), "tools/call", { name: "create_handoff", arguments: {
    title: "Access check", content: "## Task Context\nSynthetic.", sourceDevice: "access-laptop", targetDevice: "access-laptop", requestKey: `access-${run}` } });
  const created = JSON.parse(native.data.result.content[0].text);
  ids.push(created.id);
  check("native /mcp works with an Access token", native.status === 200 && created.status === "ready");
  // Discovery (initialize, tools/list) needs no person, as on Sites; Access gates the route itself. Tool calls do.
  const nativeAnonymous = await rpc("/mcp", {}, "tools/call", { name: "list_handoffs", arguments: { device: "access-laptop" } });
  check("a native /mcp tool call without a token is refused", nativeAnonymous.data?.result?.isError === true
    && nativeAnonymous.data.result.structuredContent.error.status === 401);

  // Token agents need no gateway header: the Agent Token alone authenticates /api/agent/*.
  const issued = (await web("/api/agent-tokens", "POST", { name: "Access agent", deviceId: "access-laptop", expiresInDays: 1 })).data;
  tokens.push(issued.id);
  const probe = await request("/api/agent/connection");
  check("the agent API answers AgentRelay's own 401 without a token", probe.status === 401 && probe.data.error === "A valid personal Agent Token is required.");
  const connection = await request("/api/agent/connection", "GET", undefined, { Authorization: `Bearer ${issued.token}` });
  check("an Agent Token alone reaches the agent API", connection.status === 200);
  const listed = await rpc("/api/agent/mcp", { Authorization: `Bearer ${issued.token}` }, "tools/call", { name: "list_handoffs", arguments: { device: "access-laptop", status: "ready" } });
  check("the agent sees the handoff created through native MCP", JSON.parse(listed.data.result.content[0].text).handoffs.some(item => item.id === created.id));
  check("an Access token does not authenticate the agent API", (await rpc("/api/agent/mcp", as(user()), "tools/list")).data?.result?.isError === true);

  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  for (const id of ids) await web(`/api/handoffs/${id}`, "DELETE");
  for (const id of tokens) await web(`/api/agent-tokens/${id}`, "DELETE");
  for (const device of (await web("/api/devices")).data?.devices ?? []) await web(`/api/devices/${device.id}`, "DELETE", { version: device.version, connections: "unbind" });
}
