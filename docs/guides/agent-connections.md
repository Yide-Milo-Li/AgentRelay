# Agent connections

One Site is one workspace. Create a separate connection for each agent on each device. A connection's device is where its agent runs: the agent can call it `self`. The device never restricts the token's access. Every token acts as its issuer across the workspace.

## Set up an agent

1. **Choose the device in the Site.** In **Agents → New connection**, pick the device the agent runs on (the setup checklist opens this with the current device chosen), then the agent.
2. **Create the connection, or follow the plugin steps.** A token connection gets a name and a lifetime, then **Create connection** shows its one-time token and setup command. The Site's plugin issues no token; see [The Site's plugin](#the-sites-plugin).
3. **Run the command on that device.** In the AgentRelay folder, run the command the wizard shows and paste the Agent Token when asked. The first connection on a device also asks for the Site's [gateway token](#the-gateway-token). Restart or reconnect the agent and ask it: "Any handoffs for me?"

| Agent | Profile | Transport | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | Direct HTTP with a header helper on Claude Code >=2.1.310, otherwise the bridge | |
| Codex | `codex` | Direct HTTP with a header helper on Codex >=0.164.0, otherwise the bridge | The Site's plugin is the alternative that needs no token. |
| Antigravity | `antigravity` | Local bridge | |
| DeepSeek Harness | `deepseek-harness` | Local bridge | See [its guide](deepseek-harness-connection.md). |
| ChatGPT or Codex (this Site's plugin) | none | The Site's native `/mcp` | No token, repository or Node.js; see below. |

The default lifetime is 90 days. The UI also offers 30 days, 365 days and **Permanent**. Selecting Permanent opens a risk dialog, initially focused on Cancel. Cancel, Escape or clicking the backdrop preserves the previous choice. Confirming the dialog only selects the lifetime; the final Create action issues the token. Selecting another finite lifetime clears the acknowledgement, and selecting Permanent again asks again. Existing tokens are never extended automatically.

A permanent token has no automatic expiry, but it is still revocable and subject to the same workspace authentication rules. Use it only on devices you control long term. Revoke it if a device is lost, transferred or compromised.

## The Site's plugin

Publishing a Site that declares the `mcp` capability creates a private ChatGPT/Codex App and plugin for it; each publish refreshes its tools. It uses platform sign-in, so it needs no Agent Token, gateway token, repository or Node.js.

1. Install it: in ChatGPT or Codex, open **Plugins → Personal → Created by you**, find the Site's AgentRelay plugin and choose **Install** or **Connect**. Or ask Codex to read the Site with `get_site` (including its MCP connection) and show the install card for its `mcp_connection.plugin_id`.
2. Give it the device: the plugin has no `self`, so its agent must name a device id. For Codex on this device, add the device rule the wizard shows (rendered with this device's id) to `~/.codex/AGENTS.md`, or the override file when one is in use. For ChatGPT, start a new chat with the message the wizard shows; it states the id and asks for a read-only list. Nothing assumes a rule carries over between chats.
3. Check it: the agent should list the handoffs waiting for this device and claim nothing.

The page cannot see plugin connections: they do not appear in the connection list, have no last-use time and no device. The setup checklist therefore records "this device uses the plugin" as your own confirmation in that browser. Other members need access to the plugin, its App and the Site; Site Sharing alone does not grant the plugin. Plugin sharing is documented for Business and Enterprise; sharing between personal accounts is not promised. The image `upload` and `download` commands still need a token connection.

## The gateway token

A private Site lets a request past its Sites sign-in gate only when it carries the Site's gateway token, which `get_site` returns as `siwc_bypass_bearer_token` and agents send as `OAI-Sites-Authorization`. It supplies no identity and grants nothing inside AgentRelay without an Agent Token. It is one credential per Site, not tied to an agent, device or operating system: the client saves it per Site origin and every agent on the device reuses it, while each Agent Token is saved per connection.

On a device with Codex that has access to the Site, ask Codex to save it (the wizard and the [first deployment guide](first-deployment.md#the-gateway-token) have the exact request): read the existing token with `get_site`, pass it on stdin to `node scripts/agents/agentrelay.mjs gateway --url <site> --stdin`, never print it or write it to the repository, retain it in session memory only long enough to pass it on, and never call `generate_siwc_bypass_token`, which rotates it for every device. `gateway --stdin` saves the token only after the Site lets a request with it through.

On a device without Codex, take it from a device that has it:

```bash
node scripts/agents/agentrelay.mjs gateway --url https://<your-site> --copy
```

`--copy` reads only the saved gateway token of that Site, needs no Agent Token or connection, and hands it to the clipboard tool (`clip.exe`, `pbcopy`, `wl-copy`, `xclip` or `xsel`) on stdin. It never writes it to the terminal, a log or a file, and fails rather than print it when no clipboard works. Save it in your password manager and paste it into `connect`'s hidden prompt on the other device. Keeping it off the terminal keeps it out of chats and command output, but clipboard history or cross-device sync may still keep a copy. `connect` and `gateway --stdin` never copy.

The token has no documented fixed lifetime. Save it once per device and reuse it; after it is rotated, save the new one on every device with `gateway --stdin` or `connect --renew-gateway`. With `--storage env`, `gateway` keeps it in an isolated environment variable instead.

## Configure locally

Install Node.js >=22.13.0 and get a copy of this repository; no `npm install` is needed. The first run of `scripts/agents/agentrelay.mjs` installs the client into `~/.agentrelay/client/` and runs every command from there: it copies the OS keyring addon from the checkout's dependencies when they are installed, and otherwise installs that one pinned package with npm. A failed install leaves the installed versions as they were. An optional Windows x64 client archive can replace the repository on receiving devices after a Release is published. There is no required desktop app or background service.

The local token client currently supports one Site per OS user and refuses connections to a second Site. Its manifest, MCP entries, rules, skills and OS credentials belong to that OS user, independently of the ChatGPT account currently signed in. Use a separate OS user or machine when testing another Site; changing ChatGPT accounts does not isolate these files or credentials.

Run the command shown by your Site, for example:

```text
node scripts/agents/agentrelay.mjs connect --profile codex --device laptop --connection <connection-id> --url https://<your-site>/api/agent/mcp
```

It first says which agent, device, Site and connection it sets up, then asks for the Agent Token with hidden input, and for the gateway token only when none is saved for that Site on this device. If the gateway token was rotated, rerun connect with `--renew-gateway` to enter and replace it. Never paste credentials into command arguments, issue reports or repository files.

For automation, `--stdin` accepts one JSON object with `agentToken` and `gatewayToken` through a pipe. Do not put that JSON in shell history or a tracked file. `--from-env` explicitly imports the old `AGENTRELAY_AGENT_TOKEN` and `AGENTRELAY_SITES_GATEWAY_TOKEN` (or Codex's gateway header) from the current process. It does not overwrite or delete those legacy variables.

Before writing agent configuration, the client verifies exactly the five expected tools and `/api/agent/connection`. It refuses a different connection id or device label. It preflights both configuration files, preserves unrelated entries and restores its changes after failed writes. An unmanaged Codex AgentRelay table must be reviewed and removed manually before migration; it is never silently overwritten.

Default credential storage:

| OS | Backend | Acceptance |
| --- | --- | --- |
| Windows | Credential Manager | Synthetic store round trip tested on Windows x64 |
| macOS | Keychain | Implemented; real-machine acceptance pending |
| Linux | Secret Service, explicitly required | Implemented; desktop/session unlock and real-machine acceptance pending |

An unavailable/locked credential store is an error. Linux never silently falls back to a kernel-memory store. `--storage env` is an explicit compatibility choice: it saves isolated per-connection variables and a per-Site gateway variable. These are plaintext and inherited by child processes. Restart the terminal and agent after choosing that mode. OS credential storage also does not isolate programs running as the same operating-system user.

## Transport and files

Auto mode uses direct HTTP with a dynamic header helper for verified compatibility baselines: Codex >=0.164.0 and Claude Code >=2.1.310. These are conservative tested-version gates, not the versions that first introduced helpers. Unknown/older versions, Antigravity and DeepSeek Harness use the stdio bridge. `--transport bridge` forces that fallback; `--transport direct` explicitly opts into helper support on another known-compatible version. No agent is automatically upgraded.

| Agent | MCP config | Instructions | Skill |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json`, only `mcpServers.agentrelay` | `~/.claude/CLAUDE.md` | `~/.claude/skills/agentrelay/` |
| Codex | `~/.codex/config.toml`, marked block | `~/.codex/AGENTS.md` | `~/.agents/skills/agentrelay/` |
| Antigravity | `~/.gemini/config/mcp_config.json`, only the AgentRelay entry | `~/.gemini/GEMINI.md` | `~/.gemini/config/skills/agentrelay/` |
| DeepSeek Harness | `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`), only AgentRelay's `insert` block (row `mcp-agentrelay`); see [its guide](deepseek-harness-connection.md) | `$DSH_HOME/AGENTS.md` | `$DSH_HOME/skills/agentrelay/` |

Use the clients' normal default configuration homes for this iteration; custom `CLAUDE_CONFIG_DIR`/`CODEX_HOME` configurations require explicit config/rule/skill paths (`--config-file`, `--rule-file`, `--skill-dir`). If Codex uses `AGENTS.override.md`, select that file instead. Configuration stores paths and connection ids, never the tokens. Replacing a managed entry removes its previous bearer/header/environment settings, which could otherwise take precedence over a helper. Review existing OAuth or project-level overrides if the client still selects another credential.

The client installs into `~/.agentrelay/client/versions/<version>/` with a stable `~/.agentrelay/client/agentrelay.mjs` launcher. The private `~/.agentrelay/connections.json` manifest stores the URL, connection id, profile, device id and credential references. Configurations and generated image commands point at the stable launcher and survive moving/deleting the checkout. Re-running setup replaces marked blocks. Only one Site is supported per OS user in this iteration.

To update, run the new repository/archive's `node scripts/agents/agentrelay.mjs install` (it prints what it installed; `--json` for the machine-readable result); keep the previous version for `node <stable-launcher> rollback`. Reconnect/restart the agent after switching versions. Release archives include the native dependency, its license texts, provenance and a SHA-256 checksum; they require Node.js and do not bundle it.

Dynamic header contracts: [Codex HTTP MCP helpers](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication). Local helpers apply to the local agent environment; do not assume they work in a cloud/remote executor.

## The agentrelay skill

For a connection bound to a device, `connect` also installs the `agentrelay` Agent Skill into the folder in the table above, and the instruction block becomes a short rule that points to it. The skill carries the handoff procedure, so the full procedure loads only when a handoff comes up instead of in every session. It has four actions:

- **send**: reads the code state with `<stable-launcher> context`, asks whether to push unpushed commits, lists uncommitted changes (they are not carried), drafts the handoff from a template and shows it before sending.
- **inbox**: lists ready handoffs for this device and marks which match the current repository. It never claims.
- **take**: compares the handoff's `baseCommit` with the checkout using `<stable-launcher> check-base` (fetch, then compare; it never switches, pulls or stashes), asks before any branch switch, and claims only after you agree.
- **done**: drafts the completion receipt from the commits since the base commit, shows it, then completes the handoff.

Ask in plain words ("hand this off to Desktop", "交接到台式机", "any handoffs for me?"), or invoke it directly: `/agentrelay` in Claude Code, Antigravity and DeepSeek Harness, `$agentrelay` in Codex. The skill only describes how to use the five tools; the server still enforces every rule, and the tool descriptions keep the safety rules for an agent that does not load it.

- **The same skill for every agent.** The skill's text names no connection. The agent's rule block says which device it is on and names its agent profile, and the skill's image commands take `--agent <profile>`, which uses that agent's active connection on this device. An agent that also reads another agent's skill folder (Antigravity when its `skills.json` lists `~/.agents/skills`, DeepSeek Harness after its own folder) therefore still acts with its own connection, whichever copy it loads. Client 0.5.0 introduced this (0.5.1 is the first build that also rewrites the rules on `install`); run `install` (or `skill`) on each device to update skills and rules written earlier.
- **One skill per agent.** On a device, each agent has one MCP entry, one rule block and one skill folder, and they follow the connection `connect` last set up for that agent (its active connection; other saved connections of the same agent are history). `connect` makes the folder match: it installs the skill for a bound connection, replacing a skill another connection left, and otherwise removes any AgentRelay skill there, in the same rolled-back batch, so the agent cannot load a skill whose `self` no longer resolves.
- `connect` ends with a summary: the files it wrote, where the skill is and how to invoke it, and what to do next. Pass `--json` for the machine-readable result instead.
- `node scripts/agents/agentrelay.mjs skill --connection <id>`, run in the AgentRelay folder, installs, repairs or removes the skill of an agent's active connection. It first installs that checkout's client, as `connect` does, and renders the skill from it, so the skill never calls commands the installed client lacks; the summary names a version change. It reuses the saved credentials, so no token is asked for, asks the Site whether the connection is bound, and rewrites only the rule block and the skill (never the MCP config). Use it to add the skill to a connection set up before the skill existed, and after binding or unbinding a connection in the Site; the Site's toast offers the command when you do. `--remove` opts the connection out; `--skill-dir`, `--rule-file` and `--lang` work as in `connect`, and a leading `~` in a path means your home folder. For another saved connection of the same agent it refuses and names the active one: run `connect` for a connection to make it active.
- A connection saved before its instruction file was recorded uses the default file only if `connect` wrote the AgentRelay rule there, and keeps that rule's language; otherwise pass `--rule-file`.
- `--no-skill` keeps the full rule and installs no skill, for an agent version without skill support. Unbound connections always get the full rule, because the skill sends and claims as `self`.
- Only a folder whose `SKILL.md` frontmatter carries `managed-by: agentrelay-client` is ever replaced or removed. If an `agentrelay` skill you wrote is already there, `connect` stops before any write; rename it or use `--no-skill` or `--skill-dir`. To keep your own edits to the installed skill, remove the marker; AgentRelay then leaves the folder alone.
- `install` re-renders the active connections' skills for the new client version, folder by folder; a folder it cannot write is reported and keeps its previous files. `rollback` does the same, and when the older client has no skill it removes the skill and writes the full rule instead. A deleted skill folder is not recreated.
- DeepSeek Harness also reads Codex's folder, `~/.agents/skills`, after its own `$DSH_HOME/skills`, and keeps the first skill of a name. When DeepSeek Harness gets no skill (unbound or `--no-skill`), `connect` writes a placeholder `agentrelay` skill in its own folder that tells it to follow its rule, so it never loads Codex's copy, which would send as `self` through the wrong connection.
- A rule written before the skill existed is replaced in place when you run `connect` again. A copy you pasted by hand outside the markers must be replaced by hand.

## Verify and migrate

1. Restart/reconnect the actual agent.
2. For a device-bound connection, confirm the agent lists the `agentrelay` skill (`/agentrelay` in Claude Code, `/skills` in Codex, the Customizations menu in Antigravity).
3. Confirm `create_handoff`, `list_handoffs`, `get_handoff`, `claim_handoff`, `complete_handoff` are available.
4. Make a read-only `list_handoffs` call filtered by this device and `status: "ready"`. An empty list is a valid result.
5. Use `node <stable-launcher> verify --connection <id>` to check the resolved connection, device and workspace and all five tools; it prints a short report (`--json` for the full result). This verifies the local client's credentials, not an online agent session. Its skill line (the `skill` field in JSON) compares the installed skill with what the Site says now: `installed`, `missing`, `stale` or `outdated` (rendered by another client version), each but the first with the command that fixes it in `fix`, `opted-out`, `not-bound`, or `inactive` (another connection of the same agent is the active one, named in `activeConnection`).

The web wizard polls authentication metadata every 5 seconds for up to 3 minutes while visible, with manual Refresh afterwards. Authentication time is throttled to at most one write per minute per token. Old connections show no authentication record until used. A valid token is not evidence that an agent is connected.

Migrate one agent at a time: issue a new connection, configure and verify it, then explicitly revoke its old token. Keep old credentials until the replacement passes. Moving a connection to another device in the web UI takes effect on the agent's next call when it addresses its device as `self`, which is what `connect` writes into its instructions. Instructions that name a device id keep using that id until you edit them.

The handoff rule that `connect` writes changes when the protocol gains a step (most recently: sending `branch` and `baseCommit` and checking them before claiming). Run `connect` again, or edit a hand-written copy, to pick it up; older rules keep working without the new step. The skill follows the client instead: `install` re-renders it with each update.

## Remove access

Revoke an individual connection immediately in Agents. Revocation works for finite and permanent tokens. Revoked/expired connections can then be removed permanently; active permanent connections cannot be removed by inactive cleanup.

For shared workspaces, removing a viewer in Sites Sharing and revoking tokens are separate actions. Group the connection list by **Member** and use **Revoke all** on an issuer's group header: it previews that issuer's whole active set (including permanent ones, and including rows hidden by filters). Confirmation submits exactly the displayed ids. A changed set returns 409 and requires a refreshed preview. Issuers with the same display name remain separate; platform user ids are never shown. Every trusted member has equal management rights.

## Extend, rotate and set up again

Each row's **⋯** menu has three more actions:

- **Extend lifetime** sets a new lifetime of 30, 90 or 365 days counted from today, or permanent (with the same risk acknowledgement as creating one). It replaces the current expiry and does not change the secret. Only connections that are still usable can be changed.
- **Rotate secret** replaces the secret. The old one stops working immediately, so any agent using it loses access until it is set up again with the new secret; handoffs and settings are untouched. The new secret and its setup command are shown once, and the connection shows as pending setup until it authenticates. Only the member who issued a connection can rotate it, because the new secret acts as that member; anyone else creates a connection of their own.
- **Show setup command** prints the `connect` command again for the chosen agent. It names the connection and carries no secret: the local client asks for the secret, which is never shown again. If it is lost, rotate.

## Revoke several at once

Tick rows and choose **Revoke selected** to revoke exactly those connections in one request. If any of them was revoked, expired or removed in the meantime, nothing is revoked and the list reloads. A member's group header offers **Remove access** for another member, a guided dialog with three steps: remove them in Sites Sharing, revoke their whole active set here, and rotate the gateway token if they had it: ask Codex to rotate it with `generate_siwc_bypass_token`, then save the new token on each remaining device. Only the second step happens in AgentRelay, and the first and third can't be checked from here. The revoke is refused if the member gains or loses a connection while the dialog is open.

## Reading the list

Each connection shows a status that describes use of its secret, never whether an agent is online: **Pending setup** (never used, created within 24 hours), **Unused** (never used after 24 hours), **Active** (used within 30 days) and **Idle** (last used more than 30 days ago). Last use and near-term expiry read relative to now ("3 minutes ago", "in 12 days"); hover the last-use line for the exact time. A badge names the agent the connection was made for (chosen in the wizard; connections made earlier have none and are grouped under "Other or unknown"), and "Reports as" shows the name and version the agent sent when it last started an MCP session. That report is what the agent says about itself, so treat it as a hint, never as proof of what is on the other end; it is cleared when the secret is rotated. A banner suggests connections to review: never used, unused for 60+ days, or expiring within 14 days. Reviewing only filters the list. With more than three active connections the list offers search, an issuer/device/status filter and a Member/Device grouping; the grouping (Member, Device or Agent) defaults to Member once more than one member has issued connections and is remembered per browser. ChatGPT and Codex plugin connections use the Sites sign-in, not tokens, so they are not listed.

## Conflicts and history

Every change to a connection is checked against the version the page last loaded. If another member changed or revoked the same connection first, the request is refused with a conflict, nothing is overwritten, and the list reloads. Revoked rows show who revoked them and why (revoked manually, revoked with all of a member's connections, or its device was deleted); rows revoked before this was recorded show only the date.

**Activity** (next to Refresh) lists, newest first, who created, renamed, moved, revoked and removed connections. Entries store display names, never platform ids, and keep a connection's name as it was, so they stay readable after the connection is removed. The latest 2,000 entries per workspace are kept, and an entry from the last 30 days is never dropped. It is a safety net for a team of equals, not an audit log: it records changes made through this page and API, not what an agent did with a credential.

## Recovery

- 401/403: confirm the Site URL and the gateway token (`gateway --stdin` checks it against the Site), then check token expiry/revocation. Reconnect the agent after updating credentials.
- Credential-store error: unlock the store; on Linux provide a Secret Service session. Choose environment storage explicitly only if desired.
- Config conflict: review the unmanaged AgentRelay entry. Preserve unrelated servers/settings, remove the conflicting entry and retry.
- Failed setup: the client restores its config and credential writes. If storage itself fails during recovery, follow the reported manual recovery instructions; do not claim the agent is connected.
- Lost one-time token: revoke that connection and create another; there is no recovery endpoint.

Live fresh-account acceptance on 2026-10-31–2026-11-01 verified first private deployment and a Windows Codex token connection through the local bridge: OS credential storage, managed skill installation and an Agent read-only inbox call passed. A second physical Windows device used the Site plugin to read, claim, complete and reply to a synthetic handoff; both devices made read-only calls after redeployment of the same saved version. These checks used source from before the framework and toolchain upgrade; the upgraded build has not been deployed or retested on physical devices. The token device was a reset existing user with retained client binaries and OS credentials, so a pristine-user install is not established. The macOS plugin run paused after sign-in and device selection. R2 object persistence, direct header-helper invocation and macOS/Linux local token-client acceptance remain open. See [first deployment, Known limits](first-deployment.md#known-limits) for the scope and remaining checks.
