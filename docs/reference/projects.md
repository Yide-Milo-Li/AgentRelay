# Projects

Handoffs are filed under projects per workspace (`owner_id`). Nobody registers a project first: a handoff that names an unknown project creates it in the same `db.batch` that saves the handoff, and a blank or missing `project` means no project.

- **Name key**: names compare by `projectNameKey` (`src/shared/formatting/project-identity.ts`): NFKC, lowercased, with whitespace, `-`, `_` and `.` removed. `AgentRelay`, `agent-relay` and `Agent Relay` are one project, shown under the stored name. A name needs at least one letter or digit and at most 120 characters.
- **Linkage**: `handoffs.project` stays as the display snapshot; nullable `handoffs.project_id` links to `projects` without a foreign key. Both are set from subqueries inside the creation batch, so concurrent senders of one new name converge on one project. Rename and merge rewrite the snapshots in their batch; delete clears both, leaving the handoffs without a project.
- **Ids and colours**: ids are opaque (`p-` plus 10 base32 characters) because agents address projects by name. Each new project gets the least used colour of the device palette.
- **Archive**: archived projects stay in the list with `archived: true`. Sending to one unarchives it and bumps its `version`.
- **Legacy rows**: handoffs saved before `0006` carry only a name. The first project read of a workspace (`GET /api/projects` or a `project` filter) files them under projects, creating missing ones; it is idempotent.
- **Concurrency**: `PATCH`, `DELETE` and merge require the latest `version` and return 409 when it is stale. At most 500 projects per workspace.
- **Web UI**: inbox rows and the detail footer show a project tag (a square swatch in the project's colour). The inbox has a project filter next to the device filter, counting the current tab's handoffs. The compose form starts with no project; its picker lists projects by last use, matches typed names by key, and offers to create a new one, which the server does on send. The folder button beside the filter opens **Manage projects** (rename, merge into another project, archive or unarchive, delete; nothing there deletes a handoff), and Storage's project filter is a select of the registry that sends the project id. `npm run test:e2e:projects` drives these flows in a real browser (EN/ZH, dark, 390 px).

| Route | Request | Success | Errors |
| :--- | :--- | :--- | :--- |
| `GET /api/projects` | — | 200 `{ projects }`, most recently used first | 401 |
| `POST /api/projects` | `{ name, line? }` | 201 `Project` | 400, 401, 403, 409 (same name key, or 500 projects), 413 |
| `PATCH /api/projects/:id` | `{ version, name?, line?, archived? }` | 200 `Project` | 400, 401, 403, 404, 409 (stale, or the name key of another project) |
| `POST /api/projects/:id/merge` | `{ version, into }` | 200 `{ id, into, movedHandoffs }` | 400, 401, 403, 404, 409 |
| `DELETE /api/projects/:id` | `{ version }` | 200 `{ id, detachedHandoffs }` | 400, 401, 403, 404, 409 |
