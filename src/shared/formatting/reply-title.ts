import { HANDOFF_LIMITS } from "@/shared/contracts/handoffs";

/** `Re: <parent title>`, without stacking prefixes along a thread, cut to the title limit. The server and the composer share it. */
export function replyTitle(parent: string) {
  return (/^re:\s/i.test(parent) ? parent : `Re: ${parent}`).slice(0, HANDOFF_LIMITS.titleCharacters);
}
