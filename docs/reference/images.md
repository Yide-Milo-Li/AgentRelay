# Image handoffs reference

Limits, routes and storage rules for images. For the user-facing walkthrough, see the [image handoff guide](../guides/image-handoffs.md).

A handoff can carry up to 10 ordered images, alongside text or on their own. The title stays required; `content` may be empty only when at least one image is attached, and non-empty text is stored exactly as sent.

| Policy | Limit (inclusive) |
| :--- | :--- |
| Formats | Static PNG, JPEG, WebP (the bytes decide the type; GIF, SVG, APNG and animated WebP are refused) |
| Images per handoff | 10 |
| Bytes per image | 1,048,576 |
| Longest edge / pixels | 2,560 px / 4,000,000 |

Images are never recompressed or resized: the stored bytes are the uploaded bytes (SHA-256 recorded). An image that breaks a limit is rejected with a message naming the value and the limit, in the browser first and again on the server. Validation is structural (signature, chunk or marker walk, checksums for PNG, dimensions, animation flags); the Worker has no pixel decoder, and stored dimensions are the encoded ones (EXIF orientation is not applied).

**Flow.** An upload is its own request: one raw image per `POST` (`X-Upload-Key` is the retry identity, `X-Filename` the percent-encoded display name). The same key and bytes return the existing upload; different bytes under the same key return 409. An upload belongs to at most one handoff, and `create_handoff` binds the whole ordered list together with the handoff in one D1 batch whose last statement is a guard row with a `CHECK`; if any upload was bound elsewhere, reclaimed or expired in between, the batch rolls back and no partial handoff exists. Unattached uploads are kept 24 hours.

| Route | Auth | Purpose |
| :--- | :--- | :--- |
| `POST /api/attachments` | Platform identity, same-origin | Web upload. 201 new / 200 replay with the metadata. 400, 401, 403, 409, 413, 415, 422 |
| `POST /api/agent/attachments` | Agent Token + Sites gateway header | The same upload for agents |
| `GET /api/agent/handoffs/:id/attachments/:attachmentId` | Agent Token + Sites gateway header | The original bytes for agents (fallback when the MCP image block does not arrive). Same rules and headers as the web route; only `GET` |
| `GET /api/handoffs/:id/attachments/:attachmentId` | Platform identity | Preview (`?download=1` for the original). Respects handoff expiry. `no-store`, `nosniff`, sandboxed CSP |
| `GET /api/storage/handoffs/:id/attachments/:attachmentId` | Platform identity | The same for Storage management; may read an expired handoff until its deletion |
| `POST /api/storage/cleanup` | Platform identity, same-origin | Bounded cleanup: reclaim stale uploads, retry queued object deletions |

Statuses: 413 over the byte limit, 415 unsupported or contradicted type, 422 damaged, animated, or over a dimension or pixel limit. A missing attachment and another workspace's attachment answer identically (404).

**Uploader for agents.** Credentials come from the environment and are never printed:

```bash
export AGENTRELAY_MCP_URL=https://<your-site>/api/agent/mcp
export AGENTRELAY_AGENT_TOKEN=agentrelay_...            # the personal Agent Token
export AGENTRELAY_SITES_GATEWAY_TOKEN=...               # Codex: AGENTRELAY_SITES_GATEWAY_HEADER="Bearer ..." instead
node scripts/agents/upload-attachments.mjs shot-1.png shot-2.webp
# {"attachmentIds":["…","…"],"attachments":[…],"retryKey":"cli-…"}
```

All files are checked before the first upload. `--retry-key <prefix>` makes a deliberate retry of the same command idempotent; by default each run uses a fresh key so the same screenshot can go into a later handoff. Pass `attachmentIds` to `create_handoff` in the printed order.

**Downloader for agents.** The MCP `image` block stays the primary way to receive an image. Some clients save larger blocks to a local file the agent cannot open; for those, the same credentials fetch the originals over plain HTTP:

```bash
node scripts/agents/download-attachments.mjs <handoffId> [--out <folder>]
# {"handoffId":"…","dir":"…","files":[{"attachmentId":"…","position":1,"path":"…/01-shot.png","mimeType":"image/png","bytes":123,"sha256":"…"}]}
```

It reads the manifest, downloads each image in order, checks size and SHA-256 against the manifest and writes `NN-<safe name>.<ext>` files (default folder: `<system temp>/agentrelay/<handoffId>`). A rerun keeps files that are already correct. Expired handoffs and other workspaces' images answer 404.

**Storage and cleanup.** Image bytes live in R2 and are not counted against the D1 meter. Storage sorts, filters, selection totals and deletion previews use text bytes plus attached-image bytes (`logicalBytes`; list cursors carry version 2). Permanently deleting a handoff queues its objects for deletion and removes its attachment rows in the same version-checked batch (a stale deletion changes nothing), then deletes the R2 objects; failures stay in `object_cleanup`, are shown as pending cleanup in Storage, and are retried by later uploads, deletions, expiry sweeps and the **Clean up images** button. There is no scheduler. An expired handoff is deleted automatically with its images, at the next request of its workspace (inbox polling, either MCP endpoint, Storage); see the [storage guide](../guides/storage-management.md#expired-handoffs-are-deleted-automatically).

**Deployment.** The tracked `.openai/hosting.json` template declares `"r2": "BUCKET"`. Deploy with the Sites flow as before; the migration and the bucket binding come with the deployment. Existing Sites that were deployed without R2 need that binding added by the deployment step; see the [image handoff guide](../guides/image-handoffs.md).
