import { deleteStorageHandoffs } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { body, sameOrigin, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const owner = ownerFrom(request), input = await body(request);
    const result = await deleteStorageHandoffs(owner, input);
    return json(result, result.results.some(item => item.status === "conflict") ? 409 : 200);
  } catch (error) { return failure(error); }
}
