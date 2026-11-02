# First Deployment

This guide takes a fresh clone of AgentRelay to a live Site in your own ChatGPT account, and to your first handoff between two devices. The deployment workflow is intended to update the same Site and apply only pending database migrations; review the verification limits below before upgrading.

In the flow this guide supports, Codex with the Sites tools and access to your Site does every Sites step: deploying, and reading the Site's gateway token. Other devices need no Codex. The guide follows the workflow documented by the Sites skill. Earlier live acceptance covered a first private deployment, a Windows token-to-plugin handoff and redeployment of the same saved version. That acceptance predates the framework and toolchain upgrade. The upgraded build has since been deployed once as a new private Site, where only browser notifications were checked; the handoff and agent flows have not been rerun on it. The remaining limits are listed below.

## What you need

- A ChatGPT account eligible for Sites in your region and workspace, used through Codex with the Sites plugin. Check current [availability, limits and pricing](https://learn.chatgpt.com/docs/sites); a subscription alone does not guarantee access. The standalone Codex CLI and IDE extension do not provide a Sites management view; see [Create a site](https://learn.chatgpt.com/docs/sites/creating-a-site).
- Git, and Node.js `>=22.13.0` on the machine where you run Codex and on each device whose agent you connect with a token. The Site's ChatGPT/Codex plugin needs neither.
- The local token client supports one Site per operating-system user. If that user already connects to another Site, use a separate OS user or machine for this setup. Switching ChatGPT accounts leaves the local MCP configuration, rules, skills and credentials in place.
- No database setup: the Site gets its own D1 database, and its migrations are applied for you.

## 1. Clone

```bash
git clone <repository-url> agentrelay
cd agentrelay
```

The public template must have no `project_id` in `.openai/hosting.json`. It declares D1 `DB`, R2 `BUCKET` and MCP. The first deployment commits your Site's returned `project_id` there, so deploy from a checkout whose remote is private (a private copy, not a public fork). A checkout that already has an id targets that Site and must never create a replacement.

## 2. Deploy

Open the checkout in Codex with the Sites plugin enabled and paste this request:

```text
Deploy this repository to my AgentRelay Site in my own ChatGPT account, using the Sites skill's workflow. First check .openai/hosting.json: it decides whether this creates a Site or updates one.

Rules for this repository:
- Committing project_id here and pushing it to the private Sites source repository is authorized only if this repository is private. If its remote is a public repository, stop and tell me before committing anything. Remove any skip-worktree flag from .openai/hosting.json. Never commit tokens or credentials.
- If .openai/hosting.json has no project_id, this is a first deployment: create a new private Site, save its returned project_id into .openai/hosting.json and commit it for the Sites workflow. Keep the existing bindings (d1 "DB", r2 "BUCKET", capabilities ["mcp"]).
- If a project_id is already there, update that Site and confirm it with get_site before building. Never create a replacement, even if the request seems to ask for a new Site.
- Do not change the Site's audience.
- Do not apply database migrations by hand and do not edit or regenerate files in drizzle/. Sites applies the pending migrations before it uploads the Worker.
- Install dependencies with the Sites installer, run `npm run typecheck` and `npm run test:unit`, then build, package and publish through the Sites workflow.
- When it succeeds, tell me the live URL and whether the deployment reported any migration problem. Never print or store a token.
```

The request names no tools on purpose: the Sites plugin decides how to create, package and publish, so it keeps working when the plugin updates.

A new Site starts private. The owner and applicable workspace administrators may have access before anyone else is invited; review the Site's [sharing settings](https://learn.chatgpt.com/docs/sites/publishing-and-sharing) and workspace policies rather than assuming only the owner can enter. Because it declares the `mcp` capability, publishing also creates the Site's private ChatGPT/Codex plugin.

## 3. Connect this device

Open your live Site and sign in. Until two devices have handed work to each other, the empty inbox shows a setup checklist; it ends there on its own. If you hide it, **Settings › General › Workspace** brings it back.

1. **Choose this device.** The checklist asks which device this browser is. Pick one of the suggestions or add your own name. Each browser asks once.
2. **Connect an agent.** **Connect an agent** opens the wizard in **Agents** with this device selected. Choose the agent:
   - **Claude Code, Codex, Antigravity or DeepSeek Harness** with a token: leave the default 90 days (or explicitly acknowledge Permanent) and create the connection. On this device, in the AgentRelay folder, run the command the wizard shows. It needs no `npm install`. Paste the Agent Token when it asks. The first connection on a device also needs the Site's gateway token: the wizard puts saving it before the command (next section).
   - **ChatGPT or Codex (this Site's plugin)**: no token, repository or Node.js. Install the plugin (**Plugins → Personal → Created by you**), give it this device's id (a rule for Codex, a first message for ChatGPT, both shown in the wizard), then confirm. The page cannot see plugin connections, so the checklist records your confirmation as yours.
3. Restart or reconnect the agent and ask it: "Any handoffs for me?" It should list this device's ready handoffs, which may be none, and claim nothing.

[Agent connections](agent-connections.md) covers storage, supported versions and recovery.

### The gateway token

A private Site only lets requests through its Sites sign-in gate when they carry the Site's gateway token (Sites calls it `siwc_bypass_bearer_token`). It carries no identity and grants nothing inside AgentRelay without an Agent Token. It is one token per Site, saved once per device and reused by every agent there. It has no documented fixed lifetime; after it is rotated, save it again on every device.

On a device with Codex, paste this into Codex in your AgentRelay checkout:

```text
Read the siwc_bypass_bearer_token of my AgentRelay Site (https://<your-site>) with get_site. Use the project_id in .openai/hosting.json of my AgentRelay checkout, or find the Site by its URL.
In that checkout, pass the token on stdin to: node scripts/agents/agentrelay.mjs gateway --url https://<your-site> --stdin
Never print the token or write it to a file or the repository; retain it in session memory only long enough to pass it on stdin. Never call generate_siwc_bypass_token: that rotates the token for every device.
```

`gateway --stdin` checks that the Site lets the token through before saving it. Then `connect` no longer asks for it on that device.

For a device without Codex, run this on a device that has the token, save the clipboard in your password manager, and paste it when `connect` asks:

```bash
node scripts/agents/agentrelay.mjs gateway --url https://<your-site> --copy
```

It never prints the token; the clipboard tool reads it on stdin. Clipboard history or cross-device sync may still keep a copy.

## 4. Connect the next device

For a token connection, first get a copy of this repository on that machine (`git clone`; no `npm install`): the setup command runs from it. Then open the Site there (the checklist's **Copy link** gives you the URL) and do step 3: choose that device, then connect its agent. A device without Codex takes the gateway token from your password manager. The plugin needs neither.

## 5. Hand off

On the first device, tell the agent: "Hand this off to Desktop" (your other device's name). On the other device, ask: "Any handoffs for me?", read it, and let the agent claim it once you agree. The checklist closes when it sees a handoff claimed on a device other than its sender.

Keep this first run synthetic; do not publish private prompts or credentials. Local two-browser checks do not substitute for a run on two physical devices.

## Optional next steps

- **Browser notifications.** Already available, with nothing to configure: to get a system notification when a handoff arrives, even with no AgentRelay tab open (desktop Chrome or Edge), choose **Turn on notifications** in the setup checklist or **Settings › Notifications › Turn on** in each browser. The Site makes its own push keys and keeps them in its database; to keep the private key out of the database instead, set your own pair as runtime values. The [notifications guide](notifications.md#push-keys) explains both.
- **Sharing.** Add trusted accounts in the Site's Sharing settings, then use **Settings › General › Workspace › Share this workspace** for the request to give Codex. See [Shared Workspace](../reference/shared-workspace.md). Sites Sharing and Agent Token revocation are independent; see [Agent connections](agent-connections.md#remove-access).
- **Images.** See [image handoffs](image-handoffs.md).

## Updating later

Pull the repository and paste the same deployment request again. Codex targets the Site recorded in your local `.openai/hosting.json`, with the aim of preserving existing data and applying only pending migrations. Check the deployment result and the records you rely on afterward. On each device, run `node scripts/agents/agentrelay.mjs install` from the updated checkout to move the local client to the new version.

## If a deployment fails

A failed deployment can still have applied some migrations. Do not edit or delete files in `drizzle/`: applied migrations are immutable. Ask Codex to look at the deployment status, repair the migration that failed and was not applied, and publish again.

## Known limits

- Live acceptance on 2026-10-31 verified first private deployment from sanitized source with a fresh eligible account, browser sign-in, device registration and a Windows Codex token connection through the local bridge. Gateway retrieval and OS credential storage, client bootstrap from a checkout without dependencies, managed skill installation and a read-only inbox call in the restarted Codex session passed. The empty inbox returned no handoffs; no handoff was claimed.
- The Windows test used an existing OS user after its previous local Site registrations were explicitly removed. Client binaries and OS credentials were retained, so this does not establish installation in a pristine OS user. Use a separate OS user for a second Site rather than assuming switching ChatGPT accounts isolates local configuration.
- On 2026-11-01, a synthetic handoff crossed two physical Windows devices: Codex sent through its token connection, and Codex on the other device used the Site plugin to read, claim, complete and reply. The sender read the receipt and reply thread, and the owner observed the setup checklist disappear without dismissing it. The original handoff arrived unchanged. Receipt and reply formatting differed from their previews; the owner attributed the differences to manual transmission, but the receiver's original tool arguments were not independently captured.
- Redeploying the same saved version preserved both synthetic handoffs, their stored text and receipt, and the recorded device and connection metadata across the two workspace keys observed in the test database. Both devices performed read-only Agent calls afterward. No R2 objects were exercised, so object persistence was not established.
- Access denial to an already shared, previously connected Site was not established: its existing sharing settings allowed the test account to enter. An owner-observed Inbox and Done search found no synthetic test records there. This is not an exhaustive database check, and that prior Site's address was not independently matched to the original checkout's Site identity.
- On a second physical macOS device, sign-in and device selection passed before testing paused. Plugin installation, device-rule setup and actual Mac tool calls remain unverified. No specific Mac fault was reported.
- First deployment reported no migration error, and read-only inspection found the expected application tables and receipt/thread/Git-context columns. Individual migration ledger entries and index definitions were not exposed for inspection; their exact state is not independently verified. No manual migration was run.
- On 2026-11-02 a first deployment of the upgraded build to a new private Site with an empty runtime environment reported no migration problem. On Windows, Chrome and Edge turned notifications on with the push keys the Worker generated, and a cross-device handoff produced a notification with every AgentRelay tab closed (owner-observed). Agent connections, claims and redeployment were not repeated on that build, and upgrading a Site that already holds data from an earlier build has no hosted verification.
- Claude Code, Codex, Antigravity and DeepSeek Harness have configuration adapters. The live Windows evidence above covers Codex's bridge path only. Direct header-helper invocation, the other agents' fresh-account paths and macOS/Linux local token-client acceptance remain open.
- Sharing the Site's plugin with other members is documented for Business and Enterprise workspaces; sharing between personal accounts is not promised.
