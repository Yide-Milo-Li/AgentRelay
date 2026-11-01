import { readAttachment } from "@/server/attachments";
import { failure } from "@/server/http";

/** Stream one stored image. Never cacheable, never sniffed, never scriptable, and the object key stays on the server. */
export async function attachmentResponse(request: Request, owner: string, handoffId: string, attachmentId: string, includeExpired: boolean) {
  try {
    const { info, object } = await readAttachment(owner, handoffId, attachmentId, { includeExpired });
    const download = new URL(request.url).searchParams.get("download") === "1";
    const ascii = info.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new Response(object.body, { headers: {
      "Content-Type": info.mimeType, "Content-Length": String(info.bytes),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(info.filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) { return failure(error); }
}
