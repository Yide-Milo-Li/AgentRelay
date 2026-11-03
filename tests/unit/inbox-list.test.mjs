// The browser side of the paged inbox list: the request for a query, a full record as a list row, and list membership.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const list = await loadTypeScriptModule("src/features/handoffs/inbox-list.ts");
const query = (overrides = {}) => ({ scope: "open", status: "all", target: "all", project: "all", q: "", ...overrides });
const params = path => Object.fromEntries(new URL(path, "https://relay.example").searchParams);
const record = (overrides = {}) => ({
  id: "h1", title: "Title", project: "", sourceDevice: "Laptop", targetDevice: "Desktop", content: "Prompt", status: "ready", claimedBy: null,
  createdAt: 1, updatedAt: 2, expiresAt: null, version: 1, sourceDeviceId: "laptop", targetDeviceId: "desktop", claimedByDeviceId: null,
  projectId: null, createdByName: null, attachments: [], result: null, replyToId: null, threadId: null, branch: null, baseCommit: null, ...overrides,
});

test("the request carries only the filters that narrow the list", () => {
  assert.deepEqual(params(list.listPath(query(), { limit: 50 })), { view: "summary", scope: "open", limit: "50" });
  assert.deepEqual(params(list.listPath(query({ status: "ready", target: "d:desktop", project: "p:p1", q: "  needle " }), { limit: 120, cursor: "abc" })),
    { view: "summary", scope: "open", status: "ready", target: "desktop", project: "p1", q: "  needle ", limit: "120", cursor: "abc" });
  assert.deepEqual(params(list.listPath(query({ scope: "done", status: "ready", target: "any", project: "none", q: "   " }), { limit: 50 })),
    { view: "summary", scope: "done", target: "any", project: "none", limit: "50" }, "the status chip and blank search do not apply to Done");
});

test("the request stays inside the server's limits", () => {
  assert.equal(params(list.listPath(query(), { limit: 900 })).limit, "500");
  assert.equal(params(list.listPath(query(), { limit: 0 })).limit, "1");
  assert.equal(params(list.listPath(query({ q: "x".repeat(300) }), { limit: 50 })).q.length, 200);
  assert.equal(list.projectCountsPath("all"), "/api/handoffs?view=project-counts&scope=all");
});

test("a full record becomes the list row the server would send", () => {
  const item = list.listItemOf(record({ content: "😀".repeat(200), result: "Done", attachments: [{ id: "a" }, { id: "b" }], projectId: "p1", project: "Alpha" }));
  assert.equal(item.characters, 200, "characters are counted in code points, as SQLite counts them");
  assert.equal([...item.preview].length, 180);
  assert.equal(item.attachmentCount, 2);
  assert.deepEqual([item.resultPreview, item.resultCharacters], ["Done", 4]);
  assert.equal(item.projectId, "p1");
  const bare = list.listItemOf(record());
  for (const key of ["claimedBy", "expiresAt", "projectId", "project", "attachmentCount", "resultPreview", "resultCharacters", "replyToId", "branch"]) assert.equal(key in bare, false, key);
  assert.equal("content" in bare || "attachments" in bare || "result" in bare, false);
});

test("membership follows the scope and the inbox's status chip", () => {
  assert.equal(list.inList("claimed", query()), true);
  assert.equal(list.inList("done", query()), false);
  assert.equal(list.inList("claimed", query({ status: "ready" })), false);
  assert.equal(list.inList("done", query({ scope: "done", status: "ready" })), true);
});

test("a write replaces its row, or takes it out of a list it left", () => {
  const rows = [list.listItemOf(record({ id: "a" })), list.listItemOf(record({ id: "b" }))];
  const claimed = list.withWrite(rows, record({ id: "a", status: "claimed", version: 2 }), query());
  assert.deepEqual(claimed.map(row => [row.id, row.status, row.version]), [["a", "claimed", 2], ["b", "ready", 1]]);
  assert.deepEqual(list.withWrite(rows, record({ id: "a", status: "done", version: 3 }), query()).map(row => row.id), ["b"]);
  assert.deepEqual(list.withWrite(rows, record({ id: "z", status: "ready" }), query()).map(row => row.id), ["a", "b"], "an unknown record is not inserted");
});
