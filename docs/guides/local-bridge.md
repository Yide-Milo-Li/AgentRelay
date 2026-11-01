# Local bridge for limited agents

The default bridge is the installed local client: `node <stable-launcher> bridge --connection <id>`. Configure it through your Site's wizard as described in [Agent connections](agent-connections.md). It reads the selected connection's credentials from OS storage (or the explicitly selected isolated environment backend), adds both request headers and relays newline-delimited JSON-RPC. Agent config contains no credentials and does not depend on the checkout's location.

The bridge shares the same server and five tools as direct HTTP. It forwards notifications without replies, refuses batches, and never interprets prompts or executes a handoff. Stdout is protocol only; errors omit response bodies and credentials. Requests are bounded and authenticated requests do not follow redirects.

Antigravity and DeepSeek Harness use this path. Other agents fall back to it when dynamic HTTP header helpers are unavailable; `--transport bridge` selects it explicitly. Reconnect/restart the agent after updating stored credentials.

## Legacy process-environment entrypoint

Existing setups may still call `scripts/agents/mcp-bridge.mjs` with `AGENTRELAY_MCP_URL`, `AGENTRELAY_AGENT_TOKEN` and `AGENTRELAY_SITES_GATEWAY_TOKEN`. That compatibility entrypoint remains available for gradual migration; it reads the process environment and does not save credentials. It requires the checkout at the configured path.

New `connect-device.mjs --persist-env` commands now forward to the new client and use isolated variables. They no longer set the legacy global token slot. Migrate one Agent at a time and revoke the old token only after the replacement passes its actual Agent check. Never put token values in an MCP env block or command arguments.

## Verification and recovery

`npm run test:integration:bridge` exercises the shared bridge's five-tool flow against a built local Worker. `npm run test:integration:client` separately exercises installed credential loading, JSON header output, bridge discovery and image commands outside the checkout. These checks do not prove an actual Claude/Codex/Antigravity session or hosted gateway.

For missing tools, check the connection id, Site URL, Node path, OS-store availability and token revocation/expiry. For 401/403 check the Site gateway credential as well; `connect --renew-gateway` replaces the cached Site gateway through hidden input. For images use the installed `upload` and `download` commands, which share the same connection reference.
