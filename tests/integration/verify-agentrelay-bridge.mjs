// Runs the five-tool handoff flow through the local stdio bridge against a built local Worker, the same path an
// agent that only speaks stdio takes. Uses an isolated owner and removes what it creates.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Bridge checks only run against a local database.");
const run = crypto.randomUUID().slice(0, 8), owner = `bridge-qa-${run}`;
const passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };

async function api(path, method = "GET", data) {
  return testRequest(base + path, { method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { "Content-Type": "application/json", ...identityHeaders(owner) } });
}

let child, token, handoffId;
try {
  const issued = await api("/api/agent-tokens", "POST", { name: `bridge check ${run}`, expiresInDays: 30 });
  check("a connection is issued for the bridge check", issued.status === 201 && /^agentrelay_[a-f0-9]{64}$/.test(issued.data.token));
  token = issued.data;

  child = spawn(process.execPath, ["scripts/agents/mcp-bridge.mjs"], {
    cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    // A local Worker ignores the gateway header; the bridge still requires one, as it does on a protected Site.
    env: { ...process.env, AGENTRELAY_MCP_URL: `${base}/api/agent/mcp`, AGENTRELAY_AGENT_TOKEN: token.token, AGENTRELAY_SITES_GATEWAY_TOKEN: "local-worker-needs-no-gateway" },
  });
  let stderr = "", nextId = 1;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No answer to ${method} within 30 seconds`)); }, 30000);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  const tool = async (name, args) => { const reply = await call("tools/call", { name, arguments: args }); return { reply, data: reply.result?.isError ? null : JSON.parse(reply.result.content[0].text) }; };

  const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bridge-check", version: "1" } });
  check("initialize passes through the bridge", init.result?.serverInfo?.name === "AgentRelay" && typeof init.result.protocolVersion === "string");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await call("tools/list");
  check("all five tools are listed", JSON.stringify(listed.result.tools.map((item) => item.name).sort()) === JSON.stringify(["claim_handoff", "complete_handoff", "create_handoff", "get_handoff", "list_handoffs"]));

  const content = "# Bridge check\r\n  exact text 中文 🚀\n```sh\necho '$VALUE'\n```\n";
  const created = await tool("create_handoff", { title: `Bridge ${run}`, content, project: "Bridge QA", sourceDevice: "bridge-sender", targetDevice: "bridge-receiver", requestKey: `bridge-${run}` });
  handoffId = created.data?.id;
  check("create_handoff stores the prompt", !!handoffId && created.data.status === "ready");
  const waiting = await tool("list_handoffs", { targetDevice: "bridge-receiver", status: "ready" });
  check("list_handoffs finds it for the receiving device", waiting.data.handoffs.some((row) => row.id === handoffId));
  const fetched = await tool("get_handoff", { id: handoffId });
  check("get_handoff returns the exact text", fetched.data.prompt === content);
  const claimed = await tool("claim_handoff", { id: handoffId, device: "bridge-receiver", version: fetched.data.version });
  check("claim_handoff moves it to claimed", claimed.data?.status === "claimed");
  const stale = await tool("claim_handoff", { id: handoffId, device: "bridge-receiver", version: fetched.data.version });
  check("a stale version is refused through the bridge too", stale.reply.result.isError === true && stale.reply.result.structuredContent.error.status === 409);
  const done = await tool("complete_handoff", { id: handoffId, version: claimed.data.version });
  check("complete_handoff finishes it", done.data?.status === "done");

  child.stdin.end();
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge did not exit within 10 seconds after stdin closed")), 10_000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  check("the bridge exits cleanly when its input closes and wrote nothing to stderr", exit === 0 && stderr === "");
  check("the bridge never echoed a credential", !JSON.stringify(passed).includes(token.token));
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  child?.kill();
  if (handoffId) {
    const row = await api(`/api/handoffs/${handoffId}`).catch(() => null);
    if (row?.data?.version) await api(`/api/handoffs/${handoffId}`, "DELETE", { version: row.data.version }).catch(() => {});
  }
  if (token?.id) {
    await api(`/api/agent-tokens/${token.id}`, "DELETE").catch(() => {});
    await api(`/api/agent-tokens/${token.id}?permanent=1`, "DELETE").catch(() => {});
  }
}
