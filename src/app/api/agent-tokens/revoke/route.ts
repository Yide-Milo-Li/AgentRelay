import { revokeTokenSet } from "@/server/agent-tokens";
import { actorFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
// Revoke exactly the listed connections, or none. Agent credentials cannot manage connections.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = actorFrom(request);
    return json(await revokeTokenSet(actor.owner, await body(request), actor));
  } catch (e) { return failure(e); }
}
