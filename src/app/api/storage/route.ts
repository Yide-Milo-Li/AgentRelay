import { getStorageSummary, purgeExpiredQuietly } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = ownerFrom(request);
    // Delete what is due before measuring, so Storage never counts handoffs that are about to go.
    await purgeExpiredQuietly(owner);
    return json(await getStorageSummary(owner));
  } catch (error) { return failure(error); }
}
