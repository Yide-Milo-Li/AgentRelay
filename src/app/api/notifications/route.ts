import { actorFrom } from "@/server/auth";
import { body, failure, json, sameOrigin } from "@/server/http";
import { deleteNotificationSubscription, getNotificationSettings, saveNotificationSubscription, updateNotificationSubscription } from "@/server/handoffs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const url = new URL(request.url); return json(await getNotificationSettings(actorFrom(request).owner, url.searchParams.get("browserId"), url.origin)); }
  catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try { sameOrigin(request); const actor = actorFrom(request); return json(await saveNotificationSubscription(actor.owner, await body(request), actor)); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try { sameOrigin(request); const actor = actorFrom(request); return json(await updateNotificationSubscription(actor.owner, await body(request))); }
  catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try { sameOrigin(request); const actor = actorFrom(request); return json(await deleteNotificationSubscription(actor.owner, (await body(request)).browserId)); }
  catch (error) { return failure(error); }
}
