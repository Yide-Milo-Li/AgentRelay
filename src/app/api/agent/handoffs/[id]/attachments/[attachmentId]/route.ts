import { actorFromAgent } from "@/server/auth";
import { failure } from "@/server/http";
import { attachmentResponse } from "@/app/api/attachments/attachment-response";
export const dynamic = "force-dynamic";
// Read-only fallback for agents whose client does not hand them an MCP image block. An Agent Token identifies the
// workspace and Sites protects the gateway, exactly as for /api/agent/mcp; ownership, expiry and headers match the web route.
export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const { id, attachmentId } = await context.params;
    const actor = await actorFromAgent(request);
    return attachmentResponse(request, actor.owner, id, attachmentId, false);
  } catch (error) { return failure(error); }
}
