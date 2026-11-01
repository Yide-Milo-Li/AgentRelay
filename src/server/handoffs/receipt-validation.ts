import { AgentRelayError } from "@/server/core/agent-relay-error";
import { HANDOFF_LIMITS } from "@/shared/contracts/handoffs";

/**
 * The completion receipt in a status change: untrusted Markdown stored exactly as sent, accepted only by a forward move to
 * `done`. Undefined when none is given; a blank one counts as none.
 */
export function parseResult(value: unknown, status: string, undo: boolean): string | undefined {
  if (value == null) return undefined;
  if (status !== "done" || undo) throw new AgentRelayError("result is accepted only when completing a handoff.");
  if (typeof value !== "string" || value.length > HANDOFF_LIMITS.resultCharacters)
    throw new AgentRelayError(`result must be at most ${HANDOFF_LIMITS.resultCharacters} characters.`);
  return value.trim() ? value : undefined;
}

/** The id a reply points at, checked by shape only; whether it exists in the workspace is the caller's question. */
export function parseReplyTo(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 64) throw new AgentRelayError("replyTo must be a handoff ID.");
  return value;
}

export { replyTitle } from "@/shared/formatting/reply-title";
