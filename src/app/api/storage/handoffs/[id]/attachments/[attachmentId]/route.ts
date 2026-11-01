import { ownerFrom } from "@/server/auth";
import { failure } from "@/server/http";
import { attachmentResponse } from "@/app/api/attachments/attachment-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const { id, attachmentId } = await context.params;
    // Storage management may inspect the images of expired handoffs before deciding to delete them.
    return attachmentResponse(request, ownerFrom(request), id, attachmentId, true);
  } catch (error) { return failure(error); }
}
