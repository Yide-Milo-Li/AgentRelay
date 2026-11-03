# Deploy to Cloudflare

This guide deploys AgentRelay to a Cloudflare account you control, without ChatGPT Sites. Browser users sign in with Google through Cloudflare Access, token agents connect with an Agent Token alone, and native MCP clients connect through OAuth. One deployment is one workspace, as one Site is: everyone the Access policy admits shares its handoffs, devices and connections.

Not sure this is the right option? [Choose where to run it](../../README.md#1-choose-where-to-run-it) compares it with [deploying to ChatGPT Sites](first-deployment.md).

> **Status (in development).** This guide was followed from a fresh clone into a test deployment on Workers Free. Browser sign-in for members, token agents, native Claude Code and Codex, ChatGPT's and claude.ai's connectors, images, notifications and token revocation all worked. The two Access applications were created through the API with the settings in step 5, not through the dashboard screens described here. Connecting token agents without a gateway token needs AgentRelay client 0.7.0 or later.

## What you need

- A Cloudflare account. **Workers Paid** ($5 a month) is recommended for daily use; the Free plan works for trying AgentRelay out (see [Plans and limits](#plans-and-limits)).
- A Google account for each person who will sign in, and a Google Cloud project where you can create an OAuth client.
- Git and Node.js `>=22.13.0`.
- About 30 minutes. Most of it is dashboard setup done once.

## 1. Clone and sign in to Wrangler

```bash
git clone <repository-url> agentrelay
```

```bash
cd agentrelay
```

```bash
npm ci
```

```bash
npx wrangler login
```

The deploy command uses the Wrangler version pinned in this repository. Sign in with the Cloudflare account that will own the deployment. Never put an API token into the deployment config.

## 2. Create the database and the image bucket

```bash
npx wrangler d1 create agentrelay
```

Note the `database_id` it prints. `npx wrangler d1 info agentrelay` shows it again later.

R2 must be turned on once per account in the dashboard (**Storage & databases › R2**). Cloudflare may ask for a payment method even when you stay inside the free allowance. Then create the bucket:

```bash
npx wrangler r2 bucket create agentrelay-images
```

If your account has never used `workers.dev`, choose its subdomain in **Workers & Pages** first. Your deployment will live at `https://<worker name>.<subdomain>.workers.dev`.

## 3. Write the deployment config

```bash
npm run deploy:cloudflare -- --init
```

This writes `.local/cloudflare-deployment.json`, which Git ignores. Fill in the database ID:

| Field | Meaning |
| --- | --- |
| `workerName` | The Worker's name and the first part of its `workers.dev` hostname. Default `agentrelay`. |
| `plan` | `"free"` or `"paid"`, your Workers plan. Settings › Storage measures the database against 500 MB or 10 GB accordingly. |
| `d1.name`, `d1.id` | The database from step 2. |
| `r2.bucket` | The bucket from step 2. |
| `access.teamDomain`, `access.aud` | Leave empty for now; step 6 fills them in. |
| `workspaceKey` | Generated for you. It is the key every member's data is stored under. |
| `accountId` | Optional. Set it when your Cloudflare login has more than one account. |
| `customDomain` | Optional; see [Custom domain](#custom-domain). |
| `webPush` | Optional. `false` switches browser notifications off. |

**Keep this file, and back it up.** A deployment with a different `workspaceKey` starts with an empty workspace, although the old data is still in the database. The file holds no secrets: the IDs in it grant nothing without your Cloudflare login.

## 4. Deploy for the first time

Check everything without uploading:

```bash
npm run deploy:cloudflare -- --dry-run
```

The dry run builds AgentRelay for Cloudflare, writes the deployment's names, IDs and runtime values into `dist/server/wrangler.json`, stops if anything from the Sites build is left in it, and lets Wrangler check the result. It changes nothing in your account. Then deploy:

```bash
npm run deploy:cloudflare
```

This builds again, applies the database migrations to your remote database, and uploads the Worker. The deployment refuses every visitor for now: without Access settings each page shows **Access settings missing**, and the API answers 503. That is intended. The Worker never trusts a request that Access has not signed.

## 5. Set up Cloudflare Access

Dashboard names below are as of November 2026.

### Zero Trust organization

Open **Zero Trust** in the dashboard once and choose a team name. Your team domain is `https://<team>.cloudflareaccess.com`. The Zero Trust Free plan covers up to 50 users.

### Google sign-in

1. In Google Cloud Console, create an OAuth client of type **Web application**. Add `https://<team>.cloudflareaccess.com` as an authorized JavaScript origin and `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` as an authorized redirect URI. Google shows the client secret only once, so save it in a password manager.
2. Under **Audience**, either add yourself and every member as a test user or publish the app. While the app is in **Testing**, Google lets only its listed test users sign in. Access asks only for the email address and basic profile, which need no Google review.
3. In Zero Trust, add **Google** as an identity provider (**Integrations › Identity providers**) with the client ID and secret, then use **Test**.

Google is the only sign-in method this guide uses. You can remove One-time PIN once Google works.

### The application in front of AgentRelay

In **Zero Trust › Access controls › Applications**, create a **Self-hosted** application:

- **Domain**: your Worker's hostname, `<worker name>.<subdomain>.workers.dev`, with no path.
- **Policy**: action **Allow**, include **Emails**: your own address and each member's. Who is listed here is who shares the workspace; AgentRelay keeps no member list of its own.
- **Login methods**: Google only.
- **Advanced settings › Managed OAuth**: on. This lets native MCP clients sign in. Set:
  - **Allowed redirect URIs**: `https://chatgpt.com/connector/oauth/*`, `https://chatgpt.com/connector_platform_oauth_redirect` and, for claude.ai, `https://claude.ai/api/mcp/auth_callback`;
  - **Allow localhost clients** and **Allow loopback clients**: on, for Claude Code and Codex;
  - **Access token lifetime** `15m` and **Grant session duration** `336h`.

  Changes to the redirect URIs take about 30 seconds to apply.

Open the application's overview and copy its **Application Audience (AUD) Tag**.

Do not also protect the Worker from its own **Access** tab with a different policy. The application above is the one whose AUD tag AgentRelay checks.

### Let token agents through

Create a second **Self-hosted** application for the same hostname with the path `api/agent/`, and give it one policy: action **Bypass**, include **Everyone**. A path application applies before the hostname one, so agents reach AgentRelay without a browser sign-in. Every request on that path must carry a personal Agent Token, which is hashed, expiring and revocable; without one AgentRelay answers 401.

## 6. Add the Access settings and deploy again

Put the team domain and the AUD tag into the config:

```json
"access": {
  "teamDomain": "https://<team>.cloudflareaccess.com",
  "aud": ["<AUD tag>"]
}
```

```bash
npm run deploy:cloudflare
```

Open `https://<worker name>.<subdomain>.workers.dev`. Access asks you to sign in with Google, and then you see the inbox. A Google account that the policy does not list is refused by Access before AgentRelay runs.

## 7. Connect this device

Open your deployment and sign in. Until two devices have handed work to each other, the empty inbox shows a setup checklist; it ends there on its own. If you hide it, **Settings › General › Workspace** brings it back.

1. **Choose this device.** The checklist asks which device this browser is. Pick one of the suggestions or add your own name. Each browser asks once.
2. **Connect an agent.** **Connect an agent** opens the wizard in **Agents** with this device selected. Choose how the agent connects:
   - **With a token** (Claude Code, Codex, Antigravity or DeepSeek Harness): leave the default 90 days (or explicitly acknowledge Permanent) and create the connection. On this device, in the AgentRelay folder, run the command the wizard shows. It needs no `npm install`. Paste the Agent Token when it asks. The agent connects at `/api/agent/mcp` with the Agent Token alone: unlike on ChatGPT Sites there is no gateway token, and `connect` (client 0.7.0 or later) does not ask for one.
   - **Claude Code, Codex or ChatGPT, signed in with Google**: no token, repository or Node.js. claude.ai connects the same way. See [Native MCP clients](#native-mcp-clients) below.
3. Restart or reconnect the agent and ask it: "Any handoffs for me?" It should list this device's ready handoffs, which may be none, and claim nothing.

[Agent connections](agent-connections.md) covers storage, supported versions and recovery for token connections.

### Native MCP clients

A native client connects to `https://<worker name>.<subdomain>.workers.dev/mcp` with no token and no local client. The first time, it opens a browser and signs in through Access (Managed OAuth, step 5), so it acts as the person who signed in. The wizard shows these steps with your address filled in:

| Client | Add AgentRelay | Status |
| --- | --- | --- |
| Claude Code (CLI) | `claude mcp add --scope user --transport http agentrelay https://<host>/mcp`, then `/mcp` › Authenticate | Connected in a test deployment (CLI 2.1) |
| Codex CLI | `codex mcp add agentrelay --url https://<host>/mcp`, then `codex mcp login agentrelay` | Connected in a test deployment (0.166) |
| ChatGPT | In developer mode, create a connector with the URL and OAuth | Connected in a test deployment, with the redirect URIs from step 5 |
| claude.ai (web) | Add a custom connector with the URL, then **Connect** | Connected in a test deployment, with the redirect URI from step 5 |

Then tell the agent which device it runs on: the wizard gives a rule for Claude Code or Codex and a first message for ChatGPT. A native client has no `self`, and the page cannot see these connections, so the wizard asks you to confirm instead.

Limits: image upload and download commands need a token connection. A client that cannot complete the Access sign-in is not supported on a standalone deployment; connect it with an Agent Token at `/api/agent/mcp` instead, if it can send headers.

## 8. Connect the next device and hand off

For a token connection, first get a copy of this repository on that machine (`git clone`; no `npm install`): the setup command runs from it. Then open your deployment there (the checklist's **Copy link** gives you the URL), sign in and do step 7: choose that device, then connect its agent. A native client needs no copy of the repository.

On the first device, tell the agent: "Hand this off to Desktop" (your other device's name). On the other device, ask: "Any handoffs for me?", read it, and let the agent claim it once you agree. The checklist closes when it sees a handoff claimed on a device other than its sender.

Keep this first run synthetic; do not send private prompts or credentials.

## Members

To add a member, add their email address to the Allow policy. To remove one, take it out: they can no longer sign in, but Agent Tokens they already issued keep working until someone revokes them in **Agents**.

## Plans and limits

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Database size | 500 MB (5 GB per account) | 10 GB |
| Database queries | Daily read and write caps; queries fail until 00:00 UTC once one is reached | Billed per row |
| Images (R2) | 10 GB-month and the free operation allowance; billed above | Same |
| CPU per request | 10 ms | 30 s by default |

Page renders take more than Free's 10 ms of CPU, so a Free deployment can start failing with error 1102 once Cloudflare treats the overruns as consistent. Upgrade when you see 1102 errors, when Settings › Storage nears 500 MB, or when AgentRelay reports that the daily database limit was reached. After upgrading the account, set `"plan": "paid"` and deploy again so the storage figures use the new limit.

## Custom domain

With a domain on Cloudflare, set `"customDomain": "relay.example.com"` and deploy. The Worker is then served only there: `workers.dev` is switched off, so Access protects a single hostname. Create both Access applications for the custom hostname instead (the main one and the `api/agent/` bypass), put the new AUD tag into `access.aud` and deploy again. Native clients and token agents then use the custom hostname.

## Updating later

```bash
git pull
```

```bash
npm ci
```

```bash
npm run deploy:cloudflare
```

Pending migrations are applied before the upload; they only add to the schema, so the running Worker keeps working meanwhile. A failed migration leaves the database as it was and can be retried. Each deployment sets the Worker's runtime values from the config, and values added in the dashboard are replaced. Secrets you set with `wrangler secret put` are kept.

## Notifications

Browser notifications work without extra setup: the first browser that opens the notification settings makes the workspace's push keys, which are stored in your database. [Notifications](notifications.md) explains the trade-off and how to keep the private key in a secret instead.

## If something fails

- **Access settings missing on every page, API 503**: `access.teamDomain` or `access.aud` is missing or wrong in the deployed config. Fix it and deploy again.
- **"Sign in first." after a Google sign-in**: the AUD tag in the config is not the main application's.
- **Wrangler asks you to sign in or reports an authentication error**: run `npx wrangler login` again.
- **503 "used today's database allowance"**: the Free plan's daily database cap was reached. Queries work again after 00:00 UTC, or upgrade.
- **507 "database is full"**: the database reached its size limit. Delete old handoffs in Settings › Storage, or upgrade.

## Known limits

- This guide has not yet been followed on a Cloudflare account that has never used Zero Trust or R2.
- The local client serves one deployment per operating-system user. On a device still connected to a ChatGPT Site, `connect` refuses the new deployment ("This client currently supports one Site") and names the old Site. Remove its connections with `node scripts/agents/agentrelay.mjs disconnect --url <old-site>` (client 0.8.0 or later; it works offline, so the old Site may already be deleted), then connect again. To keep both, use another OS user.
- Sign-in uses Google through Access only; AgentRelay has no sign-in of its own.
- Expired handoffs and connection reminders are processed while the workspace is in use, as on Sites; there is no scheduled job.
