import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkBase, gitContext, parseBranch, parseCommit, parseStatus, projectFromRemote } from "../../tooling/agents/git-context.mjs";

// Throwaway repositories with an empty global config, so the developer's own Git settings (signing, hooks) cannot interfere.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-git-")), config = path.join(root, "gitconfig");
  fs.writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  // TEMP can live inside the checkout; prevent non-repository fixtures from discovering its parent repository.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: root };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (cwd, file, text = file) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, "add", file); git(cwd, "commit", "-q", "-m", `add ${file}`); return git(cwd, "rev-parse", "HEAD"); };
  // A bare remote and two clones of it: the sender and the receiver.
  const clones = () => {
    const remote = path.join(root, "remote.git"), sender = path.join(root, "sender"), receiver = path.join(root, "receiver");
    git(root, "init", "-q", "--bare", remote); git(root, "clone", "-q", remote, sender);
    commit(sender, "a.txt"); git(sender, "push", "-q", "-u", "origin", "main"); git(root, "clone", "-q", remote, receiver);
    return { remote, sender, receiver };
  };
  return { root, env, git, commit, clones, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const neverRun = () => { throw new Error("git must not run for invalid input"); };

test("commit and branch arguments are checked before git ever runs", () => {
  assert.equal(parseCommit(` ${"A".repeat(40)} `), "a".repeat(40));
  assert.equal(parseCommit("b".repeat(64)), "b".repeat(64));
  for (const bad of ["abc1234", "a".repeat(39), "g".repeat(40), "", undefined]) assert.throws(() => parseCommit(bad), /full 40- or 64-character/);
  assert.equal(parseBranch("refs/heads/feat/x"), "feat/x");
  assert.equal(parseBranch("功能/分支"), "功能/分支");
  for (const bad of ["-x", "--upload-pack=evil", "a b", "a..b", "a@{1}", "a//b", "/a", "a/", "a.", "a.lock", "x/.hidden", "@", "HEAD", "a\u0007", "x".repeat(201)])
    assert.throws(() => parseBranch(bad), /valid git branch name/, bad);
  assert.throws(() => checkBase({ commit: "abc", run: neverRun }), /full 40- or 64-character/);
  assert.throws(() => checkBase({ commit: "a".repeat(40), branch: "--force", run: neverRun }), /valid git branch name/);
  assert.throws(() => gitContext({ since: "-p", run: neverRun }), /full 40- or 64-character/);
});

test("project names come from the origin URL's last segment, never with its credentials", () => {
  assert.equal(projectFromRemote("git@github.com:team/AgentRelay.git"), "AgentRelay");
  assert.equal(projectFromRemote("https://user:secret@example.invalid/team/Project-X.git/"), "Project-X");
  assert.equal(projectFromRemote(String.raw`C:\repos\local-only`), "local-only");
  assert.equal(projectFromRemote(""), null);
});

test("status parsing counts staged, unstaged and untracked entries and skips a rename's source", () => {
  const parsed = parseStatus("M  staged.ts\0 M changed.ts\0MM both.ts\0R  new.ts\0old.ts\0?? fresh.ts\0");
  assert.deepEqual(parsed, { staged: 3, unstaged: 2, untracked: 1, files: ["staged.ts", "changed.ts", "both.ts", "new.ts", "fresh.ts"] });
  assert.deepEqual(parseStatus(""), { staged: 0, unstaged: 0, untracked: 0, files: [] });
});

test("context outside a repository, in an empty one and on a detached HEAD", () => {
  const s = sandbox();
  try {
    const plain = path.join(s.root, "plain"); fs.mkdirSync(plain);
    assert.deepEqual(gitContext({ cwd: plain, env: s.env }), { repository: false });
    const repo = path.join(s.root, "My Folder"); fs.mkdirSync(repo); s.git(repo, "init", "-q");
    const empty = gitContext({ cwd: repo, env: s.env });
    assert.equal(empty.repository, true); assert.equal(empty.baseCommit, null); assert.equal(empty.pushed, false);
    assert.equal(empty.branch, null, "no branch without a commit: the server takes a branch only with its commit");
    assert.equal(empty.project, "My Folder"); assert.equal(empty.projectSource, "folder");
    const first = s.commit(repo, "a.txt"); s.git(repo, "checkout", "-q", "--detach");
    const detached = gitContext({ cwd: repo, env: s.env });
    assert.equal(detached.branch, null); assert.equal(detached.baseCommit, first); assert.equal(detached.upstream, null);
    s.git(repo, "remote", "add", "origin", "https://user:secret@example.invalid/team/Project-X.git");
    const named = gitContext({ cwd: repo, env: s.env });
    assert.equal(named.project, "Project-X"); assert.equal(named.projectSource, "origin"); assert.ok(!JSON.stringify(named).includes("secret"));
  } finally { s.close(); }
});

test("context reports push state against local refs and caps the uncommitted file list", () => {
  const s = sandbox();
  try {
    const { sender } = s.clones();
    const pushed = gitContext({ cwd: sender, env: s.env });
    assert.equal(pushed.branch, "main"); assert.equal(pushed.upstream, "origin/main");
    assert.equal(pushed.ahead, 0); assert.equal(pushed.behind, 0); assert.equal(pushed.pushed, true);
    assert.match(pushed.baseCommit, /^[0-9a-f]{40}$/);
    const base = pushed.baseCommit, next = s.commit(sender, "b.txt");
    const local = gitContext({ cwd: sender, env: s.env, since: base });
    assert.equal(local.ahead, 1); assert.equal(local.pushed, false);
    assert.deepEqual(local.commits, [{ hash: next, subject: "add b.txt" }]);
    assert.equal(gitContext({ cwd: sender, env: s.env, since: "c".repeat(40) }).commits, null);
    fs.writeFileSync(path.join(sender, "a.txt"), "changed"); fs.writeFileSync(path.join(sender, "c.txt"), "new"); s.git(sender, "add", "c.txt");
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(sender, `u${i}.txt`), "");
    const dirty = gitContext({ cwd: sender, env: s.env }).uncommitted;
    assert.equal(dirty.staged, 1); assert.equal(dirty.unstaged, 1); assert.equal(dirty.untracked, 60); assert.equal(dirty.files.length, 50);
  } finally { s.close(); }
});

test("check-base fetches, then gives each verdict without touching the checkout", () => {
  const s = sandbox();
  try {
    const { sender, receiver } = s.clones(), check = (commit, branch, cwd = receiver) => checkBase({ cwd, commit, branch, env: s.env });
    const base = s.git(receiver, "rev-parse", "HEAD");
    assert.equal(check(base, "main").verdict, "match");
    // Without a branch, a HEAD that is or contains the commit needs no question.
    assert.equal(check(base).verdict, "match");
    // A commit the sender has not pushed is missing until it is pushed; the fetch is what finds it.
    const unpushed = s.commit(sender, "b.txt");
    const missing = check(unpushed, "main");
    assert.equal(missing.verdict, "missing-commit"); assert.equal(missing.fetched, true);
    s.git(sender, "push", "-q");
    const behind = check(unpushed, "main");
    assert.equal(behind.verdict, "behind"); assert.equal(s.git(receiver, "rev-parse", "HEAD"), base, "check-base never pulls");
    s.git(receiver, "merge", "-q", "--ff-only", "origin/main"); s.commit(receiver, "c.txt");
    assert.equal(check(unpushed, "main").verdict, "descends");
    const sideways = s.commit(sender, "d.txt"); s.git(sender, "push", "-q");
    assert.equal(check(sideways, "main").verdict, "diverged");
    s.git(sender, "switch", "-q", "-c", "feat/x"); const feature = s.commit(sender, "e.txt"); s.git(sender, "push", "-q", "-u", "origin", "feat/x");
    const other = check(feature, "feat/x");
    assert.equal(other.verdict, "other-branch"); assert.equal(other.currentBranch, "main");
    assert.deepEqual(other.branchExists, { local: false, remote: true });
    fs.writeFileSync(path.join(receiver, "c.txt"), "edited");
    assert.equal(check(feature, "feat/x").dirty, true);
    assert.equal(s.git(receiver, "branch", "--show-current"), "main", "check-base never switches");
  } finally { s.close(); }
});

test("check-base without a usable remote compares local refs only", () => {
  const s = sandbox();
  try {
    const repo = path.join(s.root, "solo"); fs.mkdirSync(repo); s.git(repo, "init", "-q");
    const head = s.commit(repo, "a.txt");
    const solo = checkBase({ cwd: repo, commit: head, branch: "main", env: s.env });
    assert.equal(solo.verdict, "match"); assert.equal(solo.fetched, false); assert.deepEqual(solo.branchExists, { local: true, remote: false });
    s.git(repo, "remote", "add", "origin", path.join(s.root, "does-not-exist.git"));
    assert.equal(checkBase({ cwd: repo, commit: head, branch: "main", env: s.env }).fetched, false);
    const plain = path.join(s.root, "plain"); fs.mkdirSync(plain);
    assert.deepEqual(checkBase({ cwd: plain, commit: head, env: s.env }), { verdict: "no-repository", fetched: false });
  } finally { s.close(); }
});

test("the client prints context as JSON and refuses a short hash with a fixed message", () => {
  // A disposable home: no test may install a client into the real ~/.agentrelay.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-home-"));
  const cli = args => spawnSync(process.execPath, [path.resolve("scripts/agents/agentrelay.mjs"), ...args], { cwd: home, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CEILING_DIRECTORIES: path.dirname(home) } });
  const outside = cli(["context"]);
  assert.equal(outside.status, 0, outside.stderr); assert.deepEqual(JSON.parse(outside.stdout), { repository: false });
  const refused = cli(["check-base", "--commit", "abc"]);
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ""); assert.match(refused.stderr, /full 40- or 64-character/);
  assert.match(cli(["check-base"]).stderr, /--commit is required/);
  assert.ok(!fs.existsSync(path.join(home, ".agentrelay")), "the read-only Git helpers install no client");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a failed git status is reported as unknown, never as a clean tree", () => {
  const s = sandbox();
  try {
    const repo = path.join(s.root, "repo"); fs.mkdirSync(repo); s.git(repo, "init", "-q");
    const head = s.commit(repo, "a.txt"), next = s.commit(repo, "b.txt");
    // A runner that lets every git command through except status, as a timeout in a large repository would.
    const failingStatus = (command, args, options) => args[0] === "status" ? { status: null, error: new Error("timed out"), stdout: "" } : spawnSync(command, args, options);
    assert.equal(checkBase({ cwd: repo, commit: next, branch: "main", env: s.env, run: failingStatus }).dirty, null);
    assert.equal(gitContext({ cwd: repo, env: s.env, run: failingStatus }).uncommitted, null);
    assert.equal(checkBase({ cwd: repo, commit: head, env: s.env }).verdict, "descends", "HEAD contains a branchless base");
    assert.equal(checkBase({ cwd: repo, commit: next, env: s.env }).dirty, false);
  } finally { s.close(); }
});

test("git never waits for an SSH prompt, and a configured SSH command is kept", () => {
  const seen = [];
  const record = (command, args, options) => { seen.push(options.env.GIT_SSH_COMMAND); return { status: 1, stdout: "" }; };
  gitContext({ cwd: os.tmpdir(), env: {}, run: record });
  gitContext({ cwd: os.tmpdir(), env: { GIT_SSH_COMMAND: "ssh -i key" }, run: record });
  assert.deepEqual([...new Set(seen)], ["ssh -o BatchMode=yes", "ssh -i key"]);
});
