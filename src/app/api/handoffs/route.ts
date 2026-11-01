import { createHandoff, listHandoffs, sweepExpiredHandoffs } from "@/server/handoffs";
import { actorFrom, ownerFrom } from "@/server/auth";
import { sameOrigin, body, json, failure } from "@/server/http";
import { remindExpiringConnections } from "@/server/connection-reminders";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = ownerFrom(request);
    // The open inbox polls this route, which makes it the steady occasion to look for due expiry reminders and to
    // delete expired handoffs.
    void remindExpiringConnections(owner);
    void sweepExpiredHandoffs(owner);
    return json({ handoffs: await listHandoffs(owner) });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); return json(await createHandoff(actorFrom(request), await body(request)), 201); } catch (e) { return failure(e); }
}
