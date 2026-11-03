import { revokeIssuerTokens } from "@/server/agent-tokens";
import { actorFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await actorFrom(request);
    return json(await revokeIssuerTokens(actor.owner, await body(request), actor));
  } catch (e) { return failure(e); }
}
