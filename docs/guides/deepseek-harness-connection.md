# Connect DeepSeek Harness

Follow the canonical [Agent connections guide](agent-connections.md). It covers hidden credential entry, OS storage, isolated environment compatibility, verification, migration and recovery. This page covers what differs for DeepSeek Harness (`dsh`, desktop app and CLI).

In your Site, choose **Agents → New connection → DeepSeek Harness**, choose this device and review the lifetime. Run the command from the verification step:

```text
node scripts/agents/agentrelay.mjs connect --profile deepseek-harness --device <device-id> --connection <connection-id> --url https://<your-site>/api/agent/mcp
```

The client checks both credentials, all five tools and the resolved connection and device before it writes anything. The `dsh` command does not need to be on PATH; the desktop app alone is enough.

## What the client writes

| File | Change |
| --- | --- |
| `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`) | One `- insert:` block holding a single row, `id: mcp-agentrelay`, for `@deepseek-ai/dsh-mcp-client` with `serverName: agentrelay` and stdio transport |
| `$DSH_HOME/AGENTS.md` (default `~/.dsh/AGENTS.md`) | The marked AgentRelay device rule block |

The home patch is shared by every dsh profile (desktop, web, headless), so one connection serves all of them. The row starts the installed client's stdio bridge (`node <stable-launcher> bridge --connection <id>`), which reads this connection's credentials from the OS credential store. The file holds paths and the connection id, never a token.

A new plugin row must sit in an `insert` block: dsh treats a bare top-level `- id:` entry as an override of an existing row and reports `patch: entry "mcp-agentrelay" not found`. dsh also rewrites `cordis.patch.yml` itself when you change settings such as language or theme, which can move or drop comments. The client therefore finds its block by the row id, not by marker comments, and leaves every other entry and comment as it was. Running `connect` again replaces that block, and also replaces a bare `mcp-agentrelay` row left by a hand edit. It refuses, with no files changed, when:

- the file is not a YAML list of patch entries;
- another row already uses `serverName: agentrelay` (two rows with one server name fail to load in dsh); remove or rename it first;
- the `mcp-agentrelay` row shares an insert block with other rows, appears more than once, or sits in an insert block written in flow style.

To write a single profile's patch instead (for example `~/.dsh/profiles/desktop/cordis.patch.yml`), pass `--config-file`. If `DSH_AGENTS_HOME` points at a shared agents directory you prefer for instructions, pass `--rule-file`.

## Transport and environment storage

DeepSeek Harness has no dynamic header helper, so this profile always uses the bridge; `--transport direct` is refused.

The profile also asks the bridge for two adjustments (`bridgeCompatibility` in its profile), because dsh cannot use two of the Site's answers as they are:

- **Core schemas.** dsh accepts tool parameter schemas only in a small JSON Schema subset (`type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const` and annotations) and registers none of a server's tools when one schema uses anything else. The bridge removes other keywords from `tools/list`, such as `minimum`, `maximum` and `maxItems`, and appends them to the field's description. The Site still enforces every bound.
- **Initialize only.** dsh's MCP SDK first probes `server/discover`. Sites deployed before the Agent endpoint stopped answering that probe advertise Sites' own stateless era there, which dsh then tries and abandons after `tools/list`, reconnecting without registering tools. The bridge answers the probe with "method not found", so dsh uses the `initialize` handshake, which works. Current Sites give the same answer themselves; the bridge keeps doing it so a device can connect to an older deployment.

Both adjustments live in the local bridge; other agents and the Site are unchanged.

dsh removes inherited variables whose names contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` and all `DSH_*` variables from MCP servers. With the default OS storage this does not matter. With `--storage env`, the row forwards this connection's two variables by name (`NAME: !!js process.env.NAME`); their values stay in your user environment. Restart the dsh desktop app after saving them so it inherits the new environment.

## Verify

1. dsh reloads a changed patch file in place; if the tools do not appear, restart the desktop app. dsh connects MCP servers when a session starts, so open a new session.
2. Use a **Standard** or **Code** agent mode. Minimal mode exposes only shell and editor tools and hides MCP tools.
3. Confirm `mcp__agentrelay__create_handoff`, `list_handoffs`, `get_handoff`, `claim_handoff` and `complete_handoff`. If the agent sees an `agentrelay` server only through the generic resource tools, the tools were not registered: check that `~/.agentrelay/client/current.json` names client 0.2.1 or later (rerunning `connect` from a current checkout installs it) and open a new session.
4. Make a read-only `list_handoffs` call filtered by this device and `status: "ready"`. An empty list is a valid result.

## Manual configuration

The Site's configuration preview shows an insert block that starts the repository bridge (`scripts/agents/mcp-bridge.mjs --core-schemas --initialize-only`) with the legacy `AGENTRELAY_AGENT_TOKEN` and `AGENTRELAY_SITES_GATEWAY_TOKEN` variables, forwarded by name for the reason above. Prefer the `connect` command, which keeps the credentials in OS storage.

DeepSeek Harness is a pre-release (0.x) whose plugin contracts may still change. Recheck the row after upgrading dsh.
