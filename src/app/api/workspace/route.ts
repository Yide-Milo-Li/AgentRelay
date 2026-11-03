import { workspaceInfoFrom } from "@/server/auth";
import { json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return json(await workspaceInfoFrom(request)); } catch (e) { return failure(e); }
}
