import { getStorageHandoff } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return json(await getStorageHandoff(ownerFrom(request), (await context.params).id)); } catch (error) { return failure(error); }
}
