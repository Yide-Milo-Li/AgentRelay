import { changeHandoff, deleteHandoff, getHandoff } from "@/server/handoffs";
import { ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { return json(await getHandoff(await ownerFrom(request), (await context.params).id)); } catch (e) { return failure(e); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const input = await body(request);
    return json(await changeHandoff(await ownerFrom(request), (await context.params).id, input, { undo: input.undo === true }));
  } catch (e) { return failure(e); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const owner = await ownerFrom(request);
    const input = await body(request, { allowEmpty: true });
    return json(await deleteHandoff(owner, (await context.params).id, input.version));
  } catch (e) { return failure(e); }
}
