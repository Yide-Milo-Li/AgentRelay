import { actorFrom } from "@/server/auth";
import { handleUpload } from "./handle-upload";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleUpload(request, actorFrom); }
