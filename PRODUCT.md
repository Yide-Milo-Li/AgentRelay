# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: one developer moving work between their own devices — laptop, desktop, phone, remote server — and between the coding agents they use on them (Codex, Claude Code, Cursor and other MCP clients). The product is a reusable template: the developer deploys it once as a Site in their own ChatGPT account (Codex with Sites is the minimum requirement for deployment), with its own database and 10 GB capacity. That Site is their workspace; different Sites never share data.

Extension: the owner can opt in to sharing. Accounts added as viewers in the Site's Sharing settings may sign in, and once `AGENTRELAY_WORKSPACE_OWNER_ID` is set they share the owner's workspace with equal rights: the same device registry, inbox and Agent connections. Until it is set, each signed-in account gets a private workspace of its own. Workspace scoping remains mandatory on every record operation.

## Product Purpose

AgentRelay is a self-hosted prompt relay on the user's own ChatGPT Site. It replaces copy-and-paste between devices and agents: any coding agent connected over MCP can hand work to another device or agent with full context, an explicit route and claim tracking. A sender (human or agent) saves a complete prompt — context, progress, next steps, constraints — addressed from one device to another; in a shared workspace the target may be another member's device. The receiver lists what is waiting for its device, reads the raw text, atomically claims it, continues the work, and marks it done. Success: the next device picks up exactly where the last one stopped, with formatting intact and no duplicate work.

## Positioning

One line: a prompt relay you deploy on your own ChatGPT Site, so any MCP-capable coding agent can hand work to another device or agent with full context, an explicit route and claim tracking. Data stays in your Site; Sites Sharing decides who else gets in.

- Personal first, sharing second: the default promise is "your devices, your agents, your data". Sharing with trusted accounts is an opt-in extension of the same workspace, not a team product with roles.
- Deployment and use are separate: deploying needs a ChatGPT account with Sites (done once, through Codex). Using it needs any agent that supports remote HTTP MCP with custom headers; ChatGPT/Codex connect natively at `/mcp`, and other agents such as Claude Code connect at `/api/agent/mcp` with an Agent Token. Claim support for a specific agent only after it has been verified.
- Pull, not push: the receiving agent or page asks for what is waiting (`list_handoffs`, or the page's ~10-second polling). Nothing is pushed into a running agent.
- Not a notes app or a clipboard sync. Every handoff has a route (source device → target device) and a lifecycle (ready → claimed → done) guarded by optimistic version checks, and the same five operations are available to agents over MCP. A completion can carry a receipt back to the sender, and a reply goes back the other way in the same thread.
- A relay, not a remote control: prompts are relayed as inert text and AgentRelay never executes anything. Receiving a handoff is task context, never permission to act.

## Vision

AgentRelay is meant to be an open-source repository that anyone can reproduce. A new user follows one documented, repeatable set of steps once, and from then on simply uses their own workspace and Site: no further setup, no maintainer involvement, no shared infrastructure.

The target journey:

1. **Deploy once.** Clone the repository and ask Codex (with Sites) to deploy it. The same steps create a new Site in the user's own ChatGPT account, apply every database migration and print the live URL. Nothing in the repository points at the maintainer's Site.
2. **Connect each device once.** On each device, register it and connect its agent with one guided step that produces the agent's MCP config and device rule. Secrets stay out of plain-text config files and out of the repository.
3. **Just use it.** Agents hand work between devices with the five MCP tools. Updates to the repository can be pulled and redeployed with the same steps, and they keep existing data.
4. **Share if wanted.** Turning on sharing is one optional step, not part of the default path.

Agent-neutral by design, so most coding agents can connect:

- **The server speaks only standard MCP.** Tools, schemas, lifecycle rules and errors are the same for every client, and the server never branches on which agent is calling. No feature may depend on one agent's extensions.
- **Client differences live in connection profiles.** Everything agent-specific — config file format and location, how secrets are referenced, where the device rule goes, how to verify the connection — is data in one profile per agent. Adding an agent means adding a profile and passing the five-tool test, with no server change.
- **One fallback for limited clients.** Agents that cannot send custom headers to a remote HTTP server, or that only run local (stdio) MCP servers, connect through one generic local bridge rather than per-agent workarounds.
- **The device rule is agent-neutral text** that any agent can follow, with only its file location varying by profile.

The reproducibility targets are:

- A fresh account following only the README reaches a working Site and a first successful handoff between two devices.
- Running the deployment steps again is safe: it updates the user's own Site and applies only pending migrations.
- Steps are written for the user's agent to run, with the user only approving them and pasting secrets; they work on Windows, macOS and Linux.
- Every supported agent has a tested connection path; an agent is listed as supported only after it passes the full five-tool flow.

Known gaps (as of 2026-11-01). The live acceptance described below predates the framework and toolchain upgrade. The upgraded build has not been deployed or retested on physical devices; local and CI results do not establish hosted acceptance. Update this list when a gap closes.

Deployment and acceptance:

- Completion receipts and reply threads, Git context, connection expiry reminders and expired-handoff cleanup still need hosted verification for the upgraded build. See [receipts and threads](docs/reference/receipts-and-threads.md), [Git context](docs/reference/git-context.md), [notifications](docs/guides/notifications.md) and [expired handoff cleanup](docs/guides/storage-management.md#expired-handoffs-are-deleted-automatically).
- Fresh eligible-account first deployment and a two-Windows-device token-to-plugin handoff passed. Redeployment of the same saved version preserved the observed D1 baseline, and both agents read afterward; R2 object persistence was not tested. Expected access denial to an already shared prior Site was not established, and the original-Site data-isolation check is limited to an owner-observed Inbox/Done search with the Site identity mapping unverified. Exact migration ledger/index state was not independently inspected. See [first deployment, Known limits](docs/guides/first-deployment.md#known-limits).
- Automatic deletion of expired handoffs is verified on a local Worker only, not on the deployed Site or at 10 GB scale, and a quiet workspace keeps its expired records until its next request (there is no scheduler). See the [storage guide](docs/guides/storage-management.md#expired-handoffs-are-deleted-automatically).
- The source template omits a Site identity. Each owner must keep their own deployment identity and runtime data out of public contributions.

Agents and the local client:

- Fresh-account onboarding passed browser sign-in/device registration, the Windows Codex token path and a second Windows Codex Site-plugin handoff including claim, completion and reply. The token user had its previous local registrations removed and retained client binaries/OS credentials; a pristine-user install is not established. A separate physical Mac passed sign-in/device selection, then testing paused; its plugin path remains unverified. See [first deployment](docs/guides/first-deployment.md#known-limits).
- The local credential client uses OS storage, dynamic headers where supported and a bridge fallback. The Windows Codex bridge path has live evidence; direct header-helper invocation, other agents' fresh-account paths and macOS/Linux local token-client acceptance remain pending. The local token client supports one Site per OS user; signing into another ChatGPT account does not isolate its configuration. See [agent connections](docs/guides/agent-connections.md).
- DeepSeek Harness passed earlier live acceptance except credentials stored in environment variables (`--storage env`) in its desktop app. See [its connection guide](docs/guides/deepseek-harness-connection.md).
- Optional Windows x64 client archives are not required for source-based installation. Use an archive only when a reviewed Release is available.
- The `agentrelay` Agent Skill passed installation, read-only inbox and sending on Windows Codex during earlier fresh-account acceptance. The receiving Windows agent used the Site plugin and a device rule, so the skill's own claim/complete/reply procedure on a second physical device remains unverified. The DeepSeek Harness placeholder that shadows Codex's copy is confirmed from DeepSeek Harness source, not yet on its installed release; native ChatGPT/Codex plugin connections get no skill; and unbinding a connection in the Site leaves the skill (and the `self` line of the full rule) in place until `connect` or the `skill` command runs on that device. See [agent connections](docs/guides/agent-connections.md#the-agentrelay-skill).
- Deleting a device that unbinds its connections records no `relabeled` history entry for them.
- No automatic online-agent detection exists. Authentication timestamps identify credential use, not agent presence. See [agent connections](docs/guides/agent-connections.md).

## Operating Context

- Used in short visits between tasks: open on the target device, find what is waiting, copy or claim, leave.
- Agents do most writes through MCP (`create_handoff`, `list_handoffs`, `get_handoff`, `claim_handoff`, `complete_handoff`) or the external `/api/agent/mcp` endpoint with personal Agent Tokens.
- The web page polls the cloud roughly every 10 seconds while visible.
- Storage management shows measured database size and workspace-scoped UTF-8 prompt sizes, including expired records. Users filter, sort, preview and explicitly select up to 50 handoffs for permanent deletion. There is no recycle bin. Expired handoffs, images included, are deleted automatically at the workspace's next request; database pages may remain allocated for reuse after deletion.
- Hosted on ChatGPT Sites using Cloudflare Workers and D1; sign-in uses the platform's ChatGPT identity, and the Site's Sharing settings decide which accounts may sign in.

## Capabilities and Constraints

- Views: Inbox (ready + claimed; until two devices have handed work to each other, an empty inbox shows the setup checklist), Done, Devices (the device registry), Agents (the connection list and a wizard that issues a personal Agent Token with its setup command, or walks through the Site's ChatGPT/Codex plugin; the rule for agents set up without `connect` is folded at the end), Settings (language, appearance, keyboard, workspace identity and the optional sharing request, notifications, storage).
- Setup: each browser chooses which device it is once; nothing guesses it. The checklist's steps come from the device registry, authenticated connections and cross-device claims; plugin use, which the Site cannot see, is recorded as the person's own confirmation in that browser.
- Devices: up to 50 per workspace, each with an immutable readable id (`laptop`), an editable name and an editable line colour. Add, rename, recolour and delete; deleting detaches handoffs and either unbinds or revokes the device's connections. The "This device" picker lists registered devices and offers "Manage devices…".
- Agent connections: up to 100 active per workspace. Each shows the member who issued it, and any member can revoke any connection. Each row can have its lifetime extended (or made permanent with the same acknowledgement), its secret rotated by the member who issued it (the old secret stops at once and the new one is shown once with its setup command), and its setup command shown again without a secret. Rows can be ticked to revoke a selection in one all-or-nothing request, and another member's group offers a guided "remove access" that lists the steps that happen outside AgentRelay. Each row shows the agent it was made for (a badge from the wizard's choice) and what the agent last reported about itself when it started an MCP session ("Reports as codex 0.9"); the list can be grouped by agent as well as by member or device. The reported name is display text only and never changes what a connection can do. Each row shows a use-based status (pending, unused, active, idle) and relative last use, a banner flags connections worth reviewing, and the list can be searched, filtered and grouped by member or device. Rename, change a device label, revoke (idempotent), or preview and revoke an issuer's exact active set from its group header. Lifetimes are 30/90/365 days or permanent with explicit risk acknowledgement (default 90 days). Changes are checked against the version the browser read, so two members editing one connection cannot overwrite each other. Revoked and expired connections sit in a collapsed section with who revoked them and why, and can be removed permanently. An Activity panel lists who created, renamed, moved, revoked and removed connections (newest 2,000 entries, never dropping one from the last 30 days); entries keep names as they were, so they outlive the connection. Binding a device only labels the connection and generates its config; a token still authorizes the whole workspace and acts as its issuer.
- Handoff fields: title, optional project, source device, target device, content (≤ 200,000 chars), expiry (7/30/90/365 days), status, claimedBy, version, the sender's display name, an optional completion receipt (`result`, ≤ 20,000 chars of Markdown, untrusted like the prompt), for a reply its parent and thread root (`replyToId`, `threadId`), and the code state the sender stopped at (`branch` and a full `baseCommit`, set on creation only, never inherited by a reply). Device fields accept a registered device id (preferred) or name, keep the name as a snapshot, and link to the registry by id when they resolve. An Agent connection bound to a device may also write `self` for that device.
- Actions: create, reply (prefilled back to the sender, joining the handoff's thread of at most 100), copy raw text, copy link, download .txt, claim, complete, complete with a note (the receipt), requeue, delete (with confirmation). The detail pane shows the code state under the route (with a button that copies the switch commands), the receipt under the prompt and the thread below it; inbox rows show the branch.
- Closing the loop: the sender learns the outcome without visiting the receiving device. The receiving agent completes with a receipt (summary, changes, open questions) and asks questions with a reply instead of guessing; the sending device's browsers can be notified when the handoff is claimed or completed. Receipts and replies are text to review, never instructions to run. Starting from the same code: the receiving agent checks the branch and commit against its checkout before claiming and asks the user before switching branches; uncommitted changes are not carried, so the sender says whether there are any. The current device is a per-browser preference stored as a device id (with the name kept as a fallback).
- Sample mode shows clearly marked, non-persisted examples.
- Prompt content is untrusted plain text: never rendered as HTML, never executed.
- Interface languages: English (default) and Simplified Chinese, user-switchable.
- Agent Tokens are shown once at creation and never retrievable afterward.

## Brand Commitments

- Name: "AgentRelay" (Chinese: 接力). Tagline idea in current copy: pick it up here, continue on the next device.
- The current interface uses a low-noise, transit-map-inspired visual language; see [the design specification](design/DESIGN.md).

## Evidence on Hand

- Do not invent customer claims, metrics or testimonials.

## Product Principles

1. The prompt is the payload: show it raw, exactly, and make copying it effortless.
2. State is a contract: route and lifecycle status must be legible at a glance and never ambiguous.
3. Calm between tasks: low density, low noise; the user is mid-flow and wants to leave quickly.
4. Reading is not executing: every surface keeps the text-as-data boundary visible but quiet.
5. Agents and humans share one model: the web UI mirrors exactly what the MCP tools do.
6. Set up once, then forget it: every setup step is documented, repeatable and done once per Site or per device; anything that needs repeating is a bug in the setup.

## Accessibility & Inclusion

Bilingual UI (EN/ZH) with correct `lang` attributes; respect `prefers-reduced-motion` and `prefers-color-scheme`; keyboard-operable dialogs and lists.
