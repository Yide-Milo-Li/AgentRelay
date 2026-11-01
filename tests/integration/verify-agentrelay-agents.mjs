// These checks use the built local Worker and isolated owners, never production.
import assert from "node:assert/strict";
import { execTestFile } from "../support/integration-process.mjs";
import { executeLocalSql } from "../support/local-storage-fixtures.mjs";
import { testRequest } from "../support/integration-http.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Agent checks require a local database.");
const run = crypto.randomUUID(), owner = `agent-qa-${run}`, stranger = `agent-other-${run}`;
const ids = [], passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
async function request(path, method = "GET", data, headers = {}) {
  return testRequest(base + path, { method, headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const identity = user => ({ "oai-authenticated-user-id": user });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const manage = (method = "GET", data, user = owner, extra = {}, path = "") => request(`/api/agent-tokens${path}`, method, data, { ...identity(user), ...extra });
const rpc = (name, args, headers, method = "tools/call") => request("/api/agent/mcp", "POST", { jsonrpc: "2.0", id: 1, method, ...(method === "tools/call" ? { params: { name, arguments: args } } : {}) }, headers);
function result(response) { assert.equal(response.status, 200); assert.ok(!response.data.result.isError, response.data.result.content?.[0]?.text); return JSON.parse(response.data.result.content[0].text); }
const sql = async command => JSON.stringify(await executeLocalSql(command));
try {
  check("anonymous token creation rejected", (await request("/api/agent-tokens", "POST", { name: "x" })).status === 401);
  check("cross-origin token creation rejected", (await manage("POST", { name: "x" }, owner, { Origin: "https://untrusted.example" })).status === 403);
  check("empty token name rejected", (await manage("POST", { name: " " })).status === 400);
  check("invalid token lifetime rejected", (await manage("POST", { name: "x", expiresInDays: 366 })).status === 400);
  const issued = await manage("POST", { name: "Laptop", expiresInDays: 1 });
  const a = issued.data, b = (await manage("POST", { name: "Other" }, stranger)).data;
  check("256-bit personal credential issued once", issued.status === 201 && /^agentrelay_[a-f0-9]{64}$/.test(a.token));
  const listing = await manage();
  check("token listing omits plaintext, digest and owner identifiers", listing.data.tokens.length === 1 && !/tokenHash|token_hash|ownerId|agentrelay_/.test(JSON.stringify(listing.data)));
  check("another owner sees only their credential", (await manage("GET", undefined, stranger)).data.tokens.every(t => t.id !== a.id));
  check("another owner cannot revoke credential", (await manage("DELETE", undefined, stranger, {}, `/${a.id}`)).status === 404);
  check("cross-origin revocation rejected", (await manage("DELETE", undefined, owner, { Origin: "https://untrusted.example" }, `/${a.id}`)).status === 403);
  check("personal token cannot mint more credentials", (await request("/api/agent-tokens", "POST", { name: "forbidden" }, bearer(a.token))).status === 401);
  check("personal token cannot list credential metadata", (await request("/api/agent-tokens", "GET", undefined, bearer(a.token))).status === 401);
  check("personal token cannot revoke credentials", (await request(`/api/agent-tokens/${a.id}`, "DELETE", undefined, bearer(a.token))).status === 401);
  check("anonymous MCP initialization rejected", (await rpc(null, null, {}, "initialize")).status === 401);
  check("platform identity alone cannot access Agent endpoint", (await rpc(null, null, identity(owner), "tools/list")).status === 401);
  check("malformed personal token rejected", (await rpc(null, null, bearer("agentrelay_invalid"), "initialize")).status === 401);
  check("unknown well-formed personal token rejected", (await rpc(null, null, bearer(`agentrelay_${"0".repeat(64)}`), "initialize")).status === 401);
  const initialized = await rpc(null, null, bearer(a.token), "initialize");
  check("authenticated MCP initialization succeeds", initialized.data.result.protocolVersion === "2025-11-25");
  // The Agent endpoint serves the initialize flow only; advertising Sites' stateless era would divert newer SDKs.
  const discovery = await rpc(null, null, bearer(a.token), "server/discover");
  check("Agent endpoint does not advertise the stateless era", discovery.status === 200 && discovery.data.error?.code === -32601 && discovery.data.result === undefined);
  check("anonymous Agent discovery is still rejected", (await rpc(null, null, {}, "server/discover")).status === 401);
  const notification = await request("/api/agent/mcp", "POST", { jsonrpc: "2.0", method: "notifications/initialized" }, bearer(a.token));
  check("notification accepted without response body", notification.status === 202 && notification.data === null);
  check("same five tools available to external agents", (await rpc(null, null, bearer(a.token), "tools/list")).data.result.tools.length === 5);
  if (process.env.AGENTRELAY_TEST_CLAUDE === "1") {
    // The real CLI receives the secret through its environment, never argv/output.
    const cliEnv = { ...process.env, CLAUDE_CONFIG_DIR: `${process.cwd()}/.sites-runtime/agent-cli/${run}`, AGENTRELAY_AGENT_TOKEN: a.token };
    const config = { type: "http", url: `${base}/api/agent/mcp`, headers: { Authorization: "Bearer ${AGENTRELAY_AGENT_TOKEN}" } };
    await execTestFile("claude", ["mcp", "add-json", "agentrelay-agent-test", JSON.stringify(config)], { env: cliEnv, stdio: "pipe", timeout: 30000 });
    const connected = (await execTestFile("claude", ["mcp", "list"], { env: cliEnv, stdio: "pipe", timeout: 30000 })).toString();
    check("real Claude Code CLI connects to authenticated Agent MCP", connected.includes("Connected"));
  }
  check("cross-origin agent writes rejected", (await rpc("list_handoffs", {}, { ...bearer(a.token), Origin: "https://untrusted.example" })).status === 403);
  check("request size limit retained", (await rpc("create_handoff", { content: "x".repeat(1250001) }, bearer(a.token))).status === 413);
  const content = "# 双向接力\r\n  原文与缩进 🚀\n```sh\necho '$VALUE'\n```\n<script>not executable</script>\n";
  const input = { title: "Desktop → Laptop", content, project: "Agent QA", sourceDevice: "台式机", targetDevice: "笔记本", requestKey: run };
  const web = await request("/api/handoffs", "POST", input, identity(owner)); ids.push(web.data.id);
  const listed = result(await rpc("list_handoffs", { status: "ready", targetDevice: "笔记本" }, bearer(a.token)));
  check("desktop handoff visible to laptop personal token", listed.handoffs.length === 1 && listed.handoffs[0].id === web.data.id);
  check("full original text preserved across transports", result(await rpc("get_handoff", { id: web.data.id }, bearer(a.token))).content === content);
  check("other owner cannot read original", (await rpc("get_handoff", { id: web.data.id }, bearer(b.token))).data.result.structuredContent.error.status === 404);
  check("caller-supplied identity cannot override token owner", result(await rpc("list_handoffs", {}, { ...bearer(b.token), ...identity(owner) })).handoffs.length === 0);
  check("other owner cannot claim", (await rpc("claim_handoff", { id: web.data.id, device: "笔记本", version: 1 }, bearer(b.token))).data.result.structuredContent.error.status === 404);
  check("claim requires explicit version", (await rpc("claim_handoff", { id: web.data.id, device: "笔记本" }, bearer(a.token))).data.result.isError === true);
  const claims = await Promise.all([rpc("claim_handoff", { id: web.data.id, device: "笔记本", version: 1 }, bearer(a.token)), request(`/api/handoffs/${web.data.id}`, "PATCH", { status: "claimed", device: "台式机", version: 1 }, identity(owner))]);
  check("only one receiver wins across both transports", Number(!claims[0].data.result.isError) + Number(claims[1].status === 200) === 1);
  check("stale completion conflicts", (await rpc("complete_handoff", { id: web.data.id, version: 1 }, bearer(a.token))).data.result.structuredContent.error.status === 409);
  check("laptop can complete desktop handoff", result(await rpc("complete_handoff", { id: web.data.id, version: 2 }, bearer(a.token))).status === "done");
  const back = { ...input, title: "Laptop → Desktop", sourceDevice: "笔记本", targetDevice: "台式机", requestKey: `${run}-back` };
  const sent = result(await rpc("create_handoff", back, bearer(a.token))); ids.push(sent.id);
  check("laptop sends back to same platform owner", (await request(`/api/handoffs/${sent.id}`, "GET", undefined, identity(owner))).data.content === content);
  check("agent create retries are idempotent", result(await rpc("create_handoff", back, bearer(a.token))).id === sent.id);
  check("changed retry payload conflicts", (await rpc("create_handoff", { ...back, content: "changed" }, bearer(a.token))).data.result.structuredContent.error.status === 409);
  const strangers = result(await rpc("create_handoff", back, bearer(b.token)));
  check("other owner has separate idempotency namespace", strangers.id !== sent.id && !("ownerId" in strangers)
    && result(await rpc("get_handoff", { id: strangers.id }, bearer(b.token))).id === strangers.id
    && (await rpc("get_handoff", { id: strangers.id }, bearer(a.token))).data.result.structuredContent.error.status === 404);
  const desktopClaim = await request(`/api/handoffs/${sent.id}`, "PATCH", { status: "claimed", device: "台式机", version: 1 }, identity(owner));
  const desktopDone = await request(`/api/handoffs/${sent.id}`, "PATCH", { status: "done", version: desktopClaim.data.version }, identity(owner));
  check("desktop completes laptop handoff", desktopDone.data.status === "done");
  await sql(`UPDATE handoffs SET expires_at = 1 WHERE id = '${sent.id}' AND owner_id = '${owner}';`);
  check("personal token cannot read expired handoffs", (await rpc("get_handoff", { id: sent.id }, bearer(a.token))).data.result.structuredContent.error.status === 404);
  check("personal token cannot list expired handoffs", !result(await rpc("list_handoffs", {}, bearer(a.token))).handoffs.some(row => row.id === sent.id));
  // Expiry is advanced only in this test owner's local D1 row, never via a debug API.
  await sql(`UPDATE agent_tokens SET expires_at = 1 WHERE id = '${a.id}' AND owner_id = '${owner}';`);
  check("expired credential rejected", (await rpc(null, null, bearer(a.token), "initialize")).status === 401);
  await manage("DELETE", undefined, stranger, {}, `/${b.id}`);
  check("revocation rejects subsequent initialization", (await rpc(null, null, bearer(b.token), "initialize")).status === 401);
  check("revocation rejects subsequent tool calls", (await rpc("list_handoffs", {}, bearer(b.token))).status === 401);
  const storage = await sql(`SELECT token_hash FROM agent_tokens WHERE id = '${a.id}';`);
  const expectedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.token))).toString("hex");
  check("D1 stores only the SHA-256 digest", storage.includes(expectedHash) && !storage.includes(a.token));

  // Connections: device binding, rename, idempotent revoke, permanent removal and the list limits.
  const dev = (method, path = "", data, user = owner) => request(`/api/devices${path}`, method, data, identity(user));
  await dev("POST", "", { name: "Home desktop", id: "home" });
  await dev("POST", "", { name: "Away laptop", id: "away" });
  await dev("POST", "", { name: "Secret box", id: "secret-box" }, stranger);
  check("a connection cannot bind an unknown device", (await manage("POST", { name: "Ghost", deviceId: "ghost" })).status === 404);
  check("a connection cannot bind another owner's device", (await manage("POST", { name: "Foreign", deviceId: "secret-box" })).status === 404);
  check("a non-string deviceId is rejected", (await manage("POST", { name: "Bad", deviceId: 7 })).status === 400);
  const bound = (await manage("POST", { name: "Home Claude", deviceId: "home", expiresInDays: 30 })).data;
  check("a connection can be bound to a device at creation", bound.deviceId === "home" && /^agentrelay_[a-f0-9]{64}$/.test(bound.token));
  const loose = (await manage("POST", { name: "Loose" })).data;
  check("a connection without a device has a null binding", loose.deviceId === null);
  check("the listing exposes device bindings", (await manage()).data.tokens.find(token => token.id === bound.id)?.deviceId === "home");
  check("cross-origin rename rejected", (await manage("PATCH", { name: "x" }, owner, { Origin: "https://untrusted.example" }, `/${bound.id}`)).status === 403);
  check("another owner cannot rename a connection", (await manage("PATCH", { name: "x" }, stranger, {}, `/${bound.id}`)).status === 404);
  check("personal token cannot rename connections", (await request(`/api/agent-tokens/${bound.id}`, "PATCH", { name: "x" }, bearer(bound.token))).status === 401);
  check("an empty connection name is rejected", (await manage("PATCH", { name: " " }, owner, {}, `/${bound.id}`)).status === 400);
  check("an empty patch is rejected", (await manage("PATCH", {}, owner, {}, `/${bound.id}`)).status === 400);
  const renamed = await manage("PATCH", { name: "Home Claude Code" }, owner, {}, `/${bound.id}`);
  check("a connection can be renamed", renamed.status === 200 && renamed.data.name === "Home Claude Code" && renamed.data.deviceId === "home");
  check("a connection can be rebound", (await manage("PATCH", { deviceId: "away" }, owner, {}, `/${bound.id}`)).data.deviceId === "away");
  check("rebinding to an unknown device is 404", (await manage("PATCH", { deviceId: "ghost" }, owner, {}, `/${bound.id}`)).status === 404);
  check("rebinding to another owner's device is 404", (await manage("PATCH", { deviceId: "secret-box" }, owner, {}, `/${bound.id}`)).status === 404);
  check("a connection can be unbound", (await manage("PATCH", { deviceId: null }, owner, {}, `/${bound.id}`)).data.deviceId === null);
  await manage("PATCH", { deviceId: "home" }, owner, {}, `/${bound.id}`);
  check("binding a device never narrows what the token can do", Array.isArray(result(await rpc("list_handoffs", {}, bearer(bound.token))).handoffs));

  const firstRevoke = await manage("DELETE", undefined, owner, {}, `/${loose.id}`);
  const secondRevoke = await manage("DELETE", undefined, owner, {}, `/${loose.id}`);
  check("revoking is idempotent", firstRevoke.status === 200 && secondRevoke.status === 200 && firstRevoke.data.revokedAt !== null && secondRevoke.data.revokedAt === firstRevoke.data.revokedAt);
  check("a revoked connection cannot be renamed", (await manage("PATCH", { name: "Nope" }, owner, {}, `/${loose.id}`)).status === 409);
  check("a revoked connection cannot be rebound", (await manage("PATCH", { deviceId: "home" }, owner, {}, `/${loose.id}`)).status === 409);
  check("renaming a missing connection is 404", (await manage("PATCH", { name: "Nope" }, owner, {}, `/${crypto.randomUUID()}`)).status === 404);
  check("an active connection cannot be removed", (await manage("DELETE", undefined, owner, {}, `/${bound.id}?permanent=1`)).status === 409);
  check("removal leaves the active connection usable", (await rpc(null, null, bearer(bound.token), "initialize")).status === 200);
  check("another owner cannot remove a connection", (await manage("DELETE", undefined, stranger, {}, `/${loose.id}?permanent=1`)).status === 404);
  check("cross-origin removal rejected", (await manage("DELETE", undefined, owner, { Origin: "https://untrusted.example" }, `/${loose.id}?permanent=1`)).status === 403);
  check("personal token cannot remove connections", (await request(`/api/agent-tokens/${loose.id}?permanent=1`, "DELETE", undefined, bearer(bound.token))).status === 401);
  const removedLoose = await manage("DELETE", undefined, owner, {}, `/${loose.id}?permanent=1`);
  check("a revoked connection can be removed permanently", removedLoose.status === 200 && !(await manage()).data.tokens.some(token => token.id === loose.id));
  check("removing a removed connection is 404", (await manage("DELETE", undefined, owner, {}, `/${loose.id}?permanent=1`)).status === 404);

  // Retired rows must never push an active connection out of the list or count against the active limit.
  const stamp = Date.now();
  await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120) INSERT INTO agent_tokens (id, owner_id, name, token_hash, created_at, expires_at, revoked_at, device_id) SELECT 'retired-${run}-' || i, '${owner}', 'Retired ' || i, 'retired-hash-${run}-' || i, ${stamp + 60000} + i, CASE WHEN i % 2 = 0 THEN ${stamp + 86400000} ELSE 1000 END, CASE WHEN i % 2 = 0 THEN ${stamp} ELSE NULL END, NULL FROM n;`);
  const crowdedListing = (await manage()).data.tokens;
  const retiredShown = crowdedListing.filter(token => token.revokedAt !== null || token.expiresAt <= Date.now());
  check("120 retired connections do not hide an active one", crowdedListing.some(token => token.id === bound.id && token.revokedAt === null) && retiredShown.length === 100);
  check("active connections are listed before retired ones", crowdedListing.findIndex(token => token.id === bound.id) < crowdedListing.findIndex(token => retiredShown.includes(token)));
  check("retired connections do not block issuing a new one", (await manage("POST", { name: "Fresh" })).status === 201);
  const bulkNoScope = await manage("DELETE");
  check("bulk removal requires the inactive scope", bulkNoScope.status === 400);
  check("cross-origin bulk removal rejected", (await manage("DELETE", undefined, owner, { Origin: "https://untrusted.example" }, "?scope=inactive")).status === 403);
  check("personal token cannot bulk-remove connections", (await request("/api/agent-tokens?scope=inactive", "DELETE", undefined, bearer(bound.token))).status === 401);
  const bulk = await manage("DELETE", undefined, owner, {}, "?scope=inactive");
  const afterBulk = (await manage()).data.tokens;
  check("bulk removal deletes every retired connection and nothing else", bulk.status === 200 && bulk.data.removed >= 120 && afterBulk.every(token => token.revokedAt === null && token.expiresAt > Date.now()) && afterBulk.some(token => token.id === bound.id));
  check("another owner's connections are untouched by bulk removal", (await manage("GET", undefined, stranger)).data.tokens.length >= 1);

  const capped = `agent-capped-${run}`;
  await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO agent_tokens (id, owner_id, name, token_hash, created_at, expires_at, revoked_at, device_id) SELECT 'cap-${run}-' || i, '${capped}', 'Active ' || i, 'cap-hash-${run}-' || i, ${stamp} + i, ${stamp + 86400000}, NULL, NULL FROM n;`);
  check("an owner cannot hold more than 100 active connections", (await manage("POST", { name: "One too many" }, capped)).status === 409);
  const cappedListing = (await manage("GET", undefined, capped)).data.tokens;
  check("the list shows all 100 active connections", cappedListing.length === 100);
  await manage("DELETE", undefined, capped, {}, `/${cappedListing[0].id}`);
  check("revoking one connection frees a slot", (await manage("POST", { name: "Fits now" }, capped)).status === 201);

  // Deleting a device either leaves its connections valid but unbound, or revokes them.
  await dev("POST", "", { name: "Unbind box", id: "unbind-box" });
  await dev("POST", "", { name: "Revoke box", id: "revoke-box" });
  const keeps = (await manage("POST", { name: "Keeps working", deviceId: "unbind-box" })).data;
  const dies = (await manage("POST", { name: "Dies with device", deviceId: "revoke-box" })).data;
  check("device detail counts its bound connections", (await dev("GET", "/revoke-box")).data.usage.connections === 1);
  const unbound = await dev("DELETE", "/unbind-box", { version: 1 });
  check("deleting a device can leave its connections valid but unbound", unbound.status === 200 && unbound.data.unboundConnections === 1 && unbound.data.revokedConnections === 0
    && (await rpc(null, null, bearer(keeps.token), "initialize")).status === 200 && (await manage()).data.tokens.find(token => token.id === keeps.id).deviceId === null);
  const revoked = await dev("DELETE", "/revoke-box", { version: 1, connections: "revoke" });
  const diesNow = (await manage()).data.tokens.find(token => token.id === dies.id);
  check("deleting a device can revoke its connections", revoked.status === 200 && revoked.data.revokedConnections === 1 && revoked.data.unboundConnections === 0 && diesNow.revokedAt !== null && diesNow.deviceId === null);
  check("a connection revoked with its device is rejected by the Agent endpoint", (await rpc(null, null, bearer(dies.token), "initialize")).status === 401);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  const owners = `'${owner}', '${stranger}', 'agent-capped-${run}'`;
  await sql([`DELETE FROM handoffs WHERE owner_id IN (${owners});`, `DELETE FROM agent_tokens WHERE owner_id IN (${owners});`, `DELETE FROM devices WHERE owner_id IN (${owners});`]);
}
