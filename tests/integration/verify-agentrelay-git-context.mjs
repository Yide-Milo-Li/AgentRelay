// Git context (branch and base commit) on handoffs over the built Worker: both MCP endpoints, the browser routes and retries.
import assert from "node:assert/strict";
import { testRequest } from "../support/integration-http.mjs";
const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Git context checks only run against a local database.");
const run = crypto.randomUUID(), owner = `git-context-qa-${run}`, stranger = `git-context-other-${run}`;
const ids = [], tokens = [], passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
async function request(path, method = "GET", data, headers = {}) {
  return testRequest(base + path, { method, headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
}
const identity = user => ({ "oai-authenticated-user-id": user });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const web = (path, method, data, user = owner) => request(path, method, data, identity(user));
const call = (endpoint, headers) => (name, args) => request(endpoint, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
const parsed = response => JSON.parse(response.data.result.content[0].text);
const failed = response => response.status === 200 && response.data.result.isError === true ? response.data.result.structuredContent.error.status : null;
const SHA1 = "0123456789abcdef0123456789abcdef01234567", OTHER = "0".repeat(40), SHA256 = "ab".repeat(32);
try {
  for (const device of [{ name: "Laptop", id: "laptop" }, { name: "Desktop", id: "desktop" }])
    assert.equal((await web("/api/devices", "POST", device)).status, 201);
  const issued = (await web("/api/agent-tokens", "POST", { name: "Laptop agent", deviceId: "laptop", expiresInDays: 1 })).data;
  tokens.push(issued.id);
  const agent = call("/api/agent/mcp", bearer(issued.token)), platform = call("/mcp", identity(owner));

  const tools = (await request("/api/agent/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(issued.token))).data.result.tools;
  const create = tools.find(item => item.name === "create_handoff");
  check("tools/list still has five tools", tools.length === 5);
  check("create_handoff accepts branch and baseCommit", create.inputSchema.properties.branch && create.inputSchema.properties.baseCommit);

  // A project sends creation through the batch path; without one it is a plain insert. Both store the context.
  const args = { title: "Continue git context", content: "## Next Steps\n- [ ] wire the UI\n", project: "Git Context QA", targetDevice: "desktop",
    branch: "refs/heads/feat/git-context", baseCommit: SHA1.toUpperCase(), requestKey: `${run}-batch` };
  const sent = parsed(await agent("create_handoff", args)); ids.push(sent.id);
  check("the batch path stores normalized git context", sent.branch === "feat/git-context" && sent.baseCommit === SHA1 && sent.sourceDeviceId === "laptop");
  check("storage column names stay off the wire", !("gitBranch" in sent) && !("gitBaseCommit" in sent));
  const plain = (await web("/api/handoffs", "POST", { title: "Detached", content: "x", sourceDevice: "laptop", targetDevice: "desktop", baseCommit: SHA256, requestKey: `${run}-plain` })).data;
  ids.push(plain.id);
  check("the plain path stores a detached base commit", plain.branch === null && plain.baseCommit === SHA256);
  const none = (await web("/api/handoffs", "POST", { title: "No git", content: "x", sourceDevice: "laptop", targetDevice: "desktop", requestKey: `${run}-none` })).data;
  ids.push(none.id);
  check("a handoff without git context stores nulls", none.branch === null && none.baseCommit === null);

  check("platform MCP reads the exact context", (({ branch, baseCommit }) => branch === "feat/git-context" && baseCommit === SHA1)(parsed(await platform("get_handoff", { id: sent.id }))));
  check("the browser route reads it", (await web(`/api/handoffs/${sent.id}`)).data.branch === "feat/git-context");
  const row = parsed(await platform("list_handoffs", { status: "ready", targetDevice: "desktop" })).handoffs.find(item => item.id === sent.id);
  check("list_handoffs rows carry it", row?.branch === "feat/git-context" && row.baseCommit === SHA1);
  check("the inbox route carries it", (await web("/api/handoffs")).data.handoffs.find(item => item.id === sent.id)?.baseCommit === SHA1);

  // Retries: the context is part of the idempotent payload, compared after normalization.
  check("an identical retry returns the original", parsed(await agent("create_handoff", { ...args, branch: "feat/git-context", baseCommit: SHA1 })).id === sent.id);
  check("a retry with another base commit conflicts", failed(await agent("create_handoff", { ...args, baseCommit: OTHER })) === 409);
  check("a retry with another branch conflicts", failed(await agent("create_handoff", { ...args, branch: "main" })) === 409);
  check("a retry that drops the context conflicts", failed(await agent("create_handoff", { ...args, branch: undefined, baseCommit: undefined })) === 409);

  // Invalid values are refused before anything is written.
  const before = (await web("/api/handoffs")).data.handoffs.length;
  for (const [name, bad] of [["an abbreviated hash", { baseCommit: "0123456" }], ["a branch without its commit", { branch: "main" }],
    ["a branch git refuses", { branch: "feat..x", baseCommit: SHA1 }], ["a non-string branch", { branch: 7, baseCommit: SHA1 }]])
    check(`${name} is refused`, failed(await agent("create_handoff", { title: "Bad", content: "x", targetDevice: "desktop", requestKey: `${run}-bad-${name}`, ...bad })) === 400);
  check("refused requests create nothing", (await web("/api/handoffs")).data.handoffs.length === before);

  // A reply does not inherit the parent's context.
  const reply = parsed(await call("/api/agent/mcp", bearer(issued.token))("create_handoff", { replyTo: sent.id, content: "Question", requestKey: `${run}-reply` }));
  ids.push(reply.id);
  check("a reply leaves git context empty", reply.replyToId === sent.id && !("branch" in reply) && !("baseCommit" in reply)
    && (await web(`/api/handoffs/${reply.id}`)).data.branch === null);

  // The lifecycle never changes it.
  await agent("claim_handoff", { id: sent.id, device: "desktop", version: 1 });
  const done = parsed(await agent("complete_handoff", { id: sent.id, version: 2, result: "## Summary\nDone." }));
  check("claiming and completing keep the context", done.status === "done" && done.branch === "feat/git-context" && done.baseCommit === SHA1);
  check("another owner cannot read it", (await web(`/api/handoffs/${sent.id}`, "GET", undefined, stranger)).status === 404);
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  for (const id of ids) await web(`/api/handoffs/${id}`, "DELETE");
  for (const id of tokens) await web(`/api/agent-tokens/${id}`, "DELETE");
  for (const device of (await web("/api/devices")).data?.devices ?? []) await web(`/api/devices/${device.id}`, "DELETE", { version: device.version, connections: "unbind" });
}
