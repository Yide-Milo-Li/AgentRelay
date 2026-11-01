import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";

const { checkoutCommand, shortCommit } = await loadTypeScriptModule("src/features/handoffs/git-commands.ts");
const SHA1 = "0123456789abcdef0123456789abcdef01234567";

test("no code state means no command", () => {
  assert.equal(checkoutCommand({}), null);
  assert.equal(checkoutCommand({ branch: null, baseCommit: null }), null);
});

test("a branch is switched to and a detached base is checked out", () => {
  assert.equal(checkoutCommand({ branch: "feat/git-context", baseCommit: SHA1 }), "git fetch && git switch feat/git-context && git status");
  assert.equal(checkoutCommand({ branch: null, baseCommit: SHA1 }), `git fetch && git switch --detach ${SHA1}`);
  assert.equal(shortCommit(SHA1), "0123456");
});

test("shell syntax a branch name may legally hold is quoted, never run", () => {
  assert.equal(checkoutCommand({ branch: "x;rm${IFS}-rf", baseCommit: SHA1 }), "git fetch && git switch 'x;rm${IFS}-rf' && git status");
  assert.equal(checkoutCommand({ branch: "it's", baseCommit: SHA1 }), "git fetch && git switch 'it'\\''s' && git status");
  assert.equal(checkoutCommand({ branch: "a&b|c`d`", baseCommit: SHA1 }), "git fetch && git switch 'a&b|c`d`' && git status");
  assert.equal(checkoutCommand({ branch: "用户/功能", baseCommit: SHA1 }), "git fetch && git switch '用户/功能' && git status");
});
