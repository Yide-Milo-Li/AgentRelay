import { ownerFrom } from "@/server/auth";
import { failure } from "@/server/http";
import { attachmentResponse } from "@/app/api/attachments/attachment-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const { id, attachmentId } = await context.params;
    // Normal reads honour the handoff's expiry; Storage management has its own route.
    return attachmentResponse(request, await ownerFrom(request), id, attachmentId, false);
  } catch (error) { return failure(error); }
}
