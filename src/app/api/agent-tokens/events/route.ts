import { listConnectionEvents } from "@/server/agent-tokens";
import { ownerFrom } from "@/server/auth";
import { json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
// Connection history is read in the browser only; Agent credentials cannot read it.
export async function GET(request: Request) {
  try {
    const owner = await ownerFrom(request), params = new URL(request.url).searchParams;
    return json(await listConnectionEvents(owner, { limit: params.get("limit") ?? undefined, before: params.get("before") ?? undefined, tokenId: params.get("tokenId") ?? undefined }));
  } catch (e) { return failure(e); }
}
