// Read-only Git facts for the agentrelay skill: what a sender's checkout points at, and how a receiver's checkout compares
// with a handoff's baseCommit. Nothing here switches, pulls, merges, stashes or resets; `checkBase` only fetches.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ClientError } from "./credential-store.mjs";

const MAX_FILES = 50, MAX_COMMITS = 100, MAX_BRANCH = 200;
// The same shape rules the server applies (src/server/handoffs/git-context-validation.ts), repeated here because the
// values come from another device and reach git as arguments.
const FORBIDDEN = /[\p{Cc} ~^:?*[\\]|\.\.|@\{|\/\//u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A full commit hash, lowercased, or a ClientError. */
export function parseCommit(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!OBJECT_ID.test(id)) throw new ClientError("Use a full 40- or 64-character commit hash.");
  return id;
}

/** A branch name git would accept, without a leading `refs/heads/`, or a ClientError. */
export function parseBranch(value) {
  const name = typeof value === "string" ? value.trim().replace(/^refs\/heads\//, "") : "";
  if (!name || name.length > MAX_BRANCH || FORBIDDEN.test(name) || name === "@" || name === "HEAD" || /^[-/]|[/.]$/.test(name)
    || name.split("/").some(part => part.startsWith(".") || part.endsWith(".lock")))
    throw new ClientError("Use a valid git branch name.");
  return name;
}

/**
 * Run git without a shell and without prompting for credentials, including an SSH passphrase or host-key question,
 * which would otherwise hang a fetch until its timeout. Only stdout is returned: git's stderr can carry remote URLs
 * with credentials and is never shown.
 */
function gitRunner(cwd, run, env) {
  return (args, timeout = 15_000) => {
    const result = run("git", args, { cwd, encoding: "utf8", windowsHide: true, shell: false, timeout, maxBuffer: 16 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" } });
    return { ok: !result.error && result.status === 0, out: (result.stdout ?? "").replace(/\r?\n$/, "") };
  };
}

/** The last path segment of a remote URL without `.git`: `git@host:team/AgentRelay.git` -> `AgentRelay`. */
export function projectFromRemote(url) {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/\\:]/).filter(Boolean).pop() ?? "";
  return last.replace(/\.git$/i, "") || null;
}

/** Counts and the first paths from `git status --porcelain=v1 -z`; a rename's second entry is its source path. */
export function parseStatus(text) {
  const entries = text.split("\0"), counts = { staged: 0, unstaged: 0, untracked: 0 }, files = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const [x, y, file] = [entry[0], entry[1], entry.slice(3)];
    if (x === "R" || x === "C") i++;
    if (x === "?") counts.untracked++;
    else { if (x !== " ") counts.staged++; if (y !== " ") counts.unstaged++; }
    if (files.length < MAX_FILES) files.push(file);
  }
  return { ...counts, files };
}

const repositoryRoot = git => { const root = git(["rev-parse", "--show-toplevel"]); return root.ok && root.out ? root.out : null; };
const commitExists = (git, id) => git(["cat-file", "-e", `${id}^{commit}`]).ok;

/**
 * Where the checkout at `cwd` stands, for a sender: project name, branch, full HEAD, push state against local
 * remote-tracking refs (no network), uncommitted changes, and with `since` the commits after it. Before the first commit
 * there is no branch to report either, since the server takes a branch only with its commit. `uncommitted` is null
 * when git could not tell.
 */
export function gitContext({ cwd = process.cwd(), since, run = spawnSync, env = process.env } = {}) {
  const sinceId = since === undefined ? undefined : parseCommit(since);
  const git = gitRunner(cwd, run, env), root = repositoryRoot(git);
  if (!root) return { repository: false };
  const origin = git(["remote", "get-url", "origin"]), fromOrigin = origin.ok ? projectFromRemote(origin.out) : null;
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]), baseCommit = head.ok ? head.out.toLowerCase() : null;
  const branch = baseCommit ? git(["branch", "--show-current"]).out || null : null;
  const upstreamRef = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = baseCommit && upstreamRef.ok && upstreamRef.out ? upstreamRef.out : null;
  let ahead = null, behind = null;
  if (upstream) {
    const counts = git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).out.split(/\s+/).map(Number);
    if (counts.length === 2 && counts.every(Number.isInteger)) [ahead, behind] = counts;
  }
  const pushed = baseCommit ? Boolean(git(["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/remotes"]).out) : false;
  const status = git(["status", "--porcelain=v1", "-z"], 60_000);
  const context = {
    repository: true, project: fromOrigin ?? path.basename(root), projectSource: fromOrigin ? "origin" : "folder",
    branch, baseCommit, upstream, ahead, behind, pushed, uncommitted: status.ok ? parseStatus(status.out) : null,
  };
  if (sinceId === undefined) return context;
  if (!commitExists(git, sinceId)) return { ...context, commits: null };
  const log = git(["log", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%s", `${sinceId}..HEAD`]);
  const commits = log.out ? log.out.split("\n").map(line => { const [hash, subject] = line.split("\x1f"); return { hash, subject }; }) : [];
  return { ...context, commits };
}

/**
 * How the checkout at `cwd` compares with a handoff's code state, for a receiver. Fetches the current branch's remote
 * (or origin) first; `fetched: false` means the verdict reflects local refs only. `dirty` is null when git could not
 * tell, which callers must treat as dirty.
 * Verdicts: no-repository, missing-commit, other-branch, and match (HEAD is the commit) or descends (HEAD contains it)
 * on the handoff's branch or, without one, anywhere; otherwise behind (the commit contains HEAD) or diverged on the
 * same branch, and detached-base for a handoff without a branch.
 */
export function checkBase({ cwd = process.cwd(), commit, branch, run = spawnSync, env = process.env, fetchTimeout = 30_000 } = {}) {
  const id = parseCommit(commit), name = branch === undefined ? null : parseBranch(branch);
  const git = gitRunner(cwd, run, env);
  if (!repositoryRoot(git)) return { verdict: "no-repository", fetched: false };
  const currentBranch = git(["branch", "--show-current"]).out || null;
  const configured = currentBranch ? git(["config", "--get", `branch.${currentBranch}.remote`]).out : "";
  const remotes = git(["remote"]).out.split("\n").filter(Boolean);
  const remote = remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : null;
  const fetched = remote ? git(["fetch", "--quiet", remote], fetchTimeout).ok : false;
  const headRef = git(["rev-parse", "--verify", "--quiet", "HEAD"]), head = headRef.ok ? headRef.out.toLowerCase() : null;
  const status = git(["status", "--porcelain=v1", "-z"], 60_000), dirty = status.ok ? Boolean(status.out) : null;
  const facts = { fetched, currentBranch, head, dirty };
  if (!commitExists(git, id)) return { verdict: "missing-commit", ...facts };
  const contains = () => head && git(["merge-base", "--is-ancestor", id, head]).ok;
  if (!name) return { verdict: head === id ? "match" : contains() ? "descends" : "detached-base", ...facts };
  const branchExists = {
    local: git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok,
    remote: remote ? git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]).ok : false,
  };
  if (currentBranch !== name) return { verdict: "other-branch", ...facts, branchExists };
  const verdict = head === id ? "match"
    : contains() ? "descends"
      : head && git(["merge-base", "--is-ancestor", head, id]).ok ? "behind" : "diverged";
  return { verdict, ...facts, branchExists };
}
