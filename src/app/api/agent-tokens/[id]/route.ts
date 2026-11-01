import { parseVersion, removeInactiveAgentToken, revokeAgentToken, updateAgentToken } from "@/server/agent-tokens";
import { actorFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const actor = actorFrom(request);
    return json(await updateAgentToken(actor.owner, (await context.params).id, await body(request), actor));
  } catch (e) { return failure(e); }
}
// DELETE revokes (optionally `?version=` the caller read); DELETE ?permanent=1 removes a credential that is already revoked or expired.
export async function DELETE(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const actor = actorFrom(request), { id } = await context.params, params = new URL(request.url).searchParams;
    if (params.get("permanent") === "1") return json(await removeInactiveAgentToken(actor.owner, id, actor));
    const version = params.get("version");
    return json(await revokeAgentToken(actor.owner, id, actor, version === null ? undefined : parseVersion(/^\d{1,9}$/.test(version) ? Number(version) : NaN)));
  } catch (e) { return failure(e); }
}
