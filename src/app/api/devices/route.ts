import { listDevices } from "@/server/devices";
import { createDevice } from "@/server/device-lifecycle";
import { ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return json({ devices: await listDevices(await ownerFrom(request)) }); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); return json(await createDevice(await ownerFrom(request), await body(request)), 201); } catch (e) { return failure(e); }
}
