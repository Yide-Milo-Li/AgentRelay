import { actorFrom } from "@/server/auth";
import { failure, json } from "@/server/http";
import { getNotificationConnection } from "@/server/connection-reminders";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return json(await getNotificationConnection(actorFrom(request).owner, (await context.params).id, new URL(request.url).searchParams.get("browserId"))); }
  catch (error) { return failure(error); }
}
