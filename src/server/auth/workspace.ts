import { env } from "cloudflare:workers";

/**
 * The platform user id whose records every signed-in visitor shares, or null for a private site.
 * Who may sign in at all is decided by the Site's sharing settings, never by this application.
 */
export function sharedWorkspaceOwner(): string | null {
  const value = env.AGENTRELAY_WORKSPACE_OWNER_ID?.trim();
  return value ? value : null;
}
