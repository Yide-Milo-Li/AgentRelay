import { actorFromAgent } from "@/server/auth";
import { handleUpload } from "@/app/api/attachments/handle-upload";
export const dynamic = "force-dynamic";
// Ordinary application route like /api/agent/mcp: an Agent Token identifies the workspace, Sites protects the gateway.
export async function POST(request: Request) { return handleUpload(request, actorFromAgent); }
export async function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
