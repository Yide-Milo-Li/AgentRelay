import { rotateAgentToken } from "@/server/agent-tokens";
import { actorFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
// Replaces the secret of a connection the caller issued; the new secret is in this response only.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    return json(await rotateAgentToken(actorFrom(request), (await context.params).id, await body(request)));
  } catch (e) { return failure(e); }
}
