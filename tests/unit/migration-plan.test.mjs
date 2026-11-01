import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEDGER_TABLE, LEGACY_PROBES, planMigrations, withLedgerRow } from "../../tooling/database/migration-plan.mjs";

const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const tags = journal.entries.map((entry) => entry.tag);

test("every journal entry up to the ledger's introduction has a legacy probe", () => {
  for (const tag of tags.slice(0, 5)) assert.ok(tag in LEGACY_PROBES, tag);
});

test("an empty database applies every migration", () => {
  assert.deepEqual(planMigrations(tags, null, {}), { baseline: [], apply: tags });
});

test("a hand-migrated database is baselined, not replayed", () => {
  const present = Object.fromEntries(tags.map((tag) => [tag, true]));
  assert.deepEqual(planMigrations(tags, null, present), { baseline: tags.filter((tag) => tag in LEGACY_PROBES), apply: tags.filter((tag) => !(tag in LEGACY_PROBES)) });
});

test("a partly hand-migrated database baselines only the leading migrations that exist", () => {
  const present = { [tags[0]]: true, [tags[1]]: true, [tags[2]]: true, [tags[3]]: false, [tags[4]]: true };
  const plan = planMigrations(tags, null, present);
  assert.deepEqual(plan.baseline, tags.slice(0, 3));
  assert.deepEqual(plan.apply, tags.slice(3));
});

test("a recorded ledger is trusted and probes are ignored", () => {
  const plan = planMigrations([...tags, "9999_next"], tags, { [tags[0]]: false });
  assert.deepEqual(plan, { baseline: [], apply: ["9999_next"] });
});

test("the ledger row is appended in the same file as the migration", () => {
  const sql = withLedgerRow("CREATE TABLE a (id text)\n", "0009_x", 42);
  assert.equal(sql, `CREATE TABLE a (id text);\nINSERT INTO ${LEDGER_TABLE} (tag, applied_at) VALUES ('0009_x', 42);\n`);
  assert.ok(withLedgerRow("SELECT 1;", "t", 1).startsWith("SELECT 1;\nINSERT"));
});
