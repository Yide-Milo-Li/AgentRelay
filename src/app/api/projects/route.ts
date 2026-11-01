import { createProject, listProjects } from "@/server/projects";
import { ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return json({ projects: await listProjects(ownerFrom(request)) }); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); return json(await createProject(ownerFrom(request), await body(request)), 201); } catch (e) { return failure(e); }
}
