import { handleMcp } from "@/server/mcp";
import { actorFrom } from "@/server/auth";
import { sweepingRemindersFor } from "@/server/connection-reminders";
import { sweepingExpiredFor } from "@/server/handoffs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleMcp(request, sweepingExpiredFor(sweepingRemindersFor(actorFrom))); }
