# Local development and verification

How to set up a checkout, run the local Worker and database, and run the verification suites. For deploying your own Site, start with the [first deployment guide](first-deployment.md).

## Requirements

Requirements: Node.js `>=22.13.0`, npm, Git, and `tar` (or `tar.exe` on Windows).

Use the development and CI version in `.node-version` (Node.js **24.21.0**). The Windows tooling accepts 24.20+ on the 24.x line and 26.1+ and rejects older Windows runtimes before opening sockets; the upgraded toolchain has been verified on the pinned version. A Windows run on Node.js 26.13.0 used an earlier toolchain and does not establish compatibility with this one. Node 24.15.0 contains an upstream libuv TCP defect that can terminate a process with `0xC0000409`; the exact native stacks of the project's historical failures were not captured. Other platforms retain the existing minimum. See [Windows Node crashes](../operations/windows-node-crashes.md) for the evidence and verification procedure.

## 1. Setup & Environment

Run every command from the repository root. Keep the temporary directory and npm cache inside the checkout:

```bash
# macOS / Linux / Git Bash
export TEMP="$PWD/.sites-runtime/tmp" TMP="$PWD/.sites-runtime/tmp" npm_config_cache="$PWD/.sites-runtime/npm-cache"
mkdir -p "$TEMP" "$npm_config_cache"
```

```powershell
# Windows PowerShell
$env:TEMP = Join-Path (Get-Location).Path '.sites-runtime/tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path (Get-Location).Path '.sites-runtime/npm-cache'
New-Item -ItemType Directory -Force -Path $env:TEMP,$env:npm_config_cache | Out-Null
```

Then install dependencies with `npm run install:ci`.

If the Sites plugin is installed, its own scripts may be used instead: run `scripts/configure-execution-profile.mjs` once (skip it when `.sites-runtime/execution-profile.json` exists), then `scripts/install-dependencies.mjs`, both from the plugin's install directory. Locate that directory through your Codex installation; its path and version differ by operating system and plugin release, so do not copy a fixed one.

## 2. Initialize or Update Local D1

`.wrangler/state` houses local database state. Build the worker once (it emits `dist/server/wrangler.json`), then apply every pending migration from `drizzle/`:

```bash
npm run build
npm run db:migrate:local
```

The runner records applied migrations in a `_agentrelay_migrations` table, so running it again only applies new ones. A database that was migrated by hand earlier is recognised from its schema and is not replayed. `npm run db:migrate:local -- --status` lists pending migrations without applying them, and `--state-dir <path>` targets another local state directory.

| Migration | Adds |
| :--- | :--- |
| `0000_curious_nuke.sql` | `handoffs` |
| `0001_odd_steve_rogers.sql` | `agent_tokens` |
| `0002_public_mac_gargan.sql` | `devices`, the nullable `*_device_id` columns on `handoffs`, and `agent_tokens.device_id` |
| `0003_right_zzzax.sql` | Covering expression index for prompt-byte totals and storage sorting |
| `0004_broken_princess_powerful.sql` | Nullable `created_by_user_id` and `created_by_name` columns on `handoffs` and `agent_tokens`, recording which member created each record |
| `0005_image_attachments.sql` | `attachments`, `object_cleanup`, `attachment_bind_guard`, the `attachment_count` / `attachment_bytes` columns on `handoffs`, and the `handoffs_owner_logical` index for text-plus-image sizes |
| `0006_projects.sql` | `projects`, the nullable `project_id` column on `handoffs`, and the `handoffs_owner_project` index |
| `0007_magenta_mach_iv.sql` | Default-false `never_expires` and nullable `last_authenticated_at` on Agent connections; no table rebuild |
| `0008_web_push_subscriptions.sql` | Workspace-scoped browser notification subscriptions, delivery status and cascading device references |
| `0009_connection_history.sql` | `connection_events` with its two indexes, plus `version` (default 1) and nullable `revoked_by_name` / `revoked_reason` on `agent_tokens` |
| `0010_connection_rotation.sql` | Nullable `rotated_at` on Agent connections, set when a secret is replaced |
| `0011_connection_clients.sql` | Nullable `client_profile`, `last_client_name` and `last_client_version` on Agent connections |
| `0012_notification_preferences.sql` | Defaulted `notify_requeue`, `notify_any` and `show_details`, and nullable `label`, `created_by_user_id` and `created_by_name`, on browser notification subscriptions |
| `0013_connection_event_backfill.sql` | Data only: records the past device-deletion revocations in `connection_events` (under the ids the Activity feed used to synthesize), once |
| `0014_connection_expiry_reminders.sql` | Nullable `expiry_reminded_lead` on Agent connections, and `notify_expiry` (default `device`) on browser notification subscriptions |
| `0015_handoff_receipts.sql` | Nullable `result`, `reply_to_id` and `thread_id` on handoffs, the thread index, and `handoffs_owner_logical_v2`, which counts the receipt as text (the expression index statement is written by hand because drizzle-kit splits it at the comma inside `coalesce`) |
| `0016_progress_notifications.sql` | `notify_progress` (default `done`) on browser notification subscriptions: what a browser hears when a handoff sent from its device is claimed or completed |
| `0017_handoff_git_context.sql` | Nullable `git_branch` and `git_base_commit` on handoffs: the code state the sender stopped at, set only on creation |
| `0018_handoff_expiry_index.sql` | Index on owner, expiry and ID, read by the sweep that deletes expired handoffs |

This runner covers the local database only. On a Site, the Sites tooling applies the pending migrations before it uploads the Worker, so a deployment needs no manual database step (see the [first deployment guide](first-deployment.md)).

`0002`, `0005`, `0006`, `0007`, `0008`, `0009`, `0010`, `0011`, `0012` and `0014` only add tables, indexes, and nullable or defaulted columns, and `0013` only inserts missing history rows, so existing handoffs and tokens stay valid and the previous Worker version keeps working against the migrated database (it ignores the new tables; images that code deletes without releasing them are reclaimed by the next cleanup). It must be applied before code that reads the new columns runs: locally by `db:migrate:local`, on Sites by the deployment itself. When modifying `src/server/db/schema.ts`, run `npm run db:generate`, review the generated SQL in `drizzle/` (reject any table-rebuild statement), and apply pending migrations locally.

## 3. Local Dev Server

```bash
npm run dev
```

Default development server starts at `http://127.0.0.1:5173`. Sign in locally via `/signin-with-chatgpt?return_to=/` (mock identity `local_seedy`).

## 4. Type Checking & Integration Testing

```bash
node node_modules/typescript/bin/tsc --noEmit
npm run check:architecture
npm run test:unit
npm run build
```

The HTTP/D1 integration suites run against the **built Worker preview**. `verify-agentrelay.mjs` covers handoffs, MCP, device CRUD, id/name resolution and device deletion; `verify-agentrelay-agents.mjs` covers Agent Tokens, connection binding, Agent endpoint discovery, revocation, permanent removal and the list limits:

Terminal A:
```bash
npm run start -- --port 5178
```

Terminal B:
```bash
export AGENTRELAY_TEST_URL=http://127.0.0.1:5178
node scripts/verify-agentrelay.mjs
node scripts/verify-agentrelay-agents.mjs
```

```powershell
$env:AGENTRELAY_TEST_URL = 'http://127.0.0.1:5178'
node scripts/verify-agentrelay.mjs
node scripts/verify-agentrelay-agents.mjs
```

`npm run typecheck` is the named TypeScript entrypoint. `npm run test:integration` runs the HTTP/D1, Agent Token/MCP, storage, project, attachment, bridge, receipt and Git context suites against `AGENTRELAY_TEST_URL`; `npm run test:integration:receipts` runs the completion receipt and reply thread suite alone; `npm run test:integration:git-context` runs the Git context suite alone, and `npm run test:e2e:git-context` checks its display and copied commands in a real browser (EN/ZH, dark, 390 px); `npm run test:integration:projects` runs the project registry suite alone (auto-creation, name keys, races, legacy reconciliation, rename/merge/delete, owner isolation). Their implementations live in `tests/integration/`; the original script paths remain compatible. `npm run test:integration:attachments` runs the image suite (uploads, limits, binding races, MCP image blocks, expiry, deletion and cleanup, Storage accounting) against the local Worker and local R2, checking the stored bytes through the runner's R2 binding or the standalone `wrangler r2 object get --local` path. `npm run test:e2e:images` drives the composer, viewer and Storage in a real browser (EN/ZH, 390 px, dark). `tests/unit/attachments-service.test.mjs` runs the real services and migrations on `node:sqlite` with an injectable R2 double for deterministic failure and interleaving cases. `npm run test:integration:storage` runs the storage suite alone, and `npm run test:integration:bridge` runs the five-tool flow through the local stdio bridge. `npm run test:integration:workspace` checks the [shared workspace](../reference/shared-workspace.md) against a Worker started with `--var AGENTRELAY_WORKSPACE_OWNER_ID:<id>`; set `AGENTRELAY_TEST_WORKSPACE_OWNER` to the same id, and optionally `AGENTRELAY_TEST_PRIVATE_URL` to a second Worker without the variable. Architecture checks resolve aliases, relative paths, re-exports, type imports, and literal dynamic imports, reject dependency cycles and forbidden Node builtins, and trace client imports to prevent server/tooling dependencies.

With `agent-browser` installed, run `npm run test:e2e:keyboard` against the same built Worker (`AGENTRELAY_TEST_URL` is required when it is not on port 5188). It uses an isolated synthetic owner, removes its records afterward, and saves screenshots and results under `outputs/keyboard-shortcuts/`. See the [keyboard guide](keyboard-shortcuts.md#verification) for overrides.

`npm run test:integration:persistence` migrates a disposable local database, creates a synthetic handoff with an image, restarts the built Worker preview and verifies that D1 and R2 retain the text and original image bytes.

Run `npm run test:e2e:devices` the same way to drive the registry and the connection wizard in a real browser: add, rename, recolour and delete devices, pick the current device, migrate a stored v1 device name, run the wizard end to end, check the collapsed revoked section, and confirm that switching language renames nothing and that nothing overflows at 390 px. Screenshots and results go to `outputs/devices-connections/`.

For disposable local verification after `npm run build`, use:

```bash
npm run test:integration:local
npm run test:integration:local -- --acceptance
```

The local runner applies migrations to a disposable database under `.sites-runtime/test-state/`, uses `.sites-runtime/test-tmp/` for its temporary files, and writes run reports under `outputs/verification/<run-id>/`. It starts the built Worker in a direct Miniflare/workerd preview on an available loopback port, probes rejected requests and idle connections, then runs the actual `npm run test:integration` command. That command runs all eight suites in order (HTTP/D1, Agent Token/MCP, storage, projects, attachments, bridge, receipts, Git context), with a five-minute limit per suite. Existing single-suite commands and externally started previews remain supported.

`--acceptance` runs three full chains: a fresh Worker, the same still-running Worker and state, then a cold start with fresh state. It also runs shared-workspace checks using shared and private Workers on the same disposable database. `--probes-only` runs the rejection/idle probes alone; `--workspace` adds workspace checks to an ordinary single-round run. The runner never restarts a Worker between suites, never reruns a failed suite, and cleans up only its own process trees. It preserves the developer's `.wrangler/state` and existing previews.

Integration HTTP helpers make one attempt, with deadlines covering headers and body consumption (15 seconds for reads, 60 seconds for writes/uploads). Local fixture commands have a 60-second default deadline. Plain-text proxy errors are classified before JSON parsing; diagnostics omit credentials, prompt bodies, query parameters and record ids. A failed run retains its per-suite logs, process exits, effective toolchain versions and JSON report. Wrangler may perform its own internal GET/HEAD recovery; the reported zero retry count refers to the test layer.

The toolchain is pinned together because the Vite plugin also depends on Wrangler and Miniflare. The preview declares its existing Miniflare and esbuild versions directly and uses Wrangler's configuration conversion API to preserve bindings and assets. Earlier Wrangler versions could misclassify connection errors as Worker restarts and leave non-root GET requests waiting indefinitely; see upstream [#14593](https://github.com/cloudflare/workers-sdk/pull/14593) and [#15252](https://github.com/cloudflare/workers-sdk/pull/15252). Build and preview retain the explicit `2026-05-15` compatibility date when upgrading tools.

`npm run start` and the disposable runner use one Miniflare/workerd instance for the built Worker and its assets. This removes Wrangler's extra ProxyWorker-to-UserWorker HTTP connection, which can lose a POST at its five-second idle boundary ([upstream #14641](https://github.com/cloudflare/workers-sdk/issues/14641)). Both retain Wrangler's `state/v3` persistence layout. `npm run start -- --port 5178` retains its entrypoint; supported preview options are `--port`, `--ip`, `--config`, `--persist-to` and repeated `--var NAME:value`. Rebuild before previewing source changes; `npm run dev` remains the development server.

The disposable test runner seeds and inspects D1/R2 through that preview instance's bindings, avoiding a second workerd process opening the active SQLite files. Its test-only entrypoint starts a separate authenticated loopback control channel with a fresh in-memory credential passed through the child environment. Each fixture request executes once, with no retry or fallback after failure. The application and ordinary `npm run start` do not expose this channel. Offline migrations and standalone suites against a manually started preview retain their Wrangler CLI path.

A development-only local preview adapter retains a drainable stream branch across framework Request transfers. Vinext's generated config has `no_bundle: true`; its Request adapters can transfer the body before an early 401/413. The adapter discards the stream until it reaches the 2,600,000-byte threshold (including the final chunk) or a five-second deadline, preserving the application's response and valid upload bytes. The in-memory local bundle disables `keepNames` so serialized inline browser functions do not acquire unavailable `__name` helpers. These settings change neither the deployed build nor application rejection rules. `npm run test:integration:proxy` compares diagnostic Wrangler controls without and with ordinary middleware against the default preview's adapter, recording its instance marker, connection reuse, statuses and latencies. The adapter case must pass. See upstream [workerd #7634](https://github.com/cloudflare/workerd/issues/7634).

`npm run test:integration:transport` compares stock Wrangler with the default direct preview at a send-time-aligned 5,000 ms cadence. The control is diagnostic; every direct-preview write must succeed on its single attempt, keep its exact byte hash, execute exactly once and stay on one Worker instance. An intentional application HTTP 500 must still reach the caller exactly once. Evidence is saved under `outputs/verification/preview-transport-*/`. See [local preview transport](../operations/local-preview-transport.md) for the investigation and verification record.

Run `node tests/e2e/theme-preference.mjs` with `AGENTRELAY_TEST_URL` pointing to the built local Worker to verify appearance cycling, icons, persistence, system changes, cross-tab synchronization, keyboard activation, reduced motion, and responsive headers in both languages. Results and screenshots are saved under `outputs/theme/`; `AGENTRELAY_QA_OUTPUT` overrides that directory.

## Tech stack

| Layer | Technology | Details |
| :--- | :--- | :--- |
| **Fullstack Framework** | [Next.js 16](https://nextjs.org/) + [Vinext](https://github.com/cloudflare/vinext) | Next.js App Router syntax powered by Vite on Cloudflare edge runtime |
| **Frontend UI** | [React 19](https://react.dev/) + [Tailwind CSS v4](https://tailwindcss.com/) | Responsive design, shadcn/ui components, Lucide icons |
| **Database** | [Cloudflare D1](https://developers.cloudflare.com/d1/) | Serverless edge-distributed SQLite database |
| **Object storage** | [Cloudflare R2](https://developers.cloudflare.com/r2/) | Private bucket binding `BUCKET` for immutable image bytes; never exposed by key |
| **ORM** | [Drizzle ORM](https://orm.drizzle.team/) | Type-safe SQL schema and migrations for D1 SQLite |
| **Runtime** | [Cloudflare Workers](https://workers.cloudflare.com/) / `workerd` | Managed edge execution container |
| **Agent Protocol** | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) | JSON-RPC 2.0 interface for AI agent integration |

For a picture of how these pieces connect, open the interactive [system overview](../architecture/agentrelay-system-overview.html) in a browser. It is rendered from [`agentrelay-system-overview.architecture.json`](../architecture/agentrelay-system-overview.architecture.json), and each component links to the source lines it was drawn from. The viewer includes Archify code and the JetBrains Mono font; their [licenses and notices](../architecture/archify-notices/NOTICE) accompany the diagram.

## Code map

| Target | Entrypoint |
| :--- | :--- |
| Main view, search, polling | `src/app/_components/AgentRelayApp.tsx` |
| Create handoff, detail & export | `src/features/handoffs/components/` |
| Agent instructions & connection wizard | `src/features/agent-access/components/` |
| Setup checklist and this browser's device choice | `src/app/_components/SetupChecklist.tsx`, `setup-progress.ts`, `use-setup-record.ts`, `src/features/devices/components/DeviceChooser.tsx` |
| Devices tab, device picker & current device | `src/features/devices/` |
| Device ids, names and colours (pure rules) | `src/shared/formatting/device-identity.ts`, `src/shared/contracts/devices.ts` |
| Device registry service, create/delete orchestration & routes | `src/server/devices/`, `src/server/device-lifecycle/`, `src/app/api/devices/` |
| Connection expiry reminders (sweep and display data) | `src/server/connection-reminders/`, `src/app/api/notifications/connections/` |
| Project registry service & routes | `src/server/projects/`, `src/app/api/projects/` |
| Styling, typography, root layout | `src/app/globals.css`, `src/app/layout.tsx` |
| Handoff operations & MCP handler | `src/server/handoffs/`, `src/server/mcp/` |
| Receipt and reply rules, progress notifications | `src/server/handoffs/receipt-validation.ts`, `src/shared/formatting/reply-title.ts`, `src/server/handoffs/notification-events.ts` |
| Receipt, reply and thread UI | `src/features/handoffs/components/HandoffDetail.tsx`, `CompleteWithNoteDialog.tsx`, `NewHandoff.tsx` |
| Git context validation and checkout commands | `src/server/handoffs/git-context-validation.ts`, `src/features/handoffs/git-commands.ts` |
| Local client bootstrap and gateway token command | `scripts/agents/agentrelay.mjs`, `tooling/agents/client-bootstrap.mjs`, `tooling/agents/gateway.mjs` |
| Agent skill template, installer and local Git helpers | `tooling/agents/skill/agentrelay/`, `tooling/agents/skill-install.mjs`, `tooling/agents/git-context.mjs` |
| Image uploads, binding, cleanup & reads | `src/server/attachments/`, `src/app/api/attachments/`, `src/app/api/agent/attachments/`, `src/app/api/storage/cleanup/` |
| Image validation shared by Worker, browser and uploader | `src/shared/images/inspect-image.mjs`, `src/shared/contracts/attachments.ts` |
| Compose tray, gallery and viewer | `src/features/handoffs/components/AttachmentTray.tsx`, `AttachmentGallery.tsx`, `src/features/handoffs/hooks/use-attachment-uploads.ts` |
| Local image uploader for agents | `scripts/agents/upload-attachments.mjs`, `tooling/agents/upload-attachments.mjs` |
| REST and native MCP routes | `src/app/api/`, `src/app/mcp/route.ts` |
| Shared wire contracts & localization | `src/shared/contracts/`, `src/shared/i18n/` |
| Database schema, migrations, hosting | `src/server/db/schema.ts`, `drizzle/`, `.openai/hosting.json` |
| Architecture checks & integration tests | `tooling/architecture/`, `tests/integration/` |
| Built local preview, direct workerd transport and bounded request-body draining | `scripts/preview-local.mjs`, `tooling/environment/direct-local-preview.mjs`, `tooling/environment/prepare-local-preview.mjs`, `tooling/environment/preview-request-drain.mjs` |

Frontend features own their UI and use browser-safe contracts; route handlers adapt requests to shared server operations. Base primitives live in `src/components/ui/`. Node development tools live in `tooling/`, outside the application import graph. The `scripts/` entrypoints preserve existing commands. `dist/` contains build outputs; `.wrangler/`, `.sites-runtime/`, and `outputs/` are ignored local states and should never be checked into git. See [Agent connections](agent-connections.md) for external agent configuration.

## Repository Layout

```
AgentRelay/
├── .openai/hosting.json    # Site binding template; no Site identity in the source
├── src/
│   ├── app/               # Routes, layouts, CSS, and page composition
│   ├── features/          # Handoffs, devices, projects and agent-access frontend modules
│   ├── components/        # Common UI primitives and React providers
│   ├── shared/            # Wire contracts, localization, browser helpers
│   ├── server/            # Auth, HTTP/MCP adapters, services, D1 client/schema
│   └── platform/          # Request-scoped runtime connector adapters
├── worker/                # Cloudflare Worker bootstrap
├── drizzle/               # SQL migration history and metadata
├── tests/                 # Unit and built Worker integration tests
├── scripts/               # Stable command entrypoints and agent setup commands
├── tooling/               # Architecture, database, environment, installation, Vite, preview tools
├── docs/architecture/     # System overview diagram and architectural decisions
├── docs/guides/           # Developer and external agent guides
├── docs/reference/        # Protocol, data model, HTTP routes and security invariants
├── docs/images/           # README screenshots (synthetic data, local Worker)
├── docs/operations/       # Investigations and operational records
├── design/                # Current design specification
├── public/                # Publicly served static assets
├── vendor/                # Third-party assets and licenses
├── outputs/               # Ignored verification reports, screenshots, archives
└── *.config.*, *.json     # Root tool configuration and dependency manifests
```

> Note: `AGENTS.md` is tracked contributor guidance in this template. The [README](../../README.md) is the entry point. Architecture, security invariants and operational procedures are maintained in `docs/`: this guide, the [security invariants](../reference/security-invariants.md) and the other [reference documents](../reference/). Repository organization and file placement rules are maintained in `AGENTS.md`.

## Maintaining this repository

- **Standalone Workspace**: This repository is a standalone project. Source files, scripts, temporary directories, and builds all run relative to this repository root.
- **Sites Project ID**: This template has no Site identity. Register your own private Site on first deployment, retain its returned project_id locally, and target that same Site for every upgrade.
- **Template source**: This source export has no private repository history. Keep your deployment identity and runtime data out of contributions.
- **Live URLs & MCP Endpoints**: Refer to the live URL returned by the Sites `get_site` API (e.g., `https://<your-agentrelay-domain>.chatgpt.site`, with native MCP at `/mcp` and external agent MCP at `/api/agent/mcp`). Owners can rename slugs or custom domains at any time; Agents must verify `current_live_url` via Sites `get_site` prior to deployment.
- **Access Control & Workspace Isolation**: One Site is one workspace, keyed in the database by a single `ownerId`; every record operation is scoped to it. The Site's Sharing settings decide which other accounts may sign in, and they join the owner's workspace only when [sharing](../reference/shared-workspace.md) is enabled.

## Publishing to your Site

Publish with the Sites plugin rather than raw `wrangler deploy`, and never re-create a Site that already has a `project_id`. The [first deployment guide](first-deployment.md) holds a request you can paste into Codex for both the first deployment and every later update. In outline, Sites:

1. **Targets your Site**: reads `project_id` from your local `.openai/hosting.json` and confirms it with `get_site`. With no `project_id` it creates a new private Site and records the id locally.
2. **Builds and verifies**: installs dependencies, runs `npm run typecheck` and `npm run test:unit`, and builds with the project's build script.
3. **Packages and publishes**: pushes the source, then saves and deploys the version. Which native call it uses depends on the Site's audience, so the plugin chooses.
4. **Applies migrations**: pending migrations in `drizzle/` run before the Worker is uploaded.
5. **Confirms**: polls the deployment status and reports the live URL.

Browser notifications are optional and need four runtime values that `node scripts/notifications/generate-vapid.mjs --subject <https address or mailto address> --out <file outside this checkout>` generates once; see the [notifications guide](notifications.md#set-up-a-site).
