import { countHandoffsByProject, createHandoff, listHandoffs, listInboxPage, sweepExpiredHandoffs } from "@/server/handoffs";
import { actorFrom, ownerFrom } from "@/server/auth";
import { AgentRelayError } from "@/server/core/agent-relay-error";
import { sameOrigin, body, json, failure } from "@/server/http";
import { remindExpiringConnections } from "@/server/connection-reminders";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await ownerFrom(request), params = new URL(request.url).searchParams, view = params.get("view");
    if (view === "project-counts") return json(await countHandoffsByProject(owner, Object.fromEntries(params)));
    if (view && view !== "summary") throw new AgentRelayError("Unknown list view.");
    // The open inbox polls this route, which makes it the steady occasion to look for due expiry reminders and to
    // delete expired handoffs.
    void remindExpiringConnections(owner);
    void sweepExpiredHandoffs(owner);
    if (view === "summary") return json(await listInboxPage(owner, Object.fromEntries(params)));
    // Deprecated: the newest 500 handoffs with their full text, kept for one release so that tabs opened before the
    // summary list keep working until they reload. The browser now asks for `view=summary`.
    return json({ handoffs: await listHandoffs(owner) });
  } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); return json(await createHandoff(await actorFrom(request), await body(request)), 201); } catch (e) { return failure(e); }
}
