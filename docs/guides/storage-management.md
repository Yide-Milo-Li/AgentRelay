# Storage management

AgentRelay is a reusable template: each deployment (a Site, or a standalone Cloudflare Worker) is one workspace shared by the accounts its sign-in admits: a Site's Sharing settings, or a Cloudflare Access policy. Storage is measured and managed for the whole workspace, so every member sees and can delete every member's handoffs. Different Sites keep separate databases. Authentication and workspace-scoped database operations remain required.

## Read the usage display

**Settings › Storage** (also reached from the usage chip in the inbox footer) leads with the total stored size and a bar split by type: prompt text, other database data, images and, when there are any, uploads awaiting cleanup. Each segment is its share of the total; very small types keep a minimum width so they stay visible, and the legend gives exact sizes and shares. Below the bar, two limit rows show the database size reported by D1 query metadata (`meta.size_after`) as a percentage of the instance limit, and the R2 image bytes, which have no fixed limit. OpenAI documents a 10 GB D1 limit and no fixed R2 storage limit per Site: [Sites limits](https://learn.chatgpt.com/docs/sites?surface=web), so images never count toward the 10 GB. AgentRelay initially displays 10,000,000,000 bytes; set the optional runtime environment variable `AGENTRELAY_STORAGE_LIMIT_BYTES` to a positive safe integer to change the displayed limit. This setting does not enforce a quota or change the platform's actual limit.

On a standalone Cloudflare deployment the limits come from the Workers plan instead. D1 allows 500 MB per database on Workers Free (5 GB per account) and 10 GB on Workers Paid, and the deploy command sets `AGENTRELAY_STORAGE_LIMIT_BYTES` from the deployment config's `plan`. R2 has no fixed limit there either, but only 10 GB-month are free and more is billed, so the image row says "10 GB-month free, billed above". A full database answers writes with 507 ("This deployment's database is full."), and on Workers Free the daily row-read and row-write caps answer 503 with `Retry-After` until 00:00 UTC. [Deploy to Cloudflare](cloudflare-deployment.md#plans-and-limits) compares the plans.

The database measurement includes prompt text, indexes, account metadata, and reusable database pages. Ready, Claimed, Done and Expired totals add the prompt content encoded as UTF-8 and the bytes of the images attached to each handoff (the logical size). "Other database data" on the bar is the measured database size minus the UTF-8 prompt text; when the database size is unavailable it is shown as unavailable and left off the bar. Image bytes live in R2, not in D1, so they appear on the bar and in the **Image storage (R2)** limit row but never count against the database meter. An expired record belongs only to Expired, regardless of its lifecycle status. Expired records are deleted automatically (see below), so Expired is normally 0.

Measurements refresh on initial load, entering Storage, manual refresh and successful local handoff mutations. While Storage is open and the document is visible, usage refreshes every 30 seconds. Failed measurements show an unavailable state or identify the last successful measurement as stale; they never substitute zero for a failure.

## Expired handoffs are deleted automatically

A handoff expires `expiresInDays` after it is created (1–365, default 30). Expiry hides it from the inbox and both MCP endpoints at once, and the next time the workspace is used AgentRelay deletes it for good: its text, its attachment rows and its image objects in R2. There is no grace period; to keep a handoff longer, send it with a longer lifetime.

AgentRelay does not schedule a deletion job, so the deletion rides on ordinary requests:

- the inbox list (`GET /api/handoffs`, which the open inbox polls) and every request to either MCP endpoint start a sweep after the response, at most once a minute per workspace per Worker instance;
- Storage (`GET /api/storage` and `GET /api/storage/handoffs`) runs a sweep before it answers, so it does not show handoffs that are due.

A sweep deletes at most 200 handoffs (four batches of 50), oldest expiry first, so a large backlog, such as the expired records already stored when this behaviour is first deployed, drains over a few requests. Each batch deletes its handoffs and releases their images in one database transaction whose every statement re-checks the expiry, so it can never touch a live handoff. No version check is involved: nothing changes `expires_at` after creation and no lifecycle operation accepts an expired handoff, so an expired record stays expired. Two sweeps, or a sweep and a manual deletion, of the same record delete it once and queue its images once. The image objects are deleted from R2 right after the commit, in one call per batch; if R2 refuses, they stay listed as pending image cleanup and later sweeps, uploads, deletions and **Clean up images** retry them.

An expired handoff can no longer be opened in Storage once a sweep has run, and its idempotency key is freed, exactly as for a manual deletion. A quiet workspace keeps its expired records until its next request, but nothing outside Storage can see them in the meantime.

## Find and remove unused handoffs

1. Open Storage. The initial list includes all stored handoffs, largest first, with nothing selected.
2. Search titles/projects, choose a status or expiration filter, or use Completed over 30 days ago or Largest handoffs. Expand the additional filters to pick a project (archived ones are marked), exact device names or IDs, creation age and minimum size in bytes (text plus images). Device suggestions are bounded to 200 values per field; typing an exact value still searches all records.
3. Sort by size, creation time, or last update. Pagination covers the entire workspace-scoped database, independent of the inbox list's 500-handoff window. Each page contains at most 50 records.
4. Open a title to inspect the full, plain-text prompt. Select individual records or the current page. Changing filters, sorting or pages clears selection.
5. Review the selected count and **Selected data (text + images)**. Confirm **Permanently delete**. Ready or Claimed selections carry an additional warning because another device may be using them.

Deletion cannot be undone and does not use a recycle bin. Devices and Agent Tokens are unaffected. Confirmation submits explicit IDs and their observed versions; it never submits an instruction to delete all records matching a filter. If a selected handoff changed, it remains stored and is reported as a conflict. Other successful deletions remain committed. Failed selections stay selected for review; deselect and reselect a changed row to accept its displayed version.

If a connection fails before a result can be confirmed, the client refreshes reads without retrying the deletion. Review which records still exist before another attempt. Permanent deletion also removes the record's original idempotency key; a later creation using that key follows the existing create behavior.

Deleted text creates reusable database space, but the database file may not immediately shrink. AgentRelay re-measures the database rather than subtracting selected prompt sizes from the meter. It provides no compaction. Expiry is the only retention policy: there is no scheduler and no separate retention setting.

## API and verification

`GET /api/storage` returns measured instance bytes, configured limit, measurement time and workspace-scoped category totals. `GET /api/storage/handoffs` returns metadata, bounded suggestions, a matching count and an opaque next-page cursor. Filter parameters are `search`, `status`, `expiration`, `project`, `sourceDevice`, `targetDevice`, `ageDays`, `minBytes` and `sort`. `project` takes a project id (the UI sends one) or a name matched by key; any other text matches the stored name exactly. Cursors bind the sort position, filters and time used for expiration/age calculations; reset pagination when filters change.

`GET /api/storage/handoffs/[id]` returns an owner's full prompt regardless of expiration, excluding owner and request-key fields. `POST /api/storage/handoffs/delete` accepts `{ "items": [{ "id": "…", "version": 1 }] }`, with 1–50 unique IDs, and returns `deleted`, `conflict` or `not_found` for each item plus `deletedCount`. A response containing a version conflict uses HTTP 409 even when other items were deleted. Foreign IDs and missing IDs both appear as `not_found`.

The existing `DELETE /api/handoffs/[id]` accepts an optional JSON `version`; the web UI supplies it. Legacy body-less calls remain supported and still compare the version read by the server. Both deletion paths use the same owner-scoped operation. Every storage response disables caching; writes retain origin and body-size checks. The five MCP tool names and existing handoff payloads are unchanged.

Apply the generated `0003_right_zzzax.sql` migration after the existing migrations. It adds only a covering expression index on owner, UTF-8 prompt byte length, ID, status, expiration and timestamps. No prompt content is copied into a separate field or index. Index creation reads existing data once; measure its duration on a representative database before deploying a large existing instance. Applied migration history must not be rewritten. `0018_handoff_expiry_index.sql` adds only the `handoffs_owner_expiry` index on owner, expiry and ID that the expiry sweep reads.

Run against the built local Worker:

```bash
export AGENTRELAY_TEST_URL=http://127.0.0.1:5178
npm run test:integration:storage
npm run test:e2e:storage
```

```powershell
$env:AGENTRELAY_TEST_URL = 'http://127.0.0.1:5178'
npm run test:integration:storage
npm run test:e2e:storage
```

The suites use disposable synthetic owners and remove only their own data. Evidence is written under ignored `outputs/storage/` and `outputs/storage-e2e/`. The integration suite verifies Unicode sizes, automatic deletion of expired handoffs (including a backlog larger than one sweep), filtering, pagination beyond 500 records, deletion races, both MCP transports and D1 covering-index plans. Browser verification covers selection resets, protected confirmation, partial conflicts, lost responses, language switching, mobile layout and demo isolation. Local results do not establish deployment or 10 GB-scale performance.

For an isolated preview, set `AGENTRELAY_TEST_STATE` to the same persistence directory supplied to Wrangler's `--persist-to`. `AGENTRELAY_TEST_CONFIG` can point to that preview's generated Wrangler configuration. These overrides keep SQL fixture setup and cleanup aligned with the Worker under test; they do not change application configuration.

## Images

- The list shows each handoff's total size and, when it has images, the text and image parts. Sorting by size, the minimum-size filter, selection totals and the deletion preview all use text plus image bytes. Pagination cursors carry version 2; a cursor from before image support is refused and the page reloads from the start.
- Opening a title shows the images of that handoff through the Storage image route.
- **Image cleanup** reports how many images are attached and their bytes, any unattached uploads (kept 24 hours), and objects still waiting for deletion. Its **Clean up images** button runs that cleanup; it never deletes a handoff.
- Permanently deleting a handoff, in one version-checked database batch, queues its image objects for deletion and removes its attachment rows; a stale selection changes nothing. The R2 objects are deleted right after the commit, in one call per batch. If R2 refuses, the deletion still stands, the batch's objects stay listed as pending cleanup with a failure count, and later uploads, deletions, expiry sweeps or **Clean up images** retry them. There is no scheduler.
- `GET /api/storage` additionally returns `imageStorage` (`unattached`, `pendingCleanup`) and per-group `imageCount`, `imageBytes` and `logicalBytes`; `POST /api/storage/cleanup` runs one bounded cleanup and returns the same figures plus what it reclaimed and deleted.
- Apply `0005_image_attachments.sql` after the earlier migrations. It adds tables, two defaulted columns on `handoffs` and the `handoffs_owner_logical` index (the earlier index stays for older code).
- Verify with `npm run test:integration:attachments` and `npm run test:e2e:images`; see [Image handoffs](image-handoffs.md).
