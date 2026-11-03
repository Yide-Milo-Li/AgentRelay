import { createAgentToken, listAgentTokens, removeInactiveAgentTokens } from "@/server/agent-tokens";
import { actorFrom } from "@/server/auth";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
// Agent credentials cannot mint more credentials or manage browser sessions.
export async function GET(request: Request) {
  try { const { owner, userId } = await actorFrom(request); return json({ tokens: await listAgentTokens(owner, userId) }); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return json(await createAgentToken(await actorFrom(request), await body(request)), 201);
  } catch (e) { return failure(e); }
}
// Bulk clean-up of revoked and expired credentials; active ones are never touched.
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const actor = await actorFrom(request);
    if (new URL(request.url).searchParams.get("scope") !== "inactive") throw new AgentRelayError("scope must be inactive.");
    return json(await removeInactiveAgentTokens(actor.owner, actor));
  } catch (e) { return failure(e); }
}
