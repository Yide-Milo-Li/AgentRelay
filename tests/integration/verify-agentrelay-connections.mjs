// Built Worker HTTP checks; every credential is synthetic and revoked in finally. Never print tokens.
import assert from "node:assert/strict";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5190";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Connection tests require a local Worker.");
const owner = `connections-${crypto.randomUUID()}`, stranger = `other-${owner}`, checks = [], ids = [];
async function request(path, method = "GET", data, headers = { "oai-authenticated-user-id": owner }) {
  const response = await fetch(base + path, { method, redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const text = await response.text();
  if (response.status === 503 && text.includes("worker restarted mid-request")) throw new Error("Local Wrangler returned its known restart-proxy failure. This test did not retry the write.");
  return { status: response.status, data: JSON.parse(text) };
}
const check = (label, value) => { assert.ok(value, label); checks.push(label); };
const issue = async input => { const result = await request("/api/agent-tokens", "POST", input); if (result.data.id) ids.push(result.data.id); return result; };
const bearer = token => ({ Authorization: `Bearer ${token}` });
try {
  check("anonymous diagnostic rejected", (await request("/api/agent/connection", "GET", undefined, {})).status === 401);
  check("permanent without acknowledgement rejected", (await issue({ name: "Permanent", expiresInDays: null })).status === 400);
  const finite = (await issue({ name: "Finite" })).data, permanent = (await issue({ name: "Permanent", expiresInDays: null, acknowledgePermanentRisk: true })).data;
  check("90 day default retained", finite.expiresAt - finite.createdAt === 90 * 86400000 && !finite.neverExpires);
  check("permanent wire expiry is null", permanent.expiresAt === null && permanent.neverExpires);
  const diagnostic = await request("/api/agent/connection", "GET", undefined, bearer(permanent.token));
  check("diagnostic resolves only this credential", diagnostic.status === 200 && diagnostic.data.connection.id === permanent.id && !/tokenHash|ownerId|createdByUserId|agentrelay_/.test(JSON.stringify(diagnostic.data)));
  const listing = (await request("/api/agent-tokens")).data.tokens;
  check("authentication timestamp recorded", listing.find(t => t.id === permanent.id).lastAuthenticatedAt > 0);
  check("the issuer sees their own rows flagged and a stranger sees none", listing.every(t => t.issuedByViewer === true)
    && (await request("/api/agent-tokens", "GET", undefined, { "oai-authenticated-user-id": stranger })).data.tokens.length === 0);
  check("active permanent cannot be removed", (await request(`/api/agent-tokens/${permanent.id}?permanent=1`, "DELETE")).status === 409);
  check("inactive cleanup retains active permanent", (await request("/api/agent-tokens?scope=inactive", "DELETE")).data.removed === 0);
  const path = "/api/agent-tokens/revoke-issuer", body = { connectionId: permanent.id, expectedTokenIds: [permanent.id, finite.id] };
  check("Agent Token cannot manage issuer access", (await request(path, "POST", undefined, bearer(permanent.token))).status === 401);
  check("foreign issuer reference answers not found", (await request(path, "POST", body, { "oai-authenticated-user-id": stranger })).status === 404);
  check("cross-origin issuer revocation rejected", (await request(path, "POST", undefined, { "oai-authenticated-user-id": owner, Origin: "https://untrusted.example" })).status === 403);
  const extra = (await issue({ name: "New after preview" })).data;
  check("stale issuer preview refuses whole mutation", (await request(path, "POST", body)).status === 409 && (await request("/api/agent/connection", "GET", undefined, bearer(permanent.token))).status === 200);
  check("current preview revokes all including permanent", (await request(path, "POST", { ...body, expectedTokenIds: [...body.expectedTokenIds, extra.id] })).data.revoked.length === 3);
  check("revoked permanent immediately refused", (await request("/api/agent/connection", "GET", undefined, bearer(permanent.token))).status === 401);
  // Versions, revocation metadata and history.
  const reader = (await issue({ name: "Reader" })).data, third = (await issue({ name: "Third" })).data, one = `/api/agent-tokens/${reader.id}`;
  check("a new connection starts at version 1 with no revocation metadata", reader.version === 1 && reader.revokedByName === null && reader.revokedReason === null);
  const patched = await request(one, "PATCH", { name: "Reader renamed", version: reader.version });
  check("renaming with the current version succeeds and bumps it", patched.status === 200 && patched.data.version === 2 && patched.data.name === "Reader renamed");
  check("a stale version is refused and changes nothing", (await request(one, "PATCH", { name: "Stale", version: 1 })).status === 409
    && (await request("/api/agent-tokens")).data.tokens.find(t => t.id === reader.id).name === "Reader renamed");
  check("a non-integer version is rejected", (await request(one, "PATCH", { name: "Bad", version: "2" })).status === 400);
  check("revoking with a stale version is refused", (await request(`${one}?version=1`, "DELETE")).status === 409);
  check("a malformed version query is rejected", (await request(`/api/agent-tokens/${third.id}?version=abc`, "DELETE")).status === 400);
  const revokedOne = await request(`${one}?version=2`, "DELETE");
  check("revoking with the current version records the reason and bumps it", revokedOne.status === 200 && revokedOne.data.revokedReason === "manual" && revokedOne.data.version === 3 && revokedOne.data.revokedAt > 0);
  check("revoking again is idempotent and ignores the version", (await request(`${one}?version=1`, "DELETE")).data.revokedAt === revokedOne.data.revokedAt);
  const history = await request("/api/agent-tokens/events?limit=200");
  const kinds = history.data.events.map(e => e.kind);
  check("history records creation, rename, revocation and the issuer summary", history.status === 200
    && ["created", "renamed", "revoked", "bulk_revoked"].every(kind => kinds.includes(kind)) && kinds.filter(kind => kind === "created").length === 5);
  check("a rename entry keeps the old and new names", history.data.events.some(e => e.kind === "renamed" && e.detail?.from === "Reader" && e.detail?.to === "Reader renamed"));
  check("history reveals neither secrets nor platform ids", !new RegExp(`agentrelay_|createdByUserId|ownerId|${owner}`).test(JSON.stringify(history.data)));
  const firstPage = await request("/api/agent-tokens/events?limit=2"), secondPage = await request(`/api/agent-tokens/events?limit=2&before=${encodeURIComponent(firstPage.data.nextBefore)}`);
  check("history pages without repeating entries", firstPage.data.events.length === 2 && secondPage.data.events.length > 0
    && !secondPage.data.events.some(e => firstPage.data.events.some(f => f.id === e.id)));
  check("history can be limited to one connection", (await request(`/api/agent-tokens/events?tokenId=${reader.id}`)).data.events.every(e => e.tokenId === reader.id));
  check("history rejects bad queries", (await request("/api/agent-tokens/events?limit=0")).status === 400 && (await request("/api/agent-tokens/events?before=zzz")).status === 400);
  check("another workspace sees no history", (await request("/api/agent-tokens/events", "GET", undefined, { "oai-authenticated-user-id": stranger })).data.events.length === 0);
  check("an Agent Token cannot read the history", (await request("/api/agent-tokens/events", "GET", undefined, bearer(third.token))).status === 401);
  const bench = (await request("/api/devices", "POST", { name: "Bench", id: "bench" })).data, onBench = (await issue({ name: "On bench", deviceId: bench.id })).data;
  const deleted = await request(`/api/devices/${bench.id}`, "DELETE", { version: bench.version, connections: "revoke" });
  const afterDelete = (await request("/api/agent-tokens")).data.tokens.find(t => t.id === onBench.id);
  check("deleting a device revokes its connections with that reason", deleted.status === 200 && afterDelete.revokedReason === "device_deleted" && afterDelete.deviceId === null);
  check("history shows the device-deletion revocation", (await request("/api/agent-tokens/events?limit=200")).data.events.some(e => e.id === `device-deleted:${onBench.id}` && e.tokenName === "On bench"));
  await request(`/api/agent-tokens/${onBench.id}?permanent=1`, "DELETE");
  check("a removed connection stays in the history by name", (await request("/api/agent-tokens/events?limit=200")).data.events.some(e => e.kind === "removed" && e.tokenName === "On bench"));
  // Lifetime, rotation and exact-set revocation.
  const life = (await issue({ name: "Lifetime" })).data, lifeUrl = `/api/agent-tokens/${life.id}`;
  const extended = await request(lifeUrl, "PATCH", { expiresInDays: 365, version: life.version });
  check("extending sets a new lifetime from now and bumps the version", extended.status === 200 && extended.data.version === life.version + 1
    && extended.data.expiresAt - Date.now() > 364 * 86400000 && extended.data.expiresAt - Date.now() <= 365 * 86400000);
  check("an out-of-range or unacknowledged lifetime is rejected", (await request(lifeUrl, "PATCH", { expiresInDays: 0 })).status === 400
    && (await request(lifeUrl, "PATCH", { expiresInDays: 366 })).status === 400 && (await request(lifeUrl, "PATCH", { expiresInDays: null })).status === 400);
  const forever = await request(lifeUrl, "PATCH", { expiresInDays: null, acknowledgePermanentRisk: true });
  check("a permanent lifetime needs the acknowledgement and is then accepted", forever.status === 200 && forever.data.neverExpires === true && forever.data.expiresAt === null);
  check("a stale version cannot change the lifetime", (await request(lifeUrl, "PATCH", { expiresInDays: 30, version: life.version })).status === 409);

  const spin = (await issue({ name: "Spin" })).data, spinUrl = `/api/agent-tokens/${spin.id}/rotate`;
  check("the connection authenticates before rotation", (await request("/api/agent/connection", "GET", undefined, bearer(spin.token))).status === 200);
  check("an Agent Token cannot rotate", (await request(spinUrl, "POST", {}, bearer(spin.token))).status === 401);
  check("cross-origin rotation is rejected", (await request(spinUrl, "POST", {}, { "oai-authenticated-user-id": owner, Origin: "https://untrusted.example" })).status === 403);
  check("a foreign workspace cannot rotate and learns nothing", (await request(spinUrl, "POST", {}, { "oai-authenticated-user-id": stranger })).status === 404);
  check("rotating with a stale version is refused", (await request(spinUrl, "POST", { version: spin.version + 5 })).status === 409);
  const rotated = await request(spinUrl, "POST", { version: spin.version });
  check("rotating returns a new secret once and bumps the version", rotated.status === 200 && /^agentrelay_[a-f0-9]{64}$/.test(rotated.data.token) && rotated.data.token !== spin.token
    && rotated.data.version === spin.version + 1 && rotated.data.lastAuthenticatedAt === null && rotated.data.rotatedAt > 0);
  const listed = (await request("/api/agent-tokens")).data;
  check("the list never carries the new secret and shows the rotation", !JSON.stringify(listed).includes(rotated.data.token) && listed.tokens.find(t => t.id === spin.id).rotatedAt === rotated.data.rotatedAt);
  check("the old secret stops at once and the new one works", (await request("/api/agent/connection", "GET", undefined, bearer(spin.token))).status === 401
    && (await request("/api/agent/connection", "GET", undefined, bearer(rotated.data.token))).status === 200);
  check("a second rotation with the old version is refused", (await request(spinUrl, "POST", { version: spin.version })).status === 409);

  const setA = (await issue({ name: "Set one" })).data, setB = (await issue({ name: "Set two" })).data, setPath = "/api/agent-tokens/revoke";
  check("an Agent Token cannot revoke a set", (await request(setPath, "POST", { ids: [setA.id] }, bearer(rotated.data.token))).status === 401);
  check("cross-origin set revocation is rejected", (await request(setPath, "POST", { ids: [setA.id] }, { "oai-authenticated-user-id": owner, Origin: "https://untrusted.example" })).status === 403);
  check("an empty, repeated or unknown reason is rejected", (await request(setPath, "POST", { ids: [] })).status === 400 && (await request(setPath, "POST", { ids: [setA.id, setA.id] })).status === 400
    && (await request(setPath, "POST", { ids: [setA.id], reason: "device_deleted" })).status === 400);
  check("a foreign workspace or an unknown id refuses the whole set", (await request(setPath, "POST", { ids: [setA.id] }, { "oai-authenticated-user-id": stranger })).status === 409
    && (await request(setPath, "POST", { ids: [setA.id, setB.id, "no-such-id"] })).status === 409
    && (await request("/api/agent-tokens")).data.tokens.filter(t => [setA.id, setB.id].includes(t.id)).every(t => t.revokedAt === null));
  const set = await request(setPath, "POST", { ids: [setA.id, setB.id] });
  const afterSet = (await request("/api/agent-tokens")).data.tokens;
  check("an exact set is revoked together with the reason", set.status === 200 && set.data.revoked.length === 2
    && [setA.id, setB.id].every(id => afterSet.find(t => t.id === id).revokedReason === "bulk"));
  check("revoking the set again is refused because it is no longer usable", (await request(setPath, "POST", { ids: [setA.id, setB.id] })).status === 409);
  const kinds2 = (await request("/api/agent-tokens/events?limit=200")).data.events;
  check("history shows the extension, the rotation and the set revocation", ["extended", "rotated", "bulk_revoked"].every(kind => kinds2.some(e => e.kind === kind))
    && kinds2.some(e => e.kind === "bulk_revoked" && e.detail?.count === 2 && e.detail?.reason === "bulk"));
  // Client identity: the profile chosen when the connection is made, and what the agent reports on MCP initialize.
  const mcp = (token, method, params) => request("/api/agent/mcp", "POST", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, bearer(token));
  const profiled = (await issue({ name: "Profiled", clientProfile: "codex" })).data, plain = (await issue({ name: "Plain" })).data;
  const clientOf = async id => (await request("/api/agent-tokens")).data.tokens.find(t => t.id === id);
  check("the chosen agent profile is recorded, left empty when not given, and a malformed one is refused",
    profiled.clientProfile === "codex" && plain.clientProfile === null && profiled.lastClient === null && (await issue({ name: "Bad", clientProfile: "Not A Profile" })).status === 400);
  const bare = await mcp(profiled.token, "initialize", {});
  const reported = await mcp(profiled.token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.4" } });
  const known = await clientOf(profiled.id);
  check("MCP initialize records the agent's name and version for that connection only", reported.status === 200
    && known.lastClient?.name === "claude-code" && known.lastClient?.version === "2.1.4" && (await clientOf(plain.id)).lastClient === null);
  check("the initialize answer does not depend on what the client reports", JSON.stringify(bare.data.result) === JSON.stringify(reported.data.result));
  const hostile = [{ name: "x".repeat(65), version: "1" }, "nonsense", { name: "bad\nname" }, { name: "zero\u200bwidth" }, { version: "3" }, null];
  const answers = [];
  for (const clientInfo of hostile) answers.push((await mcp(profiled.token, "initialize", { clientInfo })).status);
  check("unusable reports are ignored without failing the handshake or replacing the last good one", answers.every(status => status === 200)
    && (await clientOf(profiled.id)).lastClient?.name === "claude-code");
  await mcp(profiled.token, "initialize", { clientInfo: { name: "codex", version: "0.9" } });
  const later = await clientOf(profiled.id);
  check("a later report replaces the earlier one without counting as a change to the connection", later.lastClient.name === "codex" && later.version === profiled.version);
  check("tool behaviour does not depend on the client: still exactly five tools", (await mcp(profiled.token, "tools/list")).data.result.tools.length === 5);
  check("an anonymous or native initialize records nothing", (await request("/api/agent/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "anonymous" } } }, {})).status === 401
    && (await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "native-session" } } })).status === 200
    && (await request("/api/agent-tokens")).data.tokens.every(t => !["anonymous", "native-session"].includes(t.lastClient?.name)));
  const reissued = await request(`/api/agent-tokens/${profiled.id}/rotate`, "POST", { version: later.version });
  check("rotating the secret forgets the reported agent but keeps the chosen profile", reissued.status === 200 && reissued.data.lastClient === null && reissued.data.clientProfile === "codex");
  // `self` is the device the calling connection is bound to; moving the connection moves it.
  const dock = (await request("/api/devices", "POST", { name: "Dock", id: "dock" })).data, shelf = (await request("/api/devices", "POST", { name: "Shelf", id: "shelf" })).data;
  const docked = (await issue({ name: "On dock", deviceId: dock.id })).data, loose = (await issue({ name: "No device" })).data;
  const tool = (token, name, args) => mcp(token, "tools/call", { name, arguments: args }).then(reply => reply.data.result.isError ? { error: reply.data.result.content[0].text, status: reply.data.result.structuredContent.error.status } : JSON.parse(reply.data.result.content[0].text));
  check("self is not a usable device id or name", (await request("/api/devices", "POST", { name: "Self" })).status === 400 && (await request("/api/devices", "POST", { name: "Mine", id: "self" })).status === 400);
  const fromDock = await tool(docked.token, "create_handoff", { title: "Self test", content: "Synthetic", targetDevice: "shelf", requestKey: `self-${owner}-1` });
  check("a bound connection may leave sourceDevice out and sends as its device", fromDock.sourceDeviceId === "dock" && fromDock.targetDeviceId === "shelf");
  const toSelf = await tool(docked.token, "create_handoff", { title: "Self target", content: "Synthetic", sourceDevice: "shelf", targetDevice: "self", requestKey: `self-${owner}-2` });
  check("targetDevice self reaches the connection's own device", toSelf.sourceDeviceId === "shelf" && toSelf.targetDeviceId === "dock");
  check("list_handoffs self filters by the connection's device", (await tool(docked.token, "list_handoffs", { targetDevice: "self" })).handoffs.map(row => row.id).join() === toSelf.id);
  check("claim_handoff self records the connection's device", (await tool(docked.token, "claim_handoff", { id: toSelf.id, device: "self", version: toSelf.version })).claimedByDeviceId === "dock");
  const unboundSelf = await tool(loose.token, "list_handoffs", { targetDevice: "self" });
  check("self without a bound device is a clear 400", unboundSelf.status === 400 && /bound to a device/.test(unboundSelf.error));
  check("an unbound connection that leaves sourceDevice out keeps the Agent fallback", (await tool(loose.token, "create_handoff", { title: "Loose", content: "Synthetic", targetDevice: "any", requestKey: `self-${owner}-3` })).sourceDevice === "Agent");
  check("the platform endpoint and the web routes refuse self too", (await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_handoffs", arguments: { targetDevice: "self" } } })).data.result.isError === true
    && (await request("/api/handoffs", "POST", { title: "Web self", content: "Synthetic", sourceDevice: "self", targetDevice: "any", requestKey: `self-${owner}-4` })).status === 400);
  const moved = await request(`/api/agent-tokens/${docked.id}`, "PATCH", { deviceId: shelf.id });
  check("moving the connection moves self without any client change", moved.status === 200
    && (await tool(docked.token, "list_handoffs", { targetDevice: "self" })).handoffs.map(row => row.id).join() === fromDock.id);
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  for (const id of ids) { await request(`/api/agent-tokens/${id}`, "DELETE"); await request(`/api/agent-tokens/${id}?permanent=1`, "DELETE"); }
}
