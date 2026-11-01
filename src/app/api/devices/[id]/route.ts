import { updateDevice } from "@/server/devices";
import { deleteDevice, getDeviceDetail } from "@/server/device-lifecycle";
import { actorFrom, ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { return json(await getDeviceDetail(ownerFrom(request), (await context.params).id)); } catch (e) { return failure(e); }
}
export async function PATCH(request: Request, context: Context) {
  try { sameOrigin(request); return json(await updateDevice(ownerFrom(request), (await context.params).id, await body(request))); } catch (e) { return failure(e); }
}
export async function DELETE(request: Request, context: Context) {
  try { sameOrigin(request); const actor = actorFrom(request); return json(await deleteDevice(actor.owner, (await context.params).id, await body(request), actor.name)); } catch (e) { return failure(e); }
}
