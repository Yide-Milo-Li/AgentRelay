import { deleteProject, updateProject } from "@/server/projects";
import { ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try { sameOrigin(request); return json(await updateProject(await ownerFrom(request), (await context.params).id, await body(request))); } catch (e) { return failure(e); }
}
export async function DELETE(request: Request, context: Context) {
  try { sameOrigin(request); return json(await deleteProject(await ownerFrom(request), (await context.params).id, await body(request))); } catch (e) { return failure(e); }
}
