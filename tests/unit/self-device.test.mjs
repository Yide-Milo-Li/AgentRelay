import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { createD1, openDatabase } from "../support/d1-shim.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { renderDeviceRule } from "../../src/shared/formatting/device-rule.mjs";

const options = { stubs: { "cloudflare:workers": path.join(projectRoot, "tests/support/cloudflare-workers-stub.mjs"),
  "next/headers": path.join(projectRoot, "tests/support/next-auth-stub.mjs"), "next/navigation": path.join(projectRoot, "tests/support/next-auth-stub.mjs") }, inProject: true };
const { bindSelf } = await loadTypeScriptModule("src/server/mcp/self-device.ts", options);
const { handleMcp } = await loadTypeScriptModule("src/server/mcp/index.ts", options);
const lifecycle = await loadTypeScriptModule("src/server/device-lifecycle/index.ts", options);
const handoffs = await loadTypeScriptModule("src/server/handoffs/index.ts", options);
const tokens = await loadTypeScriptModule("src/server/agent-tokens/index.ts", options);
const auth = await loadTypeScriptModule("src/server/auth/index.ts", options);
const rules = await loadTypeScriptModule("src/server/devices/validation.ts");
const owner = { owner: "workspace-a", userId: "workspace-a", name: "Member A" };
let db;
const fresh = () => { db?.close(); db = openDatabase(); env.DB = createD1(db); delete env.AGENTRELAY_WORKSPACE_OWNER_ID; };
const status = action => { try { action(); } catch (error) { return error.status; } return null; };
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);

/** One tools/call through the real MCP adapter, authenticated as the actor. */
async function call(actor, name, args) {
  const request = new Request("https://example.test/api/agent/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const reply = await (await handleMcp(request, () => actor)).json();
  if (reply.result.isError) return { error: reply.result.content[0].text, status: reply.result.structuredContent.error.status };
  return JSON.parse(reply.result.content[0].text);
}
const bound = deviceId => ({ ...owner, connectionId: "c1", deviceId });

test("self is reserved: no device can take it as an id or a name", () => {
  for (const bad of ["self", "SELF"]) assert.equal(status(() => rules.parseDeviceId(bad)), 400, bad);
  for (const bad of ["self", " Self ", "ＳＥＬＦ"]) assert.equal(status(() => rules.parseDeviceName(bad)), 400, bad);
  assert.equal(rules.parseDeviceId("self-hosted"), "self-hosted");
  assert.equal(status(() => rules.parseDeviceName("My self")), null);
});

test("bindSelf swaps self for the connection's device and fills an omitted sourceDevice, in each tool's own fields only", () => {
  const actor = bound("desk");
  assert.deepEqual(bindSelf("create_handoff", { targetDevice: "Self", title: "self" }, actor), { targetDevice: "desk", title: "self", sourceDevice: "desk" });
  assert.deepEqual(bindSelf("create_handoff", { sourceDevice: "phone", targetDevice: "self" }, actor), { sourceDevice: "phone", targetDevice: "desk" });
  assert.deepEqual(bindSelf("claim_handoff", { id: "x", device: "self" }, actor), { id: "x", device: "desk" });
  assert.deepEqual(bindSelf("list_handoffs", { targetDevice: "self" }, actor), { targetDevice: "desk" });
  assert.deepEqual(bindSelf("list_handoffs", {}, actor), {}, "an omitted filter still lists every device");
  assert.deepEqual(bindSelf("get_handoff", { id: "self" }, actor), { id: "self" });
  assert.equal(status(() => bindSelf("claim_handoff", { device: "self" }, bound(null))), 400);
  assert.equal(status(() => bindSelf("claim_handoff", { device: "self" }, owner)), 400);
  assert.deepEqual(bindSelf("create_handoff", { targetDevice: "any" }, bound(null)), { targetDevice: "any" });
});

test("a bound connection sends, lists and claims as its device, and moving the connection moves self", async () => {
  fresh();
  const desk = await lifecycle.createDevice(owner.owner, { name: "Desk", id: "desk" }), phone = await lifecycle.createDevice(owner.owner, { name: "Phone", id: "phone" });
  const connection = await tokens.createAgentToken(owner, { name: "On desk", deviceId: desk.id });
  const request = new Request("https://example.test/x", { headers: { Authorization: `Bearer ${connection.token}` } });
  const actor = await auth.actorFromAgent(request);
  assert.equal(actor.deviceId, "desk");

  const sent = await call(actor, "create_handoff", { title: "T", content: "Body", targetDevice: "phone", requestKey: "k1" });
  assert.deepEqual([sent.sourceDeviceId, sent.targetDeviceId], ["desk", "phone"]);
  const toSelf = await call(actor, "create_handoff", { title: "T2", content: "Body", sourceDevice: "phone", targetDevice: "self", requestKey: "k2" });
  assert.deepEqual([toSelf.sourceDeviceId, toSelf.targetDeviceId], ["phone", "desk"]);
  assert.deepEqual((await call(actor, "list_handoffs", { targetDevice: "self" })).handoffs.map(row => row.id), [toSelf.id]);
  const claimed = await call(actor, "claim_handoff", { id: toSelf.id, device: "self", version: toSelf.version });
  assert.deepEqual([claimed.claimedBy, claimed.claimedByDeviceId], ["Desk", "desk"]);

  await tokens.updateAgentToken(owner.owner, connection.id, { deviceId: phone.id });
  const moved = await auth.actorFromAgent(request);
  assert.equal(moved.deviceId, "phone");
  assert.deepEqual((await call(moved, "list_handoffs", { targetDevice: "self" })).handoffs.map(row => row.id), [sent.id]);
  assert.equal((await call(moved, "create_handoff", { title: "T3", content: "Body", targetDevice: "any", requestKey: "k3" })).sourceDeviceId, "phone");
});

test("self fails clearly without a bound connection, in the adapter and in the services", async () => {
  fresh();
  const unbound = await call(bound(null), "create_handoff", { title: "T", content: "Body", sourceDevice: "self", targetDevice: "any", requestKey: "k" });
  assert.equal(unbound.status, 400); assert.match(unbound.error, /bound to a device/);
  assert.equal((await call(owner, "list_handoffs", { targetDevice: "self" })).status, 400);
  const fallback = await call(bound(null), "create_handoff", { title: "T", content: "Body", targetDevice: "any", requestKey: "k2" });
  assert.equal(fallback.sourceDevice, "Agent", "an unbound connection that leaves sourceDevice out keeps the old fallback");
  await rejects(handoffs.createHandoff(owner, { title: "T", content: "Body", sourceDevice: "self", targetDevice: "any", requestKey: "k3" }), 400);
  await rejects(handoffs.createHandoff(owner, { title: "T", content: "Body", targetDevice: "SELF", requestKey: "k4" }), 400);
  await rejects(handoffs.listHandoffs(owner.owner, { targetDevice: "self" }), 400);
  const ready = await handoffs.createHandoff(owner, { title: "T", content: "Body", targetDevice: "any", requestKey: "k5" });
  await rejects(handoffs.changeHandoff(owner.owner, ready.id, { status: "claimed", device: "self", version: ready.version }), 400);
});

test("a bound connection's rule says self and names no device id", () => {
  for (const lang of ["en", "zh"]) {
    const bound = renderDeviceRule(lang, "https://relay.example.com", { bound: true });
    assert.ok(bound.includes("`self`") && !bound.includes("laptop"), lang);
    assert.ok(!renderDeviceRule(lang, "https://relay.example.com").includes("`self`"), `${lang}: a rule without a device stays generic`);
    assert.ok(renderDeviceRule(lang, "https://relay.example.com", "laptop").includes("`laptop`"), `${lang}: an explicit id is still rendered`);
  }
});
