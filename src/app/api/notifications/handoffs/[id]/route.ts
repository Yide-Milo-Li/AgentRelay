import { actorFrom } from "@/server/auth";
import { failure, json } from "@/server/http";
import { getNotificationHandoff, getNotificationProgress } from "@/server/handoffs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = new URL(request.url).searchParams, owner = actorFrom(request).owner, id = (await context.params).id;
    // `kind=progress` is a sender's view of its own handoff; without it the browser is asking about one waiting for its device.
    return json(params.get("kind") === "progress" ? await getNotificationProgress(owner, id, params.get("browserId"))
      : await getNotificationHandoff(owner, id, params.get("browserId")));
  }
  catch (error) { return failure(error); }
}
