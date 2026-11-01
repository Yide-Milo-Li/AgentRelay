import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import type { AttachmentInfo } from "@/shared/contracts/attachments";

/**
 * Upload one image as a raw body. `key` is the retry identity: repeating the call with the same key and file returns the
 * existing upload instead of creating another. The server re-validates everything the browser already checked.
 */
export async function uploadImage(bytes: Blob, options: { key: string; name: string; mimeType: string; signal?: AbortSignal }): Promise<AttachmentInfo> {
  let response: Response;
  try {
    response = await fetch("/api/attachments", { method: "POST", cache: "no-store", signal: options.signal, body: bytes, headers: {
      "Content-Type": options.mimeType, "X-Upload-Key": options.key, "X-Filename": encodeURIComponent(options.name) } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AgentRelayClientError("errConnection");
  }
  if (response.status === 401 || response.redirected) throw new AgentRelayClientError("errSession");
  let result: (AttachmentInfo & { error?: string }) | undefined;
  try { result = await response.json(); } catch { throw new AgentRelayClientError("errConnection"); }
  if (!response.ok || !result?.id) throw new AgentRelayClientError("errFailed", result?.error);
  return result;
}
