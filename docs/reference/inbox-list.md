# Inbox list

The browser's inbox and Done views read handoffs from `GET /api/handoffs?view=summary` in pages of summaries, and the detail pane reads the one handoff it shows from `GET /api/handoffs/:id`. Filters and search run in SQL, so the ten-second poll reads one page and the open handoffs, however many handoffs the workspace holds. The design and its measurements are in the phase 4a design note.

Every request is owner-scoped like every other handoff route. The shapes are in `src/shared/contracts/handoffs.ts`.

## `GET /api/handoffs?view=summary`

| Parameter | Values | Default |
| --- | --- | --- |
| `scope` | `open` (ready and claimed: the inbox) or `done` | `open` |
| `status` | `ready` or `claimed`, only with `scope=open` | both |
| `target` | a device id, or `any` for handoffs addressed to any device | all |
| `project` | a project id, or `none` for handoffs without a project | all |
| `q` | search text, at most 200 characters, matched against title, project and prompt | none |
| `limit` | 1 to 500 | 50 |
| `cursor` | the `nextCursor` of the previous page | first page |

The response is a `HandoffListPage`: `handoffs` (the same rows `list_handoffs` returns to agents: the summary, a 180-character `preview`, `characters`, and `resultPreview` and `resultCharacters` when there is a receipt), `nextCursor` (null on the last page) and `counts.open` (the inbox badge).

- Rows are newest first by creation time, then id. The cursor holds the last row's pair, so a handoff created between two pages never shifts or repeats one. An invalid cursor is a 400; a cursor only says where to continue, so one from another workspace pages that workspace's own rows.
- Search folds ASCII letters only (`lower()` in SQLite): "Café" finds "café", "CAFÉ" does not. It reads every active handoff of the workspace, so the browser sends it 300 ms after typing stops.
- Invalid values (an unknown scope, a status in the Done scope, a limit outside 1 to 500, a longer search) are a 400.

The browser polls with `limit` set to the rows it has loaded and replaces them; Show more asks for the page after `nextCursor`.

## `GET /api/handoffs?view=project-counts&scope=open|done|all`

A `HandoffProjectCounts`: handoffs per project id in the scope, and `none` for those without a project. The project menu reads it when the scope changes and when it opens, Manage projects when its dialog opens; it is never polled.

## `GET /api/handoffs/:id`

The full record: prompt, receipt, image manifest and the thread. Thread entries carry `sourceDeviceId` and `targetDeviceId` (null for unregistered devices), so the thread shows each device in its colour.

## Plain `GET /api/handoffs` (deprecated)

Without `view` the route still returns the newest 500 active handoffs with their full text, so tabs opened before the summary list keep working until they reload. It is removed in a later release.

## Query plans

`handoffs_owner_status_created` (`owner_id, status, created_at, id, expires_at`, migration `0020`) keeps the reads bounded. A page query with `status = ?` walks it newest first and stops at the limit, so the inbox runs one query per status and merges them; with `expires_at` it also covers the open count. `verify-agentrelay-inbox-list.mjs` asserts both plans in the local D1.
