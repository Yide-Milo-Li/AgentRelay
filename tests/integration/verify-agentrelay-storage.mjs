// Exercise the built Worker and real local D1. SQL fixtures and cleanup are restricted to disposable owners.
import assert from "node:assert/strict";
import { executeLocalSql } from "../support/local-storage-fixtures.mjs";
import { testRequest } from "../support/integration-http.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Storage checks require a local database.");
const run = crypto.randomUUID(), owner = `storage-qa-${run}`, stranger = `storage-other-${run}`;
const output = path.resolve(`outputs/storage/${run}`), passed = [];
await mkdir(output, { recursive: true });
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); console.log(`PASS ${name}`); };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = executeLocalSql;
async function request(route, method = "GET", data, user = owner, extra = {}) {
  return testRequest(base + route, { method, headers: { ...(user ? { "oai-authenticated-user-id": user } : {}), "Content-Type": "application/json", Connection: "close", ...extra },
    body: data === undefined ? undefined : JSON.stringify(data) });
}
const create = async (content = "payload", title = "Storage check", user = owner) => {
  const response = await request("/api/handoffs", "POST", { title, content, project: "Storage QA", sourceDevice: "Laptop", targetDevice: "Desktop", requestKey: crypto.randomUUID() }, user);
  assert.equal(response.status, 201); return response.data;
};
const remove = items => request("/api/storage/handoffs/delete", "POST", { items });
let migrationEvidence;
try {
  for (const route of ["/api/storage", "/api/storage/handoffs", "/api/storage/handoffs/missing"])
    check(`authentication required: ${route}`, (await request(route, "GET", undefined, null)).status === 401);
  check("unauthenticated deletion rejected", (await request("/api/storage/handoffs/delete", "POST", { items: [] }, null)).status === 401);
  const initial = await request("/api/storage");
  check("empty owner has zero prompt data and a real instance measurement", initial.data.handoffs.count === 0 && initial.data.handoffs.promptBytes === 0 && initial.data.databaseBytes > 0 && initial.data.limitBytes === 10_000_000_000);
  check("storage responses are not cacheable", initial.headers.get("Cache-Control") === "no-store");
  const contents = ["English", "中文", "🚀🙂", "line\r\n\t  trailing  \n", "中".repeat(200_000)];
  const originals = [];
  for (const content of contents) originals.push(await create(content));
  const page = (await request("/api/storage/handoffs")).data;
  check("UTF-8 sizes preserve English, Chinese, emoji, CRLF and maximum prompts", originals.every(row => page.handoffs.find(item => item.id === row.id)?.promptBytes === Buffer.byteLength(row.content)));
  check("management list contains metadata without content or private identity", page.handoffs.every(row => !("content" in row) && !("ownerId" in row) && !("requestKey" in row)));
  const largest = originals.at(-1);
  check("default order is largest first", page.handoffs[0].id === largest.id);
  const foreign = await create("private foreign prompt", "Foreign", stranger);
  check("management detail does not reveal another owner", (await request(`/api/storage/handoffs/${foreign.id}`)).status === 404);
  check("client-supplied owner cannot change summary scope", (await request(`/api/storage?ownerId=${stranger}`)).data.handoffs.count === originals.length);
  await sql(`UPDATE handoffs SET expires_at = 1 WHERE owner_id = ${quote(owner)} AND id = ${quote(largest.id)};`);
  check("an expired handoff is hidden outside Storage", (await request(`/api/handoffs/${largest.id}`)).status === 404);
  const totals = (await request("/api/storage")).data;
  check("measuring Storage first deletes expired handoffs", totals.groups.expired.count === 0 && totals.handoffs.count === originals.length - 1 && (await request(`/api/storage/handoffs/${largest.id}`)).status === 404);
  check("lifecycle categories still add up to the total", totals.groups.ready.count === 4 && Object.values(totals.groups).reduce((sum, group) => sum + group.count, 0) === totals.handoffs.count);
  check("byte totals no longer include the deleted prompt", totals.handoffs.promptBytes === contents.slice(0, -1).reduce((sum, content) => sum + Buffer.byteLength(content), 0));
  for (const items of [[], [{ id: "same", version: 1 }, { id: "same", version: 2 }], [{ id: largest.id }], Array.from({ length: 51 }, (_, index) => ({ id: `${index}`, version: 1 }))])
    check("invalid batch rejected without deleting rows", (await remove(items)).status === 400);
  check("filter-based deletion rejected", (await request("/api/storage/handoffs/delete", "POST", { status: "done" })).status === 400);
  check("cross-origin deletion rejected", (await request("/api/storage/handoffs/delete", "POST", { items: [{ id: largest.id, version: 1 }] }, owner, { Origin: "https://untrusted.example" })).status === 403);
  check("oversized deletion body rejected", (await request("/api/storage/handoffs/delete", "POST", { padding: "x".repeat(1_250_001) })).status === 413);
  const changed = originals[0], untouched = originals[1];
  assert.equal((await request(`/api/handoffs/${changed.id}`, "PATCH", { status: "claimed", device: "Desktop", version: changed.version })).status, 200);
  const mixed = await remove([{ id: changed.id, version: 1 }, { id: untouched.id, version: 1 }, { id: foreign.id, version: 1 }, { id: "missing", version: 1 }]);
  check("partial batch returns 409 and retains successful deletions", mixed.status === 409 && mixed.data.deletedCount === 1 && mixed.data.results.map(item => item.status).join(",") === "conflict,deleted,not_found,not_found");
  check("stale and foreign rows remain intact", (await request(`/api/storage/handoffs/${changed.id}`)).data.version === 2 && (await request(`/api/storage/handoffs/${foreign.id}`, "GET", undefined, stranger)).status === 200);
  check("single deletion honors observed versions", (await request(`/api/handoffs/${changed.id}`, "DELETE", { version: 1 })).status === 409);
  check("single deletion remains compatible without a version", (await request(`/api/handoffs/${changed.id}`, "DELETE")).status === 200);
  const race = await create("race");
  const [deletion, claim] = await Promise.all([remove([{ id: race.id, version: 1 }]), request(`/api/handoffs/${race.id}`, "PATCH", { status: "claimed", device: "Desktop", version: 1 })]);
  check("claim/delete race cannot delete a newly claimed version", claim.status === 200 ? deletion.status === 409 && (await request(`/api/storage/handoffs/${race.id}`)).data.version === 2 : deletion.data.deletedCount === 1 && [404, 409].includes(claim.status));
  const token = (await request("/api/agent-tokens", "POST", { name: "Storage QA", expiresInDays: 1 })).data;
  const rpc = async (endpoint, headers, name, args) => {
    const response = await testRequest(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return response.data.result;
  };
  const removed = await create("transport disappearance"); await remove([{ id: removed.id, version: 1 }]);
  for (const [endpoint, headers] of [["/mcp", { "oai-authenticated-user-id": owner }], ["/api/agent/mcp", { Authorization: `Bearer ${token.token}` }]]) {
    check(`deleted handoff cannot be read through ${endpoint}`, (await rpc(endpoint, headers, "get_handoff", { id: removed.id })).isError);
    check(`deleted handoff cannot be listed through ${endpoint}`, !JSON.parse((await rpc(endpoint, headers, "list_handoffs", {})).content[0].text).handoffs.some(row => row.id === removed.id));
  }
  const device = await request("/api/devices", "POST", { name: "Storage QA Device", id: "storage-qa" });
  check("cleanup does not remove devices or credentials", device.status === 201 && (await request("/api/agent-tokens")).data.tokens.some(item => item.id === token.id));
  // Populate more than the inbox limit, with tied sizes and dates to exercise the cursor tie-breaker.
  const now = Date.now(), statements = [];
  for (let index = 0; index < 525; index++) {
    const id = `fixture-${run}-${String(index).padStart(4, "0")}`, content = "x".repeat(index % 7 + 1), status = ["ready", "claimed", "done"][index % 3];
    const created = now - (index % 4 === 0 ? 40 : 1) * 86_400_000, expiry = index % 5 === 0 ? now + 86_400_000 : "NULL";
    statements.push(`INSERT INTO handoffs(id,owner_id,title,project,source_device,target_device,content,status,created_at,updated_at,expires_at,version) VALUES (${quote(id)},${quote(owner)},${quote(`Fixture ${index}`)},'Archive','Laptop','Desktop',${quote(content)},${quote(status)},${created},${created},${expiry},1);`);
  }
  const fixturePath = path.join(output, "fixtures.sql"); await writeFile(fixturePath, statements.join("\n"));
  await executeLocalSql(statements);
  const seen = new Set(); let cursor = null, firstCursor;
  do {
    const query = new URLSearchParams({ project: "Archive", sort: "largest", ...(cursor ? { cursor } : {}) });
    const response = await request(`/api/storage/handoffs?${query}`); assert.equal(response.status, 200);
    for (const row of response.data.handoffs) { assert.ok(!seen.has(row.id), "cursor repeats a row"); seen.add(row.id); }
    cursor = response.data.nextCursor; firstCursor ??= cursor;
  } while (cursor);
  check("keyset pagination reaches every record beyond 500 with tied sort keys", seen.size === 525);
  check("cursor cannot be reused under another filter", (await request(`/api/storage/handoffs?${new URLSearchParams({ project: "Other", cursor: firstCursor })}`)).status === 400);
  for (const query of [{ project: "Archive", status: "done", expiration: "unexpired" }, { project: "Archive", ageDays: "30", minBytes: "5", sourceDevice: "Laptop", targetDevice: "Desktop" }, { search: "Fixture 5", sort: "oldest" }]) {
    const response = await request(`/api/storage/handoffs?${new URLSearchParams(query)}`);
    check(`combined filters work: ${JSON.stringify(query)}`, response.status === 200 && response.data.totalCount > 0 && response.data.handoffs.every(row => query.search ? row.title.includes(query.search) : row.project === "Archive"));
  }
  for (const sort of ["smallest", "oldest", "newest", "updated"]) {
    const response = await request(`/api/storage/handoffs?project=Archive&sort=${sort}`);
    const field = sort === "smallest" ? "promptBytes" : sort === "updated" ? "updatedAt" : "createdAt", asc = ["smallest", "oldest"].includes(sort);
    check(`ordering works: ${sort}`, response.data.handoffs.every((row, index, list) => index === 0 || (asc ? list[index - 1][field] <= row[field] : list[index - 1][field] >= row[field])));
  }
  // An expired backlog larger than one sweep (4 chunks of 50) drains over successive requests, never in one unbounded one.
  const backlog = [];
  for (let index = 0; index < 230; index++)
    backlog.push(`INSERT INTO handoffs(id,owner_id,title,project,source_device,target_device,content,status,created_at,updated_at,expires_at,version) VALUES (${quote(`backlog-${run}-${index}`)},${quote(owner)},'Backlog','Backlog','Laptop','Desktop','x','ready',${now},${now},${now - 1000 - index},1);`);
  const backlogPath = path.join(output, "backlog.sql"); await writeFile(backlogPath, backlog.join("\n"));
  await executeLocalSql(backlog);
  const firstSweep = (await request("/api/storage")).data, secondSweep = (await request("/api/storage")).data;
  check("an expired backlog is deleted in bounded steps", firstSweep.groups.expired.count === 30 && secondSweep.groups.expired.count === 0
    && (await request("/api/storage/handoffs?project=Backlog")).data.totalCount === 0);
  check("the purge leaves unexpired fixtures alone", (await request("/api/storage/handoffs?project=Archive")).data.totalCount === 525);
  const empty = (await request("/api/storage/handoffs?project=NoSuchProject")).data;
  check("empty filters have no next page", empty.totalCount === 0 && empty.handoffs.length === 0 && empty.nextCursor === null);
  const summaryProbe = `SELECT CASE WHEN expires_at IS NOT NULL AND expires_at <= ${now} THEN 'expired' ELSE status END AS category,
    COUNT(*), COALESCE(SUM(length(CAST(content AS BLOB)) + attachment_bytes),0) - COALESCE(SUM(attachment_bytes),0), COALESCE(SUM(attachment_count),0), COALESCE(SUM(attachment_bytes),0) FROM handoffs INDEXED BY handoffs_owner_logical WHERE owner_id = ${quote(owner)} GROUP BY category`;
  const plan = await sql(`EXPLAIN QUERY PLAN ${summaryProbe};`);
  const details = plan.flatMap(result => result.results).map(row => row.detail).join("; ");
  const opcodes = (await sql(`EXPLAIN ${summaryProbe};`)).flatMap(result => result.results);
  const tableRoot = (await sql("SELECT rootpage FROM sqlite_master WHERE name = 'handoffs';"))[0].results[0].rootpage;
  const tableCursors = new Set(opcodes.filter(row => row.opcode === "OpenRead" && row.p2 === tableRoot).map(row => row.p1));
  // This D1 SQLite version reports USING INDEX, even when every Column opcode reads only the index or temp sorter.
  check("D1 summary reads the byte index without loading table columns", /INDEX handoffs_owner_logical/.test(details)
    && !opcodes.some(row => row.opcode === "Column" && tableCursors.has(row.p1)));
  const indexPlan = await sql(`EXPLAIN QUERY PLAN SELECT id, length(CAST(content AS BLOB)) + attachment_bytes FROM handoffs WHERE owner_id = ${quote(owner)} ORDER BY length(CAST(content AS BLOB)) + attachment_bytes DESC, id DESC LIMIT 51;`);
  check("D1 uses the byte index for largest-first pagination", indexPlan.flatMap(result => result.results).some(row => /INDEX handoffs_owner_logical/.test(row.detail)));
  migrationEvidence = { summaryQueryPlan: details, summaryOpcodes: opcodes, listingQueryPlan: indexPlan, syntheticRows: 525 };
  await writeFile(path.join(output, "results.json"), JSON.stringify({ base, passed, migrationEvidence }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, output }));
} finally {
  for (const table of ["handoffs", "agent_tokens", "devices"]) await sql(`DELETE FROM ${table} WHERE owner_id IN (${quote(owner)},${quote(stranger)});`);
}
