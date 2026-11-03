// Exercise the project registry through the built Worker and real local D1: auto-creation, name keys, idempotency,
// races, legacy reconciliation, rename/merge/delete with CAS, owner isolation and both MCP tools that take a project.
import assert from "node:assert/strict";
import { executeLocalSql } from "../support/local-storage-fixtures.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { identityHeaders } from "../support/test-identity.mjs";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Project checks require a local database.");
const run = crypto.randomUUID(), owner = `projects-qa-${run}`, stranger = `projects-other-${run}`, passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); console.log(`PASS ${name}`); };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = executeLocalSql;
async function request(route, method = "GET", data, user = owner, extra = {}) {
  return testRequest(base + route, { method, headers: { ...(user ? { ...identityHeaders(user) } : {}), "Content-Type": "application/json", ...extra },
    body: data === undefined ? undefined : JSON.stringify(data) });
}
const send = (project, extra = {}, user = owner) => request("/api/handoffs", "POST",
  { title: "Project check", content: "payload", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID(), ...(project === undefined ? {} : { project }), ...extra }, user);
const projects = async (user = owner) => (await request("/api/projects", "GET", undefined, user)).data.projects;
const rpc = async (name, args, user = owner) => {
  const result = (await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, user)).data.result;
  return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
};

try {
  check("project routes require sign-in", (await request("/api/projects", "GET", undefined, null)).status === 401);
  check("cross-origin project creation rejected", (await request("/api/projects", "POST", { name: "X" }, owner, { Origin: "https://untrusted.example" })).status === 403);

  // Auto-creation and name keys.
  const first = await send("  Agent   Relay ");
  check("a new project name creates the project", first.status === 201 && first.data.project === "Agent Relay" && /^p-[a-z2-7]{10}$/.test(first.data.projectId));
  const variant = await send("agent-relay");
  check("a variant spelling joins the same project under its stored name", variant.data.projectId === first.data.projectId && variant.data.project === "Agent Relay");
  const byId = await send(first.data.projectId);
  check("a project id is accepted as the reference", byId.data.projectId === first.data.projectId);
  const none = await send("   ");
  check("a blank project means no project", none.status === 201 && none.data.project === "" && none.data.projectId === null);
  check("a name with no letter or digit is rejected", (await send("-._")).status === 400);
  check("an overlong project name is rejected", (await send("p".repeat(121))).status === 400);
  let list = await projects();
  check("the list holds one project with its colour and use time", list.length === 1 && list[0].name === "Agent Relay" && list[0].line !== "neutral" && list[0].archived === false);

  // Idempotency compares the project by key.
  const key = crypto.randomUUID();
  const original = await send("Web App", { requestKey: key });
  check("a retry differing only in case and separators replays", (await send("web_app", { requestKey: key })).data.id === original.data.id);
  check("a retry with a different project conflicts", (await send("Other", { requestKey: key })).status === 409);
  check("a retry without the project conflicts", (await send(undefined, { requestKey: key })).status === 409);

  // Two senders racing on one new name end up in one project.
  const raced = await Promise.all(["Race Project", "race-project", "RACE_PROJECT"].map(name => send(name)));
  check("concurrent creates of one new name yield one project", raced.every(r => r.status === 201) && new Set(raced.map(r => r.data.projectId)).size === 1);
  check("the race created exactly one row", (await projects()).filter(p => p.name.toLowerCase().replace(/[^a-z]/g, "") === "raceproject").length === 1);

  // Legacy rows: names only, filed on the next project read.
  const legacy = await send(undefined), legacyVariant = await send(undefined);
  await sql(`UPDATE handoffs SET project = 'legacy-tool', project_id = NULL WHERE owner_id = ${quote(owner)} AND id = ${quote(legacy.data.id)};`);
  await sql(`UPDATE handoffs SET project = 'Legacy Tool', project_id = NULL WHERE owner_id = ${quote(owner)} AND id = ${quote(legacyVariant.data.id)};`);
  await sql(`UPDATE handoffs SET project = 'web app', project_id = NULL WHERE owner_id = ${quote(owner)} AND id = ${quote(none.data.id)};`);
  list = await projects();
  const legacyProject = list.find(p => p.name === "Legacy Tool" || p.name === "legacy-tool"), webApp = list.find(p => p.name === "Web App");
  const rows = (await request("/api/handoffs")).data.handoffs, byIdOf = id => rows.find(r => r.id === id);
  check("legacy spellings are filed under one new project", legacyProject && byIdOf(legacy.data.id).projectId === legacyProject.id && byIdOf(legacyVariant.data.id).projectId === legacyProject.id);
  check("legacy snapshots take the project's name", byIdOf(legacy.data.id).project === legacyProject.name);
  check("a legacy name matching an existing project joins it", byIdOf(none.data.id).projectId === webApp.id && byIdOf(none.data.id).project === "Web App");
  check("reconciling twice is a no-op", (await projects()).length === list.length);

  // MCP: creation, key matching in the filter, projectId in results.
  const mcp = await rpc("create_handoff", { title: "MCP project", content: "x", project: "AGENT.RELAY", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: `${run}-mcp` });
  check("MCP create files under the existing project", mcp.projectId === first.data.projectId);
  const filtered = await rpc("list_handoffs", { project: "agent relay" });
  check("MCP filters by name key", filtered.handoffs.length === 4 && filtered.handoffs.every(r => r.projectId === first.data.projectId));
  check("MCP filters by project id", (await rpc("list_handoffs", { project: first.data.projectId })).handoffs.length === 4);
  check("an unknown project filter matches nothing", (await rpc("list_handoffs", { project: "nothing-like-this" })).handoffs.length === 0);
  const storage = async project => (await request(`/api/storage/handoffs?project=${encodeURIComponent(project)}`)).data.handoffs.map(row => row.id);
  check("Storage filters by project id", (await storage(first.data.projectId)).length === 4);
  check("Storage filters by project name key", (await storage("Agent_Relay")).length === 4);
  check("Storage keeps exact matching for text no project answers to", (await storage("nothing-like-this")).length === 0);
  check("the HTTP list filter (unchanged) still works without a project", (await request("/api/handoffs")).data.handoffs.length >= 10);

  // Owner isolation.
  check("another owner sees no projects", (await projects(stranger)).length === 0);
  const foreign = await send("Agent Relay", {}, stranger);
  check("the same name in another workspace is a separate project", foreign.data.projectId !== first.data.projectId);
  check("another owner cannot rename a project", (await request(`/api/projects/${first.data.projectId}`, "PATCH", { name: "Stolen", version: 1 }, stranger)).status === 404);
  check("another owner cannot delete a project", (await request(`/api/projects/${first.data.projectId}`, "DELETE", { version: 1 }, stranger)).status === 404);
  check("a project id from another workspace creates a new local project instead of linking", (await send(foreign.data.projectId)).data.projectId !== foreign.data.projectId);

  // Rename, archive and the CAS on version.
  let agent = (await projects()).find(p => p.id === first.data.projectId);
  const renamed = await request(`/api/projects/${agent.id}`, "PATCH", { name: "AgentRelay Core", version: agent.version });
  check("rename bumps the version", renamed.status === 200 && renamed.data.name === "AgentRelay Core" && renamed.data.version === agent.version + 1);
  check("rename rewrites the handoff snapshots", (await request(`/api/handoffs/${first.data.id}`)).data.project === "AgentRelay Core");
  check("a stale rename conflicts", (await request(`/api/projects/${agent.id}`, "PATCH", { name: "Again", version: agent.version }, owner)).status === 409);
  check("renaming onto another project's key conflicts", (await request(`/api/projects/${agent.id}`, "PATCH", { name: "web-app", version: renamed.data.version })).status === 409);
  const archived = await request(`/api/projects/${agent.id}`, "PATCH", { archived: true, version: renamed.data.version });
  check("archiving works", archived.data.archived === true);
  await send("agentrelay core");
  agent = (await projects()).find(p => p.id === agent.id);
  check("sending to an archived project unarchives it and bumps its version", agent.archived === false && agent.version === archived.data.version + 1);
  check("a patch that changes nothing is rejected", (await request(`/api/projects/${agent.id}`, "PATCH", { version: agent.version })).status === 400);
  check("explicit creation of an existing key conflicts", (await request("/api/projects", "POST", { name: "Agent-Relay  core" })).status === 409);
  const made = await request("/api/projects", "POST", { name: "Manual", line: "teal" });
  check("explicit creation honours the colour", made.status === 201 && made.data.line === "teal");

  // Merge and delete.
  const legacyNow = (await projects()).find(p => p.id === legacyProject.id);
  check("merging into itself is rejected", (await request(`/api/projects/${legacyNow.id}/merge`, "POST", { into: legacyNow.id, version: legacyNow.version })).status === 400);
  check("a stale merge conflicts", (await request(`/api/projects/${legacyNow.id}/merge`, "POST", { into: agent.id, version: legacyNow.version + 5 })).status === 409);
  const merged = await request(`/api/projects/${legacyNow.id}/merge`, "POST", { into: agent.id, version: legacyNow.version });
  check("merge moves every handoff", merged.status === 200 && merged.data.movedHandoffs === 2 && merged.data.into.id === agent.id);
  const movedRow = (await request(`/api/handoffs/${legacy.data.id}`)).data;
  check("merged handoffs take the target's id and name", movedRow.projectId === agent.id && movedRow.project === "AgentRelay Core");
  check("the merged project is gone", !(await projects()).some(p => p.id === legacyNow.id));
  const web = (await projects()).find(p => p.id === webApp.id);
  const deleted = await request(`/api/projects/${web.id}`, "DELETE", { version: web.version });
  check("delete detaches its handoffs", deleted.status === 200 && deleted.data.detachedHandoffs === 2);
  const detached = (await request(`/api/handoffs/${original.data.id}`)).data;
  check("detached handoffs have no project", detached.project === "" && detached.projectId === null);
  check("a deleted project does not come back on the next read", !(await projects()).some(p => p.name === "Web App"));
  check("deleting a missing project answers 404", (await request(`/api/projects/${web.id}`, "DELETE", { version: 1 })).status === 404);

  console.log(JSON.stringify({ passed: passed.length }));
} finally {
  for (const table of ["handoffs", "projects", "devices"]) await sql(`DELETE FROM ${table} WHERE owner_id IN (${quote(owner)},${quote(stranger)});`);
}
