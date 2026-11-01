import { AgentRelayError } from "@/server/core/agent-relay-error";
import type { Actor } from "@/server/core/actor";
import { resolveAgentToken, recordAgentAuthentication, recordAgentClient, agentConnectionInfo } from "@/server/agent-tokens";
import { userFromHeaders } from "./chatgpt-user";
import type { WorkspaceInfo } from "@/shared/contracts/workspace";
import { sharedWorkspaceOwner } from "./workspace";

export { requireChatGPTUser, getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from "./chatgpt-user";

/** Map the platform-authenticated user onto the workspace that scopes their records. */
export function actorFrom(request: Request): Actor {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) throw new AgentRelayError("Sign in with ChatGPT first.", 401);
  const name = userFromHeaders(request.headers)?.displayName ?? null, workspace = sharedWorkspaceOwner();
  return { owner: workspace ?? userId, userId, name };
}
/** Whether sharing is on and, while it is off, the caller's own id to configure it with. */
export function workspaceInfoFrom(request: Request): WorkspaceInfo {
  const { userId, name } = actorFrom(request);
  const identity = { viewerName: name, workspaceLabel: "AgentRelay" };
  return sharedWorkspaceOwner() ? { shared: true, ...identity } : { shared: false, userId, ...identity };
}
export function ownerFrom(request: Request) {
  return actorFrom(request).owner;
}
/** Resolve the stored owner only after validating the bearer credential format. */
async function authenticateAgent(request: Request) {
  const match = /^Bearer (agentrelay_[a-f0-9]{64})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new AgentRelayError("A valid personal Agent Token is required.", 401);
  const record = await resolveAgentToken(match[1]);
  // Credentials minted before attribution existed were always issued by the owner itself.
  const userId = record.createdByUserId ?? record.ownerId;
  // A member's credential reaches the shared records only while that workspace is still shared.
  if (userId !== record.ownerId && record.ownerId !== sharedWorkspaceOwner())
    throw new AgentRelayError("The Agent Token is invalid, expired or revoked.", 401);
  await recordAgentAuthentication(record.ownerId, record.id);
  return { actor: { owner: record.ownerId, userId, name: record.createdByName, connectionId: record.id, deviceId: record.deviceId }, record };
}
export async function actorFromAgent(request: Request): Promise<Actor> { return (await authenticateAgent(request)).actor; }
/** Keep what an agent reports about itself on MCP initialize. Display only, so a failure here never fails the request. */
export async function noteAgentClient(actor: Actor, clientInfo: unknown) {
  if (actor.connectionId) await recordAgentClient(actor.owner, actor.connectionId, clientInfo).catch(() => {});
}
/** Diagnostic authentication shares exactly the same owner and membership resolution as MCP. */
export async function connectionFromAgent(request: Request) {
  const { record } = await authenticateAgent(request);
  return { connection: agentConnectionInfo(record), workspace: { shared: !!sharedWorkspaceOwner(), label: "AgentRelay" } };
}
