import type { AgentProfile } from "@/shared/agent-profiles";

/** The setup command for one connection. It names the connection by id and carries no secret: the local client asks for it. */
export function connectCommand({ profile, deviceId, connectionId, siteUrl, lang }: {
  profile: AgentProfile; deviceId: string | null; connectionId: string; siteUrl: string; lang: string;
}) {
  return `node scripts/agents/agentrelay.mjs connect --profile ${profile.id}${deviceId ? ` --device ${deviceId}` : ""} --connection ${connectionId} --url ${siteUrl}/api/agent/mcp${lang === "zh" ? " --lang zh" : ""}`;
}

/**
 * Re-does a connection's skill and rule on its device after it is bound or unbound in the Site. The local client uses
 * the credentials it saved during setup, so no token is involved.
 */
export function skillCommand(connectionId: string) {
  return `node scripts/agents/agentrelay.mjs skill --connection ${connectionId}`;
}

/** Puts the Site's saved gateway token on the clipboard of a device that has it, for a password manager. Never prints it. */
export function gatewayCopyCommand(siteUrl: string) {
  return `node scripts/agents/agentrelay.mjs gateway --url ${siteUrl} --copy`;
}
