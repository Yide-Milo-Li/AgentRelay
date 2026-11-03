import { sweepAttachments } from "@/server/attachments";
import { ownerFrom } from "@/server/auth";
import { sameOrigin, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
/** Bounded cleanup on request: reclaims stale uploads and retries queued object deletions. There is no scheduler. */
export async function POST(request: Request) {
  try { sameOrigin(request); return json(await sweepAttachments(await ownerFrom(request))); } catch (error) { return failure(error); }
}
