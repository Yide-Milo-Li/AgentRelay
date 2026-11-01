import { AgentRelayError } from "@/server/core/agent-relay-error";
import { HANDOFF_LIMITS } from "@/shared/contracts/handoffs";

export type GitContext = { branch: string | null; baseCommit: string | null };

const blank = (value: unknown) => value == null || (typeof value === "string" && !value.trim());
// Characters and sequences `git check-ref-format --branch` refuses: controls, space, ~ ^ : ? * [ \, "..", "@{" and "//".
// C1 controls are refused as well; git would take them, but they have no place in a label shown to people.
const FORBIDDEN = /[\p{Cc} ~^:?*\[\\]|\.\.|@\{|\/\//u;
// A full SHA-1 or SHA-256 object id. Abbreviations are refused: they can be ambiguous and cannot be checked exactly.
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A branch name git would accept, with a leading `refs/heads/` dropped; the server never resolves it. */
function parseBranch(value: unknown): string | null {
  if (blank(value)) return null;
  if (typeof value !== "string") throw new AgentRelayError("branch must be a git branch name.");
  const name = value.trim().replace(/^refs\/heads\//, "");
  const max = HANDOFF_LIMITS.branchCharacters;
  if (!name || name.length > max) throw new AgentRelayError(`branch must be 1–${max} characters.`);
  if (FORBIDDEN.test(name) || name === "@" || name === "HEAD" || /^[-/]|[/.]$/.test(name)
    || name.split("/").some(part => part.startsWith(".") || part.endsWith(".lock")))
    throw new AgentRelayError("branch must be a valid git branch name.");
  return name;
}

function parseBaseCommit(value: unknown): string | null {
  if (blank(value)) return null;
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!OBJECT_ID.test(id)) throw new AgentRelayError("baseCommit must be a full 40- or 64-character commit hash.");
  return id;
}

/**
 * The code state a new handoff points at, checked by shape only. A branch name alone moves and cannot be verified, so it
 * needs the commit; a commit alone stands for a detached HEAD. Blank values count as none.
 */
export function parseGitContext(input: Record<string, unknown>): GitContext {
  const branch = parseBranch(input.branch), baseCommit = parseBaseCommit(input.baseCommit);
  if (branch && !baseCommit) throw new AgentRelayError("baseCommit is required when branch is given.");
  return { branch, baseCommit };
}
