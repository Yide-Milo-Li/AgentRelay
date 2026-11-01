import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { startStorageFixtureServer } from "../support/storage-fixture-server.mjs";
import { executeLocalSql, readLocalR2Object } from "../support/local-storage-fixtures.mjs";

async function fixture(t, overrides = {}) {
  const token = randomBytes(32).toString("hex"), seen = { sql: [], r2: [], databaseLoads: 0, bucketLoads: 0 };
  const database = {
    prepare(sql) { return { sql, async all() { seen.sql.push(sql); return { success: true, results: [{ value: sql }] }; } }; },
    async batch(statements) { return Promise.all(statements.map(statement => statement.all())); },
  };
  const bucket = { async get(key) {
    seen.r2.push(key);
    return key === "a/object" ? { async arrayBuffer() { return Uint8Array.from([0, 255, 42]).buffer; } } : null;
  } };
  const server = await startStorageFixtureServer({ token,
    getD1Database: async () => { seen.databaseLoads++; return overrides.database ?? database; },
    getR2Bucket: async () => { seen.bucketLoads++; return overrides.bucket ?? bucket; },
  });
  t.after(() => server.close());
  return { ...server, token, seen, env: { AGENTRELAY_TEST_FIXTURE_URL: server.url, AGENTRELAY_TEST_FIXTURE_TOKEN: token } };
}

test("local fixture access requires the per-preview credential and rejects browser origins", async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(f.url + "/sql", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(f.url + "/sql", { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(f.url + "/sql", { headers })).status, 405);
  assert.equal(f.seen.databaseLoads + f.seen.bucketLoads, 0);
});

test("fixture statements execute once through the shared binding and preserve quoted semicolons", async t => {
  const f = await fixture(t), first = "SELECT 'value; still one statement' AS value;";
  const result = await executeLocalSql(first, { env: f.env });
  assert.equal(result[0].results[0].value, first);
  await executeLocalSql(["UPDATE first_table SET value = 1;", "DELETE FROM second_table;"], { env: f.env });
  assert.deepEqual(f.seen.sql, [first, "UPDATE first_table SET value = 1;", "DELETE FROM second_table;"]);
  assert.equal(f.seen.databaseLoads, 1);
});

test("R2 fixtures return original bytes or null without spawning a second storage runtime", async t => {
  const f = await fixture(t);
  assert.deepEqual(await readLocalR2Object("a/object", { env: f.env }), Uint8Array.from([0, 255, 42]));
  assert.equal(await readLocalR2Object("a/missing", { env: f.env }), null);
  assert.deepEqual(f.seen.r2, ["a/object", "a/missing"]);
  assert.equal(f.seen.bucketLoads, 1);
});

test("binding failures are not retried and expose neither SQL nor credentials", async t => {
  let calls = 0;
  const privateText = "synthetic-private-query-value";
  const database = { prepare() { return { async all() { calls++; throw new Error(`SQLITE_BUSY ${privateText}`); } }; } };
  const f = await fixture(t, { database });
  await assert.rejects(executeLocalSql(`SELECT '${privateText}'`, { env: f.env }), error => {
    assert.match(error.message, /SQLITE_BUSY/);
    assert.ok(!error.message.includes(privateText) && !error.message.includes(f.token));
    return true;
  });
  assert.equal(calls, 1);
});

test("fixture protocol validates bounded input and keeps raw binding error details private", async t => {
  const database = { prepare() { throw Object.assign(new Error("synthetic-private-error"), { code: "synthetic-private-code" }); } };
  const f = await fixture(t, { database }), headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
  const post = body => fetch(f.url + "/sql", { method: "POST", headers, body });
  assert.equal((await post("invalid json")).status, 400);
  assert.equal((await post(JSON.stringify({ statements: [] }))).status, 400);
  assert.equal((await post("x".repeat(1_300_001))).status, 413);
  const failed = await post(JSON.stringify({ statements: ["SELECT 1"] }));
  assert.equal(failed.status, 500);
  const text = await failed.text();
  assert.ok(!text.includes("synthetic-private") && !text.includes(f.token));
});

test("configured fixtures reject incomplete or non-loopback endpoints before sending a credential", async () => {
  const token = randomBytes(32).toString("hex");
  await assert.rejects(executeLocalSql("SELECT 1", { env: { AGENTRELAY_TEST_FIXTURE_URL: "http://127.0.0.1:1" } }), /Incomplete/);
  await assert.rejects(executeLocalSql("SELECT 1", { env: { AGENTRELAY_TEST_FIXTURE_URL: "https://untrusted.example", AGENTRELAY_TEST_FIXTURE_TOKEN: token } }), /loopback/);
});
