import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { parseResult, parseReplyTo, replyTitle } = await loadTypeScriptModule("src/server/handoffs/receipt-validation.ts");
const { HANDOFF_LIMITS } = await loadTypeScriptModule("src/shared/contracts/handoffs.ts");
const status = action => { try { action(); } catch (error) { return error.status; } };

test("a receipt is stored exactly as sent and only by a forward completion", () => {
  const receipt = "## Summary\r\n  Fixed it 🚀\n```sh\necho '$X'\n```\n<script>alert(1)</script>\n";
  assert.equal(parseResult(receipt, "done", false), receipt);
  assert.equal(parseResult(undefined, "done", false), undefined);
  assert.equal(parseResult(null, "claimed", false), undefined);
  assert.equal(parseResult("  \n ", "done", false), undefined, "a blank receipt counts as none");
  for (const target of ["claimed", "ready"]) assert.equal(status(() => parseResult("x", target, false)), 400);
  assert.equal(status(() => parseResult("x", "done", true)), 400, "an undo never writes a receipt");
  assert.equal(status(() => parseResult(42, "done", false)), 400);
});

test("a receipt is bounded by the shared limit", () => {
  const limit = HANDOFF_LIMITS.resultCharacters;
  assert.equal(parseResult("a".repeat(limit), "done", false).length, limit);
  assert.equal(status(() => parseResult("a".repeat(limit + 1), "done", false)), 400);
});

test("replyTo is checked by shape only", () => {
  assert.equal(parseReplyTo(undefined), null);
  assert.equal(parseReplyTo(null), null);
  assert.equal(parseReplyTo("2f1c0a3e-1111-4222-8333-444455556666"), "2f1c0a3e-1111-4222-8333-444455556666");
  for (const bad of ["", "  ", 7, {}, "x".repeat(65)]) assert.equal(status(() => parseReplyTo(bad)), 400);
});

test("reply titles take one Re: prefix and stay within the title limit", () => {
  assert.equal(replyTitle("Fix login timeout"), "Re: Fix login timeout");
  assert.equal(replyTitle("Re: Fix login timeout"), "Re: Fix login timeout");
  assert.equal(replyTitle("RE: shouting"), "RE: shouting");
  assert.equal(replyTitle("Reorder imports"), "Re: Reorder imports");
  assert.equal(replyTitle("t".repeat(HANDOFF_LIMITS.titleCharacters)).length, HANDOFF_LIMITS.titleCharacters);
});

test("storage sizes use the expression the receipt-aware index stores", () => {
  const storage = readFileSync(new URL("../../src/server/handoffs/storage.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../drizzle/0015_handoff_receipts.sql", import.meta.url), "utf8");
  const normalize = text => text.replace(/["`]/g, "").replace(/\s+/g, "");
  assert.match(storage, /INDEXED BY handoffs_owner_logical_v2/);
  const prompt = storage.match(/const PROMPT_BYTES = "([^"]+)"/)[1];
  // The covering index is only used when the query repeats its expression.
  assert.ok(normalize(migration).includes(normalize(`(owner_id,${prompt} + attachment_bytes,id,`)), "migration indexes the storage expression");
});
