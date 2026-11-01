import type { Handoff } from "@/shared/contracts/handoffs";

/** A commit id cut the way `git log --oneline` shows it by default; the full id stays available beside it. */
export function shortCommit(id: string) { return id.slice(0, 7); }

// Git allows `$`, `;`, `&`, quotes and other shell syntax in branch names, so anything beyond the characters every shell
// reads literally is single-quoted. The handoff is untrusted text: a copied command must never run more than it says.
function quote(value: string) { return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`; }

/**
 * The commands that bring a checkout to the handoff's code state, for the person to read and paste; null without one.
 * They switch to the branch (or detach at the commit) and stop there, leaving any local changes for git to guard.
 */
export function checkoutCommand({ branch, baseCommit }: Pick<Handoff, "branch" | "baseCommit">): string | null {
  if (branch) return `git fetch && git switch ${quote(branch)} && git status`;
  if (baseCommit) return `git fetch && git switch --detach ${quote(baseCommit)}`;
  return null;
}
