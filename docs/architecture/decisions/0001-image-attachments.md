# 0001. Image attachments: private R2, guard-row binding, denormalized image totals

Status: accepted for v1. Local verification and historical real-Site client checks passed on earlier versions; the toolchain-upgraded build and R2 persistence across redeployment remain unverified on a real Site.

## Context

Handoffs were text only. Agents and people need to hand over screenshots, with or without text, across three MCP clients that differ in how they can attach binary data. The Worker runs on `workerd` without Node APIs or an image decoder, D1 batches are transactions but a zero-row `UPDATE` is not an error, D1 limits a statement to 100 bound parameters, and the existing Storage views sort and total by an indexed byte expression.

## Decisions

1. **Bytes in a private R2 bucket (`BUCKET`), metadata in D1.** Objects are immutable, keyed by attachment id (`a/<id>`), never addressed by clients, and always served through owner-scoped routes with `no-store`, `nosniff` and a sandboxing CSP. The upload is a separate raw-body request (one image each) rather than base64 in JSON, so the existing 1.3 MB JSON limit and MCP payloads stay small. MCP returns bytes only for one image per `get_handoff` call, as a standard `image` block.
2. **Row first, object second.** An upload inserts a `pending` row, writes R2, then marks it `ready`. A crash leaves a pending row that a retry completes or the sweep reclaims together with its possible object, so no object can exist without a row that will clean it up.
3. **Atomic binding with a guard row.** `create_handoff` inserts the handoff, updates each attachment (`WHERE handoff_id IS NULL AND state = 'ready' AND created_at >= cutoff`) and finally inserts a row into `attachment_bind_guard` whose `CHECK (expected = actual)` fails the whole D1 batch if any attachment was claimed, reclaimed or removed after the pre-check. The cleanup sweep re-evaluates its staleness predicate inside its own batch against the same column, so a row is either bound or reclaimed, never both.
4. **Denormalized, immutable `attachment_count` and `attachment_bytes` on `handoffs`.** Attachments are bound only at creation and never change, so the totals cannot drift, and the guard proves them at write time. This keeps Storage sorting, filtering and summaries index-only (`handoffs_owner_logical`) instead of joining per row. The previous byte index stays for older code. List cursors carry a version, so ordering by text-only bytes is never misread as the new ordering.
5. **Deletion queues object cleanup in the same version-checked batch.** The `INSERT … SELECT` into `object_cleanup` and the `DELETE` of the attachment rows are guarded by `EXISTS (handoff at the observed version)`, so a stale deletion changes nothing. Object deletion follows the commit; failures stay in `object_cleanup`, visible and retried. Rows whose handoff vanished (deleted by an older Worker version) are reclaimed by the same sweep, which keeps rollback safe. There is no scheduler.
6. **One validation module for every runtime.** `src/shared/images/inspect-image.mjs` is plain JavaScript used by the Worker, the browser composer and the Node uploader, so a file accepted locally is accepted by the server and vice versa. It validates structure, not pixels.
7. **Service boundary.** `src/server/attachments/` owns every query on `attachments`, `object_cleanup` and `attachment_bind_guard` and hands the handoffs service prepared statements to compose into its own batches (the same pattern as the devices service). Only `db/client.ts` touches the binding. The architecture check allows `handoffs` and `mcp` to depend on it through its public index only.

## Consequences

- Reads of images cost one D1 join and one R2 get; lists cost one extra chunked query only for handoffs that have images.
- Image bytes are outside the D1 meter, so Storage shows them separately and has its own cleanup action.
- Rolling the Worker back is safe: the migration is additive, old code ignores the new tables, and leftover rows are reclaimed by a newer sweep.
- Later change: since migration `0015` a completion receipt counts as text too, so Storage reads the same totals through `handoffs_owner_logical_v2`; `handoffs_owner_logical` remains for older code (see [receipts and threads](../../reference/receipts-and-threads.md)).
- What is not proven for the upgraded build: that an existing Site accepts its R2 binding, that image bytes survive redeployment, and that the platform gateway and each client pass a ~1.4 MB base64 MCP response. Earlier live client checks do not establish those results for the upgraded build; verify them on a real Site before claiming acceptance.
