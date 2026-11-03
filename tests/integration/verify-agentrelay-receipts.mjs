// Completion receipts and reply threads over the built Worker: both MCP endpoints, the browser routes and storage accounting.
import assert from "node:assert/strict";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Receipt checks only run against a local database.");
const run = crypto.randomUUID(), owner = `receipts-qa-${run}`, stranger = `receipts-other-${run}`;
const ids = [], strangerIds = [], tokens = [], passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
async function request(path, method = "GET", data, headers = {}) {
  return testRequest(base + path, { method, headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const identity = user => ({ ...identityHeaders(user) });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const web = (path, method, data, user = owner) => request(path, method, data, identity(user));
const call = (endpoint, headers) => (name, args) => request(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
const parsed = response => JSON.parse(response.data.result.content[0].text);
const failed = response => response.status === 200 && response.data.result.isError === true ? response.data.result.structuredContent.error.status : null;
const bytes = text => new TextEncoder().encode(text).length;
try {
  for (const device of [{ name: "Laptop", id: "laptop" }, { name: "Desktop", id: "desktop" }])
    assert.equal((await web("/api/devices", "POST", device)).status, 201);
  const issued = (await web("/api/agent-tokens", "POST", { name: "Desktop agent", deviceId: "desktop", expiresInDays: 1 })).data;
  tokens.push(issued.id);
  const agent = call("/api/agent/mcp", bearer(issued.token)), platform = call("/mcp", identity(owner));

  const prompt = "# Fix login timeout\r\n  keep 中文 🚀\n";
  const created = await web("/api/handoffs", "POST", { title: "Fix login timeout", content: prompt, project: "Receipts QA", sourceDevice: "laptop", targetDevice: "desktop", requestKey: `${run}-parent` });
  const parent = created.data; ids.push(parent.id);
  check("a new handoff starts without a receipt or thread links", created.status === 201 && parent.result === null && parent.replyToId === null && parent.threadId === null);
  check("tools/list still has five tools", (await request("/api/agent/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(issued.token))).data.result.tools.length === 5);
  check("a claim refuses a receipt", failed(await agent("claim_handoff", { id: parent.id, device: "self", version: 1, result: "too early" })) === 400);
  const claimed = parsed(await agent("claim_handoff", { id: parent.id, device: "self", version: 1 }));
  check("the bound agent claims as its own device", claimed.status === "claimed" && claimed.claimedByDeviceId === "desktop" && claimed.version === 2);
  check("an oversized receipt is refused", failed(await agent("complete_handoff", { id: parent.id, version: 2, result: "r".repeat(20001) })) === 400);
  check("a stale completion with a receipt is refused", failed(await agent("complete_handoff", { id: parent.id, version: 1, result: "stale" })) === 409);
  check("refused completions write nothing", (await web(`/api/handoffs/${parent.id}`)).data.result === null);
  const receipt = "## Summary\r\nRaised the timeout.\n\n## Changes\n- branch `fix/login-timeout`\n<script>alert(1)</script>\n\n## Open questions\n- 中文 ✓\n";
  const done = parsed(await agent("complete_handoff", { id: parent.id, version: 2, result: receipt }));
  check("completion stores the receipt exactly without echoing it", done.status === "done" && done.version === 3 && !("result" in done)
    && (await web(`/api/handoffs/${parent.id}`)).data.result === receipt);
  check("platform MCP reads the exact receipt", parsed(await platform("get_handoff", { id: parent.id })).result === receipt);
  const listed = parsed(await agent("list_handoffs", { status: "done", targetDevice: "self" })).handoffs.find(row => row.id === parent.id);
  check("list_handoffs previews the receipt instead of returning it", listed && !("result" in listed) && !("content" in listed)
    && listed.resultPreview === receipt.slice(0, 180) && listed.resultCharacters === receipt.length);
  check("a handoff without replies has no thread", (await web(`/api/handoffs/${parent.id}`)).data.thread === null);

  const storage = (await web(`/api/storage/handoffs?search=${encodeURIComponent("Fix login timeout")}`)).data.handoffs.find(row => row.id === parent.id);
  check("storage counts the receipt as text", storage?.promptBytes === bytes(prompt) + bytes(receipt) && storage.logicalBytes === storage.promptBytes);

  // Replies: defaults from the parent, idempotency, isolation.
  const replyArgs = { replyTo: parent.id, content: "Which timeout value do you want?", requestKey: `${run}-reply` };
  const reply = parsed(await agent("create_handoff", replyArgs)); ids.push(reply.id);
  check("a reply defaults its title, route and project from the parent", reply.title === "Re: Fix login timeout" && reply.sourceDeviceId === "desktop"
    && reply.targetDeviceId === "laptop" && reply.project === "Receipts QA" && reply.status === "ready");
  check("a reply links to its parent and the thread root", reply.replyToId === parent.id && reply.threadId === parent.id);
  check("retrying a reply returns the same handoff", parsed(await agent("create_handoff", replyArgs)).id === reply.id);
  const other = (await web("/api/handoffs", "POST", { title: "Other root", content: "x", sourceDevice: "laptop", targetDevice: "desktop", requestKey: `${run}-other` })).data;
  ids.push(other.id);
  check("reusing a key with another replyTo conflicts", failed(await agent("create_handoff", { ...replyArgs, replyTo: other.id })) === 409);
  check("without replyTo, MCP still requires targetDevice", failed(await agent("create_handoff", { title: "No route", content: "x", requestKey: `${run}-no-route` })) === 400);
  const foreign = (await web("/api/handoffs", "POST", { title: "Private", content: "secret", sourceDevice: "a", targetDevice: "b", requestKey: `${run}-foreign` }, stranger)).data;
  strangerIds.push(foreign.id);
  const foreignReply = await web("/api/handoffs", "POST", { replyTo: foreign.id, content: "probe", requestKey: `${run}-probe-1` });
  const missingReply = await web("/api/handoffs", "POST", { replyTo: crypto.randomUUID(), content: "probe", requestKey: `${run}-probe-2` });
  check("a foreign and a missing parent answer identically", foreignReply.status === 404 && missingReply.status === 404 && foreignReply.data.error === missingReply.data.error);
  check("replyTo must be an id", (await web("/api/handoffs", "POST", { replyTo: 7, content: "x", requestKey: `${run}-probe-3` })).status === 400);

  const nested = (await web("/api/handoffs", "POST", { replyTo: reply.id, content: "30 seconds.", sourceDevice: "laptop", requestKey: `${run}-nested` })).data;
  ids.push(nested.id);
  check("a reply to a reply keeps one prefix and the same root", nested.title === "Re: Fix login timeout" && nested.replyToId === reply.id
    && nested.threadId === parent.id && nested.targetDeviceId === "desktop");
  const custom = (await web("/api/handoffs", "POST", { replyTo: parent.id, title: "Follow-up", targetDevice: "any", project: "", content: "x", sourceDevice: "laptop", requestKey: `${run}-custom` })).data;
  ids.push(custom.id);
  check("explicit title, target and project override the defaults", custom.title === "Follow-up" && custom.targetDevice === "任意设备" && custom.project === "" && custom.threadId === parent.id);

  const thread = (await web(`/api/handoffs/${nested.id}`)).data.thread;
  check("the thread lists every handoff oldest first", thread.rootId === parent.id && thread.items.map(item => item.id).join() === [parent.id, reply.id, nested.id, custom.id].join());
  check("thread items carry metadata only", thread.items.every(item => !("content" in item) && !("result" in item)) && thread.items[0].hasResult === true && thread.items[1].hasResult === false);
  check("the thread is the same from the root", (await web(`/api/handoffs/${parent.id}`)).data.thread.items.length === 4);
  check("another owner cannot read the thread", (await web(`/api/handoffs/${parent.id}`, "GET", undefined, stranger)).status === 404);

  // Receipt lifecycle in the browser routes.
  const undone = await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "claimed", version: 3, undo: true });
  check("undoing a completion keeps the receipt", undone.data.status === "claimed" && undone.data.result === receipt);
  check("an undo cannot write a receipt", (await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "ready", version: 4, undo: true, result: "x" })).status === 400);
  const redone = await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "done", version: 4 });
  check("completing again without a receipt keeps the earlier one", redone.data.status === "done" && redone.data.result === receipt);
  const requeued = await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "ready", version: 5 });
  check("requeueing clears the receipt", requeued.data.status === "ready" && requeued.data.result === null);
  await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "claimed", version: 6, device: "desktop" });
  const browserDone = await web(`/api/handoffs/${parent.id}`, "PATCH", { status: "done", version: 7, result: "Done from the browser." });
  check("the browser route completes with a receipt", browserDone.data.result === "Done from the browser." && browserDone.data.version === 8);

  // The thread cap counts every row of the thread; a retry of an accepted reply still replays.
  const room = 100 - 4;
  for (let start = 0; start < room; start += 12) {
    const batch = Array.from({ length: Math.min(12, room - start) }, (_, offset) => web("/api/handoffs", "POST", { replyTo: parent.id, content: `filler ${start + offset}`, sourceDevice: "laptop", requestKey: `${run}-fill-${start + offset}` }));
    for (const response of await Promise.all(batch)) { assert.equal(response.status, 201); ids.push(response.data.id); }
  }
  const full = await web("/api/handoffs", "POST", { replyTo: nested.id, content: "one too many", sourceDevice: "laptop", requestKey: `${run}-overflow` });
  check("a thread holds at most 100 handoffs", full.status === 409);
  check("a retry of an accepted reply still replays when the thread is full", (await web("/api/handoffs", "POST", { replyTo: reply.id, content: "30 seconds.", sourceDevice: "laptop", requestKey: `${run}-nested` })).data.id === nested.id);
  check("the thread view is bounded", (await web(`/api/handoffs/${parent.id}`)).data.thread.items.length === 100);

  // Deleting a parent never touches its replies.
  const parentNow = (await web(`/api/handoffs/${parent.id}`)).data;
  assert.equal((await web(`/api/handoffs/${parent.id}`, "DELETE", { version: parentNow.version })).status, 200);
  const orphan = (await web(`/api/handoffs/${reply.id}`)).data;
  check("a reply outlives its deleted parent", orphan.replyToId === parent.id && orphan.thread.rootId === parent.id && !orphan.thread.items.some(item => item.id === parent.id));
  check("a deleted parent cannot be replied to", (await web("/api/handoffs", "POST", { replyTo: parent.id, content: "late", requestKey: `${run}-late` })).status === 404);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  for (const id of ids) await web(`/api/handoffs/${id}`, "DELETE");
  for (const id of strangerIds) await web(`/api/handoffs/${id}`, "DELETE", undefined, stranger);
  for (const id of tokens) await web(`/api/agent-tokens/${id}`, "DELETE");
  for (const device of (await web("/api/devices")).data?.devices ?? []) await web(`/api/devices/${device.id}`, "DELETE", { version: device.version, connections: "unbind" });
}
