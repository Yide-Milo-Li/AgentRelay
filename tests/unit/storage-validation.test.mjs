import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { parseStorageQuery, encodeStorageCursor, storageFilterKey, parseHandoffDeletions, observedVersion } = await loadTypeScriptModule("src/server/handoffs/storage-validation.ts");
const { formatStorageBytes, storageUsage } = await loadTypeScriptModule("src/features/handoffs/storage-formatting.ts");
const status = action => { try { action(); } catch (error) { return error.status; } };

test("storage defaults and bounded filters preserve literal user text", () => {
  const { filters, cursor, asOf } = parseStorageQuery(new URLSearchParams(), 1000);
  assert.equal(filters.sort, "largest"); assert.equal(filters.status, "all"); assert.equal(cursor, null); assert.equal(asOf, 1000);
  const query = new URLSearchParams({ search: "  中文 %_'  ", project: "Private", sourceDevice: "Laptop", targetDevice: "Desktop", status: "done", expiration: "expired", ageDays: "90", minBytes: "1024", sort: "oldest" });
  const parsed = parseStorageQuery(query, 1000).filters;
  assert.equal(parsed.search, "中文 %_'"); assert.equal(parsed.minBytes, 1024); assert.equal(parsed.ageDays, 90);
});

test("storage rejects unsupported choices, non-integers and oversized filters", () => {
  for (const [key, value] of [["status", "deleted"], ["sort", "content"], ["expiration", "maybe"], ["ageDays", "7"], ["minBytes", "-1"], ["minBytes", "1.1"], ["minBytes", "9007199254740992"], ["search", "x".repeat(281)], ["project", "x".repeat(121)], ["sourceDevice", "x".repeat(81)]])
    assert.equal(status(() => parseStorageQuery(new URLSearchParams({ [key]: value }))), 400, `${key}: ${value.slice(0, 25)}`);
});

test("cursor carries stable query time and cannot be reused with different filters", () => {
  const { filters } = parseStorageQuery(new URLSearchParams({ search: "中文" }), 1000);
  const value = { v: 2, id: "row-1", value: 42, asOf: 1000, filters: storageFilterKey(filters) };
  const encoded = encodeStorageCursor(value);
  assert.deepEqual(parseStorageQuery(new URLSearchParams({ search: "中文", cursor: encoded }), 2000).cursor, value);
  assert.equal(parseStorageQuery(new URLSearchParams({ search: "中文", cursor: encoded }), 2000).asOf, 1000);
  for (const cursor of ["", "%", "null", encodeStorageCursor({ ...value, value: -1 }), encodeStorageCursor({ ...value, asOf: 3000 }), encodeStorageCursor({ ...value, id: "" }), encodeStorageCursor({ ...value, v: 1 }), encodeStorageCursor({ id: value.id, value: value.value, asOf: value.asOf, filters: value.filters })])
    assert.equal(status(() => parseStorageQuery(new URLSearchParams({ search: "中文", cursor }), 2000)), 400);
  assert.equal(status(() => parseStorageQuery(new URLSearchParams({ search: "different", cursor: encoded }), 2000)), 400);
});

test("deletion requires an explicit, unique, bounded list of observed versions", () => {
  assert.deepEqual(parseHandoffDeletions({ items: [{ id: "a", version: 2 }] }), [{ id: "a", version: 2 }]);
  for (const items of [[], Array.from({ length: 51 }, (_, index) => ({ id: `${index}`, version: 1 })), [{ id: "a", version: 1 }, { id: "a", version: 2 }], [{ id: "", version: 1 }], [{ id: "a" }], [{ id: "a", version: "1" }], [null]])
    assert.equal(status(() => parseHandoffDeletions({ items })), 400);
  assert.equal(status(() => parseHandoffDeletions({ status: "done" })), 400);
  for (const value of [undefined, 0, -1, 1.5, "1", Infinity]) assert.equal(status(() => observedVersion(value)), 400);
});

test("byte formatting and quota tones keep unavailable distinct from zero", () => {
  assert.equal(formatStorageBytes(0), "0 B"); assert.equal(formatStorageBytes(1_000_000_000), "1 GB");
  assert.equal(storageUsage(null, 10_000).percent, null); assert.equal(storageUsage(0, 10_000).percent, 0);
  assert.equal(storageUsage(7999, 10_000).tone, "normal"); assert.equal(storageUsage(8000, 10_000).tone, "warn");
  assert.equal(storageUsage(9500, 10_000).tone, "danger"); assert.ok(Math.abs(storageUsage(11_000, 10_000).percent - 110) < 0.00001);
});
