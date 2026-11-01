import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { parseGitContext } = await loadTypeScriptModule("src/server/handoffs/git-context-validation.ts");
const { HANDOFF_LIMITS } = await loadTypeScriptModule("src/shared/contracts/handoffs.ts");
const SHA1 = "0123456789abcdef0123456789abcdef01234567", SHA256 = "ab".repeat(32);
const failure = action => { try { action(); } catch (error) { return { status: error.status, message: error.message }; } };
const status = action => failure(action)?.status;

test("no git context is the default and blank values count as none", () => {
  assert.deepEqual(parseGitContext({}), { branch: null, baseCommit: null });
  assert.deepEqual(parseGitContext({ branch: null, baseCommit: undefined }), { branch: null, baseCommit: null });
  assert.deepEqual(parseGitContext({ branch: "  ", baseCommit: "" }), { branch: null, baseCommit: null });
});

test("valid branch names are kept, trimmed and without refs/heads/", () => {
  for (const name of ["main", "feat/git-context", "release/1.2", "fix_x-y.z", "用户/功能", "a".repeat(HANDOFF_LIMITS.branchCharacters)])
    assert.equal(parseGitContext({ branch: name, baseCommit: SHA1 }).branch, name);
  assert.equal(parseGitContext({ branch: " feat/x\n", baseCommit: SHA1 }).branch, "feat/x");
  assert.equal(parseGitContext({ branch: "refs/heads/feat/x", baseCommit: SHA1 }).branch, "feat/x");
});

test("names git refuses are rejected", () => {
  const refused = ["feat x", "a\tb", "a\u0007b", "a\u0085b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a..b", "a@{1}", "a//b",
    "-x", "/x", "x/", "x.", "x.lock", "x.lock/y", ".x", "a/.b", "@", "HEAD", "refs/heads/", "a".repeat(HANDOFF_LIMITS.branchCharacters + 1), 42, {}];
  for (const branch of refused) assert.equal(status(() => parseGitContext({ branch, baseCommit: SHA1 })), 400, JSON.stringify(branch));
});

test("baseCommit is a full SHA-1 or SHA-256 hash, stored lowercase", () => {
  assert.equal(parseGitContext({ baseCommit: SHA1 }).baseCommit, SHA1);
  assert.equal(parseGitContext({ baseCommit: SHA256 }).baseCommit, SHA256);
  assert.equal(parseGitContext({ baseCommit: ` ${SHA1.toUpperCase()} ` }).baseCommit, SHA1);
  for (const baseCommit of ["0123456", SHA1.slice(1), `${SHA1}0`, `${SHA1.slice(1)}g`, "z".repeat(40), 1234567, []])
    assert.equal(status(() => parseGitContext({ baseCommit })), 400, JSON.stringify(baseCommit));
});

test("a branch needs its commit, a commit alone stands for a detached HEAD", () => {
  assert.match(failure(() => parseGitContext({ branch: "main" })).message, /baseCommit is required/);
  assert.deepEqual(parseGitContext({ baseCommit: SHA1 }), { branch: null, baseCommit: SHA1 });
});
