// Shared-workspace checks. Run against a built local Worker started with
// `--var AGENTRELAY_WORKSPACE_OWNER_ID:<id>` and pass the same id in AGENTRELAY_TEST_WORKSPACE_OWNER.
// AGENTRELAY_TEST_PRIVATE_URL optionally names a second Worker on the same local state without that variable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { flat, fromPixels } from "../support/image-fixtures.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5179";
const privateBase = process.env.AGENTRELAY_TEST_PRIVATE_URL;
const workspace = process.env.AGENTRELAY_TEST_WORKSPACE_OWNER;
for (const url of [base, privateBase].filter(Boolean))
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Workspace checks only run against a local database.");
if (!workspace) throw new Error("Set AGENTRELAY_TEST_WORKSPACE_OWNER to the Worker's AGENTRELAY_WORKSPACE_OWNER_ID.");
const run = crypto.randomUUID().slice(0, 8), member = `workspace-member-${run}`;
const people = { [workspace]: "owner@sites.test", [member]: "member@sites.test" };
const passed = [], handoffIds = [], tokenIds = [], deviceIds = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
async function request(path, method = "GET", data, user = workspace, extra = {}, url = base) {
  return testRequest(url + path, { method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Connection: "close", "Content-Type": "application/json", ...(user ? { ...identityHeaders(user, people[user]) } : {}), ...extra } });
}
const agent = (token, name, args, url = base) => request("/api/agent/mcp", "POST",
  { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, null, { Authorization: `Bearer ${token}` }, url);
const text = response => JSON.parse(response.data.result.content[0].text);
/** Raw image upload as a platform user (web route) or with an Agent Token (agent route). */
async function upload(bytes, { user, token, url = base } = {}) {
  const key = crypto.randomUUID();
  return testRequest(url + (token ? "/api/agent/attachments" : "/api/attachments"), { method: "POST", body: bytes,
    headers: { Connection: "close", "X-Upload-Key": key, ...(token ? { Authorization: `Bearer ${token}` } : { ...identityHeaders(user, people[user]) }) } });
}
async function download(path, user, url = base) {
  return testRequest(url + path, { headers: { Connection: "close", ...identityHeaders(user, people[user]) } }, { format: "bytes" });
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  check("unauthenticated read is still rejected", (await request("/api/devices", "GET", undefined, null)).status === 401);
  for (const user of [workspace, member]) {
    const info = await request("/api/workspace", "GET", undefined, user);
    check("a shared site reports sharing and the viewer without revealing any id", info.status === 200 && info.data.shared === true && info.data.viewerName === people[user] && !/userId|ownerId/.test(JSON.stringify(info.data)));
  }
  const device = await request("/api/devices", "POST", { name: `Owner desk ${run}`, id: `owner-desk-${run}` });
  deviceIds.push(device.data?.id);
  check("owner registers a device", device.status === 201);
  const seen = await request("/api/devices", "GET", undefined, member);
  check("a member sees the owner's device", seen.data.devices.some(item => item.id === device.data.id));
  const memberDevice = await request("/api/devices", "POST", { name: `Member laptop ${run}`, id: `member-laptop-${run}` }, member);
  deviceIds.push(memberDevice.data?.id);
  check("a member registers into the same registry", memberDevice.status === 201
    && (await request("/api/devices")).data.devices.some(item => item.id === memberDevice.data.id));
  const renamed = await request(`/api/devices/${device.data.id}`, "PATCH", { version: 1, line: "teal" }, member);
  check("a member can edit any device", renamed.status === 200 && renamed.data.line === "teal");

  const sent = await request("/api/handoffs", "POST", { title: "From member", content: "exact\r\ntext ", sourceDevice: memberDevice.data.id,
    targetDevice: device.data.id, requestKey: `ws-${run}` }, member);
  handoffIds.push(sent.data?.id);
  check("a member sends to the owner's device", sent.status === 201 && sent.data.targetDeviceId === device.data.id);
  check("the sender's name is returned, never their id", sent.data.createdByName === people[member] && !("createdByUserId" in sent.data));
  const inbox = await request("/api/handoffs");
  check("the owner receives the member's prompt", inbox.data.handoffs.some(item => item.id === sent.data.id && item.content === "exact\r\ntext "));
  check("a retry by another member with the same key is idempotent", (await request("/api/handoffs", "POST", { title: "From member", content: "exact\r\ntext ",
    sourceDevice: memberDevice.data.id, targetDevice: device.data.id, requestKey: `ws-${run}` })).data.id === sent.data.id);
  const claimed = await request(`/api/handoffs/${sent.data.id}`, "PATCH", { status: "claimed", device: device.data.id, version: 1 });
  check("the owner claims it", claimed.status === 200 && claimed.data.version === 2);
  check("a stale claim by the member conflicts", (await request(`/api/handoffs/${sent.data.id}`, "PATCH", { status: "claimed", device: memberDevice.data.id, version: 1 }, member)).status === 409);

  const native = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_handoff", arguments: { id: sent.data.id } } }, member);
  check("native MCP reads the shared inbox", text(native).id === sent.data.id);

  const issued = await request("/api/agent-tokens", "POST", { name: `Member agent ${run}`, deviceId: memberDevice.data.id }, member);
  tokenIds.push(issued.data?.id);
  check("a member issues an Agent Token", issued.status === 201 && issued.data.createdByName === people[member]);
  const listed = (await request("/api/agent-tokens")).data.tokens.find(token => token.id === issued.data.id);
  check("the owner sees who issued it", listed?.createdByName === people[member]);
  check("only the issuer's own rows are flagged as issued by the viewer", listed?.issuedByViewer === false
    && (await request("/api/agent-tokens", "GET", undefined, member)).data.tokens.find(token => token.id === issued.data.id)?.issuedByViewer === true
    && !/created_by_user_id|createdByUserId|ownerId/.test(JSON.stringify((await request("/api/agent-tokens")).data)));
  const viaAgent = await agent(issued.data.token, "create_handoff", { title: "From member agent", content: "agent text", sourceDevice: memberDevice.data.id,
    targetDevice: device.data.id, requestKey: `ws-agent-${run}` });
  const agentRow = text(viaAgent); handoffIds.push(agentRow.id);
  check("a member's agent writes into the shared inbox as that member", agentRow.createdByName === people[member] && !("ownerId" in agentRow)
    && (await request(`/api/handoffs/${agentRow.id}`)).status === 200);

  // ---- images inside a shared workspace ----------------------------------------------------------------------------
  const picture = await fromPixels({ format: "png", width: 20, height: 20, pixel: (x, y) => [x * 12, y * 12, 99] }), second = await flat({ format: "jpeg", width: 16, height: 16 });
  const memberUpload = await upload(picture, { user: member });
  check("a member uploads an image into the shared workspace", memberUpload.status === 201);
  const ownerBinds = await request("/api/handoffs", "POST", { title: "Owner sends member's image", sourceDevice: device.data.id, targetDevice: memberDevice.data.id,
    attachmentIds: [memberUpload.data.id], requestKey: `ws-image-${run}` });
  handoffIds.push(ownerBinds.data?.id);
  check("the owner can attach an image a member uploaded", ownerBinds.status === 201 && ownerBinds.data.attachments[0].id === memberUpload.data.id && ownerBinds.data.content === "");
  for (const user of [workspace, member]) {
    const view = await download(`/api/handoffs/${ownerBinds.data.id}/attachments/${memberUpload.data.id}`, user);
    check(`${user === workspace ? "the owner" : "the member"} reads the shared image with its original bytes`, view.status === 200 && sha(view.bytes) === sha(picture));
  }
  const agentUpload = await upload(second, { token: issued.data.token });
  check("a member's Agent Token uploads into the shared workspace", agentUpload.status === 201);
  const agentImageHandoff = await request("/api/handoffs", "POST", { title: "Agent image", content: "see image", sourceDevice: memberDevice.data.id, targetDevice: device.data.id,
    attachmentIds: [agentUpload.data.id], requestKey: `ws-agent-image-${run}` });
  handoffIds.push(agentImageHandoff.data?.id);
  check("the owner attaches the agent's upload", agentImageHandoff.status === 201);
  const viaAgentImage = await agent(issued.data.token, "get_handoff", { id: agentImageHandoff.data.id, attachmentId: agentUpload.data.id });
  const agentBlocks = viaAgentImage.data.result.content;
  check("the member's agent receives the image block", !viaAgentImage.data.result.isError && agentBlocks[1].type === "image" && sha(Buffer.from(agentBlocks[1].data, "base64")) === sha(second));
  const nativeImage = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_handoff", arguments: { id: ownerBinds.data.id, attachmentId: memberUpload.data.id } } }, member);
  check("native MCP returns the shared image for any member", nativeImage.data.result.content[1].type === "image" && sha(Buffer.from(nativeImage.data.result.content[1].data, "base64")) === sha(picture));
  async function agentDownload(id, attachmentId, url = base) {
    return testRequest(`${url}/api/agent/handoffs/${id}/attachments/${attachmentId}`, { headers: { Connection: "close", Authorization: `Bearer ${issued.data.token}` } }, { format: "bytes" });
  }
  const sharedDownload = await agentDownload(ownerBinds.data.id, memberUpload.data.id);
  check("a member's Agent Token downloads the shared image's original bytes", sharedDownload.status === 200 && sha(sharedDownload.bytes) === sha(picture));

  if (privateBase) {
    const privateRead = await download(`/api/handoffs/${ownerBinds.data.id}/attachments/${memberUpload.data.id}`, member, privateBase);
    check("without sharing a member cannot read the shared images", privateRead.status === 404);
    const privateUpload = await upload(second, { user: member, url: privateBase });
    check("an upload without sharing lands in the member's own workspace", privateUpload.status === 201);
    check("a private-workspace upload cannot be attached to the shared workspace", (await request("/api/handoffs", "POST", { title: "private", content: "x", sourceDevice: "a", targetDevice: "b",
      requestKey: `ws-private-${run}`, attachmentIds: [privateUpload.data.id] }, member)).status === 404);
    check("without sharing a member's Agent Token cannot upload", (await upload(second, { token: issued.data.token, url: privateBase })).status === 401);
    check("without sharing a member's Agent Token cannot download", (await agentDownload(ownerBinds.data.id, memberUpload.data.id, privateBase)).status === 401);
  }

  if (privateBase) {
    check("without sharing a member reaches only their own records", (await request("/api/devices", "GET", undefined, member, {}, privateBase)).data.devices.length === 0);
    const denied = await agent(issued.data.token, "list_handoffs", {}, privateBase);
    check("without sharing a member's Agent Token stops authenticating", denied.status === 401);
  }

  // ---- rotation, selection and offboarding across members --------------------------------------------------------------
  const make = async (name, user) => { const result = await request("/api/agent-tokens", "POST", { name: `${name} ${run}` }, user); tokenIds.push(result.data?.id); return result; };
  check("only the issuer can rotate a connection", (await request(`/api/agent-tokens/${issued.data.id}/rotate`, "POST", {}, workspace)).status === 403
    && (await request(`/api/agent-tokens/${(await make("Owner rotation target", workspace)).data.id}/rotate`, "POST", {}, member)).status === 403);
  const rotated = await request(`/api/agent-tokens/${issued.data.id}/rotate`, "POST", { version: issued.data.version }, member);
  check("the issuer rotates their own connection and only the new secret works", rotated.status === 200 && rotated.data.version === issued.data.version + 1
    && (await agent(issued.data.token, "list_handoffs", {})).status === 401 && (await agent(rotated.data.token, "list_handoffs", {})).status === 200);
  issued.data.token = rotated.data.token;
  const ownerOne = await make("Owner one", workspace), memberTwo = await make("Member two", member), ownerKeep = await make("Owner keep", workspace);
  const selection = await request("/api/agent-tokens/revoke", "POST", { ids: [ownerOne.data.id, memberTwo.data.id] }, workspace);
  check("a selection across members is revoked in one request", selection.status === 200 && selection.data.revoked.length === 2);
  check("the history summary names no single issuer for a mixed selection", (await request("/api/agent-tokens/events?limit=100")).data.events
    .some(e => e.kind === "bulk_revoked" && e.detail?.count === 2 && e.detail?.issuer === null));
  const third = await make("Member three", member), fourth = await make("Member four", member);
  check("a member who gains a connection mid-preview is not offboarded", (await request("/api/agent-tokens/revoke-issuer", "POST",
    { connectionId: third.data.id, expectedTokenIds: [issued.data.id, third.data.id] }, workspace)).status === 409);
  const offboarded = await request("/api/agent-tokens/revoke-issuer", "POST", { connectionId: third.data.id, expectedTokenIds: [issued.data.id, third.data.id, fourth.data.id] }, workspace);
  const afterwards = (await request("/api/agent-tokens")).data.tokens, byId = id => afterwards.find(t => t.id === id);
  check("offboarding a member revokes their whole set with the reason and the actor", offboarded.status === 200 && offboarded.data.revoked.length === 3
    && [issued, third, fourth].every(item => byId(item.data.id).revokedReason === "offboarding" && byId(item.data.id).revokedByName === people[workspace]));
  check("offboarding leaves the other members' connections alone", byId(ownerKeep.data.id).revokedAt === null);
  check("an offboarded member's agent is refused at once", (await agent(rotated.data.token, "list_handoffs", {})).status === 401);

  const revoked = await request(`/api/agent-tokens/${issued.data.id}`, "DELETE");
  check("the owner can revoke a member's token", revoked.status === 200 && revoked.data.revokedAt);
  check("a revoked member token is rejected", (await agent(issued.data.token, "list_handoffs", {})).status === 401);
  check("a revoked member token can no longer upload", (await upload(picture, { token: issued.data.token })).status === 401);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  for (const id of handoffIds) if (id) await request(`/api/handoffs/${id}`, "DELETE");
  for (const id of tokenIds) if (id) { await request(`/api/agent-tokens/${id}`, "DELETE"); await request(`/api/agent-tokens/${id}?permanent=1`, "DELETE"); }
  const registry = (await request("/api/devices")).data?.devices ?? [];
  for (const item of registry) if (deviceIds.includes(item.id)) await request(`/api/devices/${item.id}`, "DELETE", { version: item.version });
}
