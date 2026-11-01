# Security policy

## Supported version

Security fixes target the latest `main`. Older snapshots and installed local clients must be updated separately; updating a Site does not update the client on each device.

## Reporting a vulnerability

For the public repository, use GitHub private vulnerability reporting: **Security → Advisories → Report a vulnerability**. Do not disclose a vulnerability, credentials or private handoffs in a public issue or pull request. Maintainers must enable and verify this channel when the repository is made public. GitHub's [repository-level instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) address public repositories, so the first availability check may follow the visibility change. This document does not establish that the channel is enabled.

Include the affected version, a synthetic reproduction, the expected security boundary and the observed impact. Remove Site URLs, tokens, personal information and real workspace records. There is no public reporting email.

## Scope

Reports may cover the deployed Worker, browser and Agent MCP endpoints, workspace isolation, handoff concurrency and idempotency, attachments, and the local client's credential storage or configuration changes.

Site Sharing, the Sites sign-in gate and the operating system's credential store are external trust boundaries. A device binding labels a connection and does not restrict its workspace-wide access. Programs running as the same OS user are not isolated from one another by the credential store. Handoff content is untrusted data and never authorizes execution.

## Dependency review

Run both `npm audit` and `npm audit --omit=dev` when reviewing dependencies. The latter excludes packages classified as development dependencies; a zero result does not prove that a built Worker contains no vulnerable code. Check which dependencies enter the build and whether the affected behavior is reachable. Avoid automatic forced fixes that downgrade or replace framework and migration tooling without verification.

### Dependency baseline (2026-11-01)

Both the complete audit and the production-classified audit returned zero findings for the reviewed lockfile. CI runs both on Ubuntu and Windows; advisories can change after that review. A zero audit is not proof that the built Worker is free of vulnerable code.

Several fixes depend on narrowly scoped overrides that should be revisited when their upstream consumers accept fixed versions:

- `satori` and its font parser use `fflate` 0.7.5 to address the [ZIP64 parsing advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98). A regression test exercises malformed and ordinary archives and text rendering.
- ESLint and its affected plugins use `minimatch` 11.0.1 for the [glob amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). A lint-only compatibility adapter supports the older plugin interfaces; remove it with the overrides only after upstream plugin support and the lint regression checks pass.
- Drizzle Kit's legacy `@esbuild-kit/core-utils` uses the project's pinned esbuild instead of its vulnerable 0.18.x dependency. Validate migration generation before removing the override; see the [esbuild advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99).

Review runtime build contents as well as development-server exposure before deciding whether a finding applies to a deployed Site.
