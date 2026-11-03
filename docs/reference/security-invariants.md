# Security invariants

Every change to AgentRelay must keep these rules. Contributors and coding agents alike should read them before touching authentication, storage, the handoff lifecycle or request handling.

All contributors and AI Agents modifying this codebase **must strictly uphold the following invariants**:

1. **Absolute Workspace (Owner) Isolation**
   - Web requests and native `/mcp` routes derive `ownerId` from the platform's sign-in: the header `oai-authenticated-user-id` on the `sites` build, or a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) verified against the configured team and AUD tags on the `cloudflare` build. Each build reads exactly one source; a `cloudflare` build contains no code that reads the Sites headers, and its build guard fails otherwise. External `/api/agent/mcp` routes resolve `ownerId` from the SHA-256 hash of a valid personal Agent Token. Client-supplied identity overrides are never permitted.
   - When the server-side `AGENTRELAY_WORKSPACE_OWNER_ID` variable is set, every platform-authenticated user resolves to that one `ownerId` (the shared workspace). The mapping happens only in `src/server/auth/`; services keep filtering by the `ownerId` they are given.
   - All queries and state mutations scope strictly by `ownerId`. Active records must satisfy:  
     `active(owner) = and(eq(handoffs.ownerId, owner), or(isNull(handoffs.expiresAt), gt(handoffs.expiresAt, Date.now())))`.
   - Never introduce endpoints or queries that bypass owner checks. Image reads and uploads follow the same rule: every `attachments` and `object_cleanup` query filters by `ownerId`, a foreign or missing attachment id answers identically, and R2 object keys never leave the server.
2. **Optimistic Concurrency Control (CAS)**
   - Handoff lifecycle state transitions (`ready` -> `claimed` -> `done` or resets) must be conditioned on `version`.
   - Claim and update mutations must lock the version in the WHERE clause: `eq(handoffs.version, row.version)`, incrementing on update: `version: row.version + 1`. A conflict (no rows updated) must return HTTP 409.
   - A completion receipt (`result`) is written by the same guarded update that moves the handoff to `done`, and cleared by the one that returns it to `ready`; it never has a write of its own.
3. **Idempotent Request Keys**
   - `createHandoff` accepts an optional `requestKey`. If a record with the same key exists and its payload (title, content, project, devices) matches, return the existing record. Devices and projects compare by registry id when both sides have one and by name (projects: by name key) otherwise, so a retry after a rename still matches. If the payload (which includes the ordered `attachmentIds`, the `replyTo` parent and the normalized `branch` and `baseCommit`) differs, return HTTP 409.
4. **Text-as-Data Sandbox**
   - Prompt content (up to 200,000 chars) is untrusted text, and so are completion receipts (up to 20,000 chars), replies and Git context (`branch`, `baseCommit`), which the server validates by shape and never resolves or fetches.
   - Never render via `dangerouslySetInnerHTML` or execute via eval/scripts.
   - The platform never executes commands contained within prompt texts. Images are data too: they are served `no-store`, `nosniff` and sandboxed, and viewing one grants no authority.
5. **Same-Origin & Payload Size Limits**
   - Non-GET requests must pass `sameOrigin(request)`.
   - Requests exceeding 1,300,000 bytes `Content-Length` or parsed JSON exceeding 1,250,000 characters must return HTTP 413.
   - Image uploads are raw single-image bodies read as a bounded stream (with or without `Content-Length`); anything over 1,048,576 bytes returns 413.
6. **Edge Runtime Compatibility**
   - Application code in `src/` and `worker/` targets Cloudflare Workers (`workerd`). Do not add Node.js native packages (`node:fs`, `node:child_process`, etc.). R2 is reached only through the `BUCKET` binding via `getBucket()` in `src/server/db/client.ts`; the local uploader's file reads live in `tooling/`. The existing request-context adapter in `src/platform/connectors/connector-context.ts` alone uses `node:async_hooks` with `nodejs_compat`; do not expand this compatibility case. Development-only Node code belongs in `tooling/`.
