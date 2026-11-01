import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); } catch {
    const previous = document.activeElement;
    const textarea = document.createElement("textarea"); textarea.value = text;
    textarea.style.position = "fixed"; textarea.style.opacity = "0"; document.body.appendChild(textarea); textarea.select();
    try {
      if (!document.execCommand("copy")) throw new AgentRelayClientError("errClipboard");
    } finally {
      textarea.remove();
      // The fallback must not strand keyboard users on the document body.
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    }
  }
}
