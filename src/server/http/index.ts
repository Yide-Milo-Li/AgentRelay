import { AgentRelayError } from "@/server/core/agent-relay-error";
import { storageQuotaError } from "@/server/core/storage-quota";
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new AgentRelayError("Cross-site writes are not accepted.", 403);
}
export async function body(request: Request, options?: { allowEmpty?: boolean }) {
  if (Number(request.headers.get("content-length")) > 1300000) throw new AgentRelayError("The request is too large.", 413);
  const raw = await request.text();
  if (raw.length > 1250000) throw new AgentRelayError("The request is too large.", 413);
  // A body-less legacy DELETE may arrive as an empty stream through the Worker adapter.
  if (!raw && options?.allowEmpty) return {} as Record<string, unknown>;
  let data;
  try { data = JSON.parse(raw); } catch { throw new AgentRelayError("The request is not valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AgentRelayError("The request must be a JSON object.");
  return data as Record<string, unknown>;
}
/**
 * Read a raw request body without ever holding more than `limit` bytes plus one chunk. `Content-Length` is only a
 * fast refusal: a chunked or understated body is still counted as it streams.
 */
export async function rawBody(request: Request, limit: number, tooLarge: (declaredBytes: number | null) => string): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new AgentRelayError(tooLarge(Number(declared)), 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw new AgentRelayError(tooLarge(null), 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function failure(error: unknown) {
  const known = error instanceof AgentRelayError ? error : storageQuotaError(error);
  if (!known) {
    // Log the storage cause only; query wrappers can contain private prompt text.
    const cause = (error as { cause?: { message?: string } })?.cause;
    console.error("AgentRelay API failure", cause?.message ?? (error as Error)?.name);
    return json({ error: "AgentRelay is temporarily unavailable. Try again shortly." }, 500);
  }
  const response = json({ error: known.message }, known.status);
  if (known.retryAfterSeconds) response.headers.set("Retry-After", String(known.retryAfterSeconds));
  return response;
}
