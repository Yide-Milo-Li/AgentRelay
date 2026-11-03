import { getHandoff } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { failure } from "@/server/http";
import { AgentRelayError } from "@/server/core/agent-relay-error";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const row = await getHandoff(await ownerFrom(request), (await context.params).id);
    if (!row.content) throw new AgentRelayError("This handoff has no text to export; it contains images only.", 409);
    const url = new URL(request.url);
    const isTxt = url.searchParams.get("format") === "txt";
    const ext = isTxt ? "txt" : "md";
    const contentType = isTxt ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8";
    const filename = `${row.title.replace(/[<>:"/\\|?*\r\n]/g, "_").slice(0, 80)}.${ext}`;
    return new Response(row.content, { headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="agentrelay-prompt.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return failure(e); }
}
