import { handleMcp } from "@/server/mcp";
import { actorFromAgent, noteAgentClient } from "@/server/auth";
import { sweepingRemindersFor } from "@/server/connection-reminders";
import { sweepingExpiredFor } from "@/server/handoffs";
export const dynamic = "force-dynamic";
// Ordinary application route: the reserved /mcp gateway accepts Sites OAuth only.
export async function POST(request: Request) { return handleMcp(request, sweepingExpiredFor(sweepingRemindersFor(actorFromAgent)), true, noteAgentClient); }
export async function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
export async function DELETE() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
