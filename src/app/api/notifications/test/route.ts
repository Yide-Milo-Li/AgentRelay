import { after } from "next/server";
import { actorFrom } from "@/server/auth";
import { body, failure, json, sameOrigin } from "@/server/http";
import { getNotificationHandoff, getNotificationSettings, sendNotificationTest } from "@/server/handoffs";
import { AgentRelayError } from "@/server/core/agent-relay-error";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = actorFrom(request), input = await body(request);
    if (Object.keys(input).some(key => !["browserId", "handoffId"].includes(key))
      || (input.handoffId !== undefined && (typeof input.handoffId !== "string" || input.handoffId.length > 128))) throw new AgentRelayError("Invalid notification test.");
    const settings = await getNotificationSettings(actor.owner, input.browserId);
    if (!settings.available) throw new AgentRelayError("Browser notifications are not configured on this Site.", 503);
    if (!settings.subscription || settings.subscription.disabledAt) throw new AgentRelayError("Enable notifications in this browser first.", 404);
    if (typeof input.handoffId === "string") await getNotificationHandoff(actor.owner, input.handoffId, input.browserId);
    after(async () => { try { await sendNotificationTest(actor.owner, input.browserId, input.handoffId as string | undefined); }
      catch { console.warn("AgentRelay notification test failed."); } });
    return json({ queued: true }, 202);
  } catch (error) { return failure(error); }
}
