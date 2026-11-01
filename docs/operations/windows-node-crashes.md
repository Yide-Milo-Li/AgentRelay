# Windows Node.js crashes during integration tests

Use Node.js **24.21.0**, recorded in `.node-version`. The upgraded toolchain has been verified on that version. Windows tooling also accepts 24.20+ on the 24.x release line and 26.1+, because they carry the upstream fix, but the upgraded toolchain has not been separately verified on those other versions; it stops older and unsupported Windows release lines before starting a build, local Worker or integration request. An earlier toolchain passed the eight-suite chain on Node 26.13.0. Other operating systems retain the existing Node.js minimum.

## Cause and evidence

Node.js 24.15.0 vendors libuv 1.51.0. Its Windows TCP implementation calls `RtlGetVersion(&os_info)` without initializing `OSVERSIONINFOW.dwOSVersionInfoSize`. Depending on previous stack contents, Windows can write the larger structure across the stack cookie. The resulting fast-fail is `0xC0000409`; it can bypass both Node's fatal-error report and ordinary Windows Error Reporting.

This is an upstream native-runtime defect, fixed by [libuv #5107](https://github.com/libuv/libuv/pull/5107). [libuv #5274](https://github.com/libuv/libuv/issues/5274) describes the same Node 24.15.0 / Windows 11 loopback-connect signature and identifies the missing initialization. The [24.15.0 source](https://github.com/nodejs/node/blob/v24.15.0/deps/uv/src/win/tcp.c) lacks the size assignment; the [24.21.0 source](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/tcp.c) contains it. Libuv's reported version alone cannot establish that a Node release includes the cherry-pick.

AgentRelay's historical failures match the affected runtime and timing: three silent suite-process failures in 19 full local runs, during initial HTTP work. No local crash dump was captured, so the exact native stack of those historical failures remains unconfirmed. The runtime upgrade addresses the known upstream defect; a clean soak is regression evidence, not retrospective proof of those stacks.

The earlier `ECONNRESET` was a separate issue caused by synchronous fixture subprocesses blocking retirement of pooled sockets. Keep the asynchronous fixtures, one-attempt HTTP requests, zero test retries, and all existing assertions.

## Select and verify the runtime

Select `.node-version` with your Node version manager, then open a shell using that version. A portable official `node.exe` also works: put its directory first on that shell's `PATH`, and invoke npm's JavaScript entrypoint with that executable if the installed npm shim selects another Node. No registry, antivirus or system-wide setting change is needed.

```powershell
node -p 'JSON.stringify({node:process.version,uv:process.versions.uv,executable:process.execPath})'
npm run typecheck
npm run check:architecture
npm run test:unit
npm run build
npm run test:integration:local -- --acceptance
```

The parent `results.json` and each round's `suites.json` record both Node and libuv versions. Check both: npm may otherwise start child suites using a different Node on `PATH`. Crash report options are passed as separate arguments so output paths containing spaces remain intact.

For this intermittent fault, make at least 20 full local-verification attempts on the fixed runtime with unchanged source and preserve every failure. Each attempt must use the ordinary local runner and its nested npm/suite process tree, with a fresh disposable Worker and database. Count repeated attempts as soak samples, never automatic retries that turn a failed test green.

If the fast-fail returns on a supported runtime, retain the failing run and capture a native dump before assigning a new cause. Do not weaken assertions, suppress the exit code, or change global Windows crash settings as part of the test harness.

## Verification record — 2026-10-26

This historical run used an earlier source snapshot plus the runtime guard, `.node-version`, report metadata and report-argument changes. No application source, assertions or retry policy changed during that run. Official Windows x64 Node.js 24.21.0 was prepared in an ignored local directory; its SHA-256 matched the official `SHASUMS256.txt` and its OpenJS Foundation Authenticode signature was valid. The system Node installation was not changed.

- Type checking, architecture checks, production build, all **319 unit tests**, and all **45 shared-workspace integration checks** passed. Lint had zero errors and eight existing warnings.
- **20 full local-verification attempts** used fresh disposable Workers and databases and the nested `npm run test:integration` command. The recorded source hashes stayed identical across all attempts; test retries stayed at zero.
- **No native fast-fail occurred.** The two historically affected suites, Agent Tokens/MCP and projects, each completed **20/20** times.
- The complete six-suite chain passed **19/20** times, with **443 checks** per successful chain. Attempt 9 failed during `POST /api/attachments`: Wrangler's ProxyWorker reported `Network connection lost`, returned HTTP 500, and kept serving subsequent requests. The suite exited normally with code 1 and a JavaScript error, rather than the native Windows exit code. This transfer failure was unresolved at that point; the subsequent [local preview transport fix](local-preview-transport.md) passed the cold/warm/cold integration acceptance.

The original evidence was retained as ignored local artifacts and is not part of this source distribution. The record above describes that historical run; it is not a claim that every later toolchain was tested in the same soak.

The historical native call stacks remain unconfirmed without their dumps. This record establishes the upstream fix present in the selected runtime, early rejection of the affected runtime, and no native-crash recurrence over these samples. It does not assign a definitive native stack to the older failures. The separate ProxyWorker investigation and its current acceptance results are recorded in the transport follow-up linked above.
