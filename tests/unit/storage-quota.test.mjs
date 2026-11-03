import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const quota = await loadTypeScriptModule("src/server/core/storage-quota.ts");
const http = await loadTypeScriptModule("src/server/http/index.ts");

// Messages as D1 raises them (Cloudflare D1 error list), wrapped the way query builders wrap them.
const d1 = message => new Error(`D1_ERROR: ${message}`);
const wrapped = cause => Object.assign(new Error("Failed query: insert into handoffs ... params: secret prompt"), { cause });
const NOW = Date.UTC(2026, 10, 1, 22, 30, 0);

test("a full database answers 507, directly or through a query wrapper", () => {
  for (const error of [d1("Exceeded maximum DB size.: SQLITE_FULL"), wrapped(d1("Exceeded maximum DB size.")),
    d1("Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit")]) {
    const mapped = quota.storageQuotaError(error, NOW);
    assert.equal(mapped.status, 507);
    assert.match(mapped.message, /database is full/);
  }
});

test("the Workers Free daily row limits answer 503 with Retry-After until 00:00 UTC", () => {
  for (const kind of ["read", "write"]) {
    const mapped = quota.storageQuotaError(wrapped(d1(`Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`)), NOW);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.retryAfterSeconds, 90 * 60);
  }
});

test("other failures, and prompt text quoted by a wrapper, are not mistaken for a quota", () => {
  assert.equal(quota.storageQuotaError(new Error("D1_ERROR: no such table: handoffs")), null);
  assert.equal(quota.storageQuotaError(new Error("Failed query: insert ... params: please fix 'Exceeded maximum DB size' in my app")), null);
  assert.equal(quota.storageQuotaError(undefined), null);
});

test("HTTP failures carry the mapped status, message and Retry-After; unknown errors stay a generic 500", async () => {
  const daily = http.failure(wrapped(d1("Your account has exceeded D1's free tier daily row read limit.")));
  assert.equal(daily.status, 503);
  assert.match(daily.headers.get("Retry-After"), /^\d+$/);
  assert.match((await daily.json()).error, /today's database allowance/);
  const full = http.failure(d1("Exceeded maximum DB size."));
  assert.equal(full.status, 507);
  assert.equal(full.headers.get("Retry-After"), null);
  const originalError = console.error;
  console.error = () => {};
  try {
    const unknown = http.failure(new Error("boom"));
    assert.equal(unknown.status, 500);
    assert.equal((await unknown.json()).error, "AgentRelay is temporarily unavailable. Try again shortly.");
  } finally {
    console.error = originalError;
  }
});
