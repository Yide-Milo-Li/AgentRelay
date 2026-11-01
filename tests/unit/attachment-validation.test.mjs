import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const rules = await loadTypeScriptModule("src/server/attachments/validation.ts");
const message = fn => { try { fn(); } catch (error) { return error; } assert.fail("expected an error"); };

test("upload keys are 1–120 printable characters", () => {
  assert.equal(rules.parseUploadKey("  abc-123  "), "abc-123");
  for (const bad of [null, "", "   ", "a b", "x".repeat(121), "ta\tb", "é"]) assert.equal(message(() => rules.parseUploadKey(bad)).status, 400);
  assert.equal(rules.parseUploadKey("x".repeat(120)).length, 120);
});

test("filenames are display text: paths, controls and length are cleaned", () => {
  assert.equal(rules.cleanFilename("C%3A%5Cusers%5Cme%5Cshot.png", "image/png"), "shot.png");
  assert.equal(rules.cleanFilename("../../etc/passwd.png", "image/png"), "passwd.png");
  assert.equal(rules.cleanFilename("a\u0000b\nc.png", "image/png"), "abc.png");
  assert.equal(rules.cleanFilename("", "image/webp"), "image.webp");
  assert.equal(rules.cleanFilename(null, "image/jpeg"), "image.jpg");
  assert.equal(Array.from(rules.cleanFilename("字".repeat(300), "image/png")).length, 120);
  assert.equal(rules.cleanFilename("%E0%A4%A.png", "image/png"), "%E0%A4%A.png");
});

test("a declared type may agree with the bytes but never override them", () => {
  assert.doesNotThrow(() => rules.checkDeclaredType(null, "image/png"));
  assert.doesNotThrow(() => rules.checkDeclaredType("image/png; charset=binary", "image/png"));
  assert.doesNotThrow(() => rules.checkDeclaredType("application/octet-stream", "image/webp"));
  assert.equal(message(() => rules.checkDeclaredType("image/jpeg", "image/png")).status, 415);
  assert.equal(message(() => rules.checkDeclaredType("text/plain", "image/png")).status, 415);
});

test("attachment ids are an ordered list of at most ten unique strings", () => {
  assert.deepEqual(rules.parseAttachmentIds(undefined), []);
  assert.deepEqual(rules.parseAttachmentIds(["b", "a"]), ["b", "a"]);
  assert.equal(rules.parseAttachmentIds(Array.from({ length: 10 }, (_, i) => `id${i}`)).length, 10);
  for (const bad of ["a", [1], [""], ["a", "a"], Array.from({ length: 11 }, (_, i) => `id${i}`), ["x".repeat(129)]]) {
    assert.equal(message(() => rules.parseAttachmentIds(bad)).status, 400);
  }
});

test("upload failures map to precise HTTP statuses", () => {
  const status = reason => rules.uploadFailure(reason, "x").status;
  assert.equal(status("too_large_bytes"), 413);
  assert.equal(status("unsupported"), 415);
  assert.equal(status("mismatch"), 415);
  for (const reason of ["animated", "corrupt", "too_wide", "too_many_pixels", "empty"]) assert.equal(status(reason), 422);
});
