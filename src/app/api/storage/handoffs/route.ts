import { listStorageHandoffs, purgeExpiredQuietly } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = ownerFrom(request);
    // Like the summary: the list never shows handoffs that are due for deletion.
    await purgeExpiredQuietly(owner);
    return json(await listStorageHandoffs(owner, new URL(request.url).searchParams));
  } catch (error) { return failure(error); }
}
