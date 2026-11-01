# Local preview transport

`npm run start` and `npm run test:integration:local` serve the production Worker build through one Miniflare/workerd instance. Wrangler still supplies the configuration-to-binding conversion and the local D1/R2 fixture commands. The preview keeps the generated compatibility date, flags, variables, assets and resource identities.

## Why the transport changed

The earlier Windows runtime verification had one remaining HTTP 500 on a valid attachment upload. Wrangler's ProxyWorker reported `Network connection lost`, while its UserWorker stayed alive. A minimal Worker that fully reads its request body reproduced the same failure without a database, image handling or application code.

The failing leg is the extra HTTP connection from Wrangler's ProxyWorker to its UserWorker. A send-time-aligned five-second request cadence reproduced failures with fresh incoming client sockets; setting `Connection: close` on application responses did not remove them. This matches the idle-connection problem tracked in [workers-sdk #14641](https://github.com/cloudflare/workers-sdk/issues/14641). The project fixes its local preview path by serving the UserWorker directly in Miniflare, eliminating that leg. Stock Wrangler remains an explicit diagnostic control.

`tooling/environment/direct-local-preview.mjs` uses the pinned Wrangler configuration API, bundles the built entrypoint in memory with esbuild, and starts Miniflare with the resulting explicit module. The `state/v3` persistence location matches Wrangler's CLI. The existing bounded request-body drain remains around the framework's Request transfers, covering the separate unread-body issue in [workerd #7634](https://github.com/cloudflare/workerd/issues/7634).

The preview and tests contain no request retry loop. The transport regression checks each unique write's handler count and byte hash, and checks that an intentional application HTTP 500 is returned without replay. Owner isolation, origin/size checks, CAS and idempotency assertions continue to run in the original application suites.

## Commands

Use the development Node version in `.node-version`, then:

```powershell
npm run build
npm run test:integration:transport
npm run test:integration:proxy
npm run test:integration:local -- --acceptance
```

The normal preview remains:

```powershell
npm run db:migrate:local
npm run start -- --port 5178
```

Supported local preview options are `--port` (default 8787), `--ip` (default loopback), `--config`, `--persist-to`, and repeated `--var NAME:value` options. Values may contain colons. Production publishing continues to use the original build and hosting configuration. The local preview does not hot-reload; rebuild after source changes.

Miniflare and esbuild are direct development dependencies pinned to the versions already selected by Wrangler/Vite. Upgrade and verify that toolchain together: the Wrangler configuration API and Miniflare's v4-to-v5 option conversion are version-sensitive.

## Verification record — 2026-10-26

Runtime: Windows x64, Node 24.21.0, Wrangler 4.129.1, Miniflare 5.20260907.0-alpha, workerd 1.20260907.1, esbuild 0.28.1. Application source, migrations and hosting configuration were unchanged.

- Two independent formal cadence checks each sent 256 writes per transport. Stock Wrangler lost 9 and 7 requests respectively; the direct preview delivered all 512 writes. Each direct write reached the same Worker instance once and preserved the original bytes. The final check also verified application HTTP 500 passthrough and its handler count of one.
- The original six-suite integration chain passed all 443 checks on its first direct-preview run, followed by all 45 shared-workspace checks.
- The full `--acceptance` run passed all three 443-check chains (cold start, the same still-running Worker, then a fresh cold start) and all 45 shared-workspace checks. The recorded PIDs confirm the second round reused the first Worker's process and the third round started a different one.
- Browser image handoffs passed 49 checks and keyboard workflows passed 81 checks. Both used a disposable built preview and synthetic identities. English/Chinese, dark appearance, 390 px layouts, uploads, previews, rejected images, copying and versioned lifecycle shortcuts were exercised.
- Notification lifecycle and event checks passed all 23 cases with synthetic runtime variables, including values containing colons. No external push was sent.
- Type checking, architecture checks, all 319 unit tests and the production build passed. Lint had zero errors and eight pre-existing warnings. The body-draining diagnostic passed its direct-preview case with one Worker instance; both negative controls reproduced unread-body failures.

The original evidence was retained as ignored local artifacts and is not part of this source distribution. The counts and versions above describe that historical run; repeat the relevant checks when changing the current toolchain.
