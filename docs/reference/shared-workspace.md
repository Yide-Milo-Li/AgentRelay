# Shared workspace

Sharing is optional: by default a Site is one person's workspace for their own devices. When the owner enables it, the Site stays one workspace and the owner decides who is trusted by adding accounts as viewers in the Site's **Sharing** settings; every trusted account then sees all prompts, registers and manages devices, and sends prompts to any device in the workspace. There are no roles inside the workspace: everyone has the same rights as the owner.

The workspace is keyed by the owner's platform user id, configured once. Until it is configured, each signed-in account falls back to a private workspace of its own. To set it up:

1. Add them as viewers in the Site's **Sharing** settings. The Sites platform decides who can sign in; AgentRelay does not keep its own member list.
2. Sign in as the Site owner and open **Settings › General › Workspace › Share this workspace**. It shows a ready-to-paste request that contains your platform user id.
3. Give that request to Codex. It sets the environment variable `AGENTRELAY_WORKSPACE_OWNER_ID` to the id and redeploys; the deployment applies any pending migrations, so none is run by hand. To do it by hand instead, set the variable to the id shown on that card.

Members who should use the Site's ChatGPT/Codex plugin also need access to the plugin; Site Sharing alone does not grant it.

Every viewer then works on your existing records with the same rights as you: they see and manage all devices, handoffs and storage, send to any device, and claim what is sent to theirs. Nothing is migrated; a viewer's records from before sharing stay under their own id and are no longer shown to them.

- **Attribution**: new handoffs store the sender's id and display name (`created_by_user_id`, `created_by_name`); only the name is returned (`createdByName`) and shown on the route. Agent Tokens store their issuer the same way, and requests made with one act as that member.
- **Connections**: the connections list shows every member's tokens with "Issued by …", so anyone can revoke a leaked one. Removing someone from Sharing does **not** revoke their Agent Tokens; revoke them in the Agents tab.
- **Turning sharing off**: unset the variable. Web users fall back to their own workspaces, and tokens issued by other members stop authenticating (they would otherwise reach your records).
