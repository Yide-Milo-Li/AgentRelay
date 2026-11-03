import { HANDOFF_LIST, type Handoff, type HandoffListItem, type HandoffListScope } from "@/shared/contracts/handoffs";

/**
 * What the inbox list shows, as the server filters it. `target` and `project` use the filter values of the inbox
 * controls: `all`, `any` (handoffs for any device) or `d:<device id>`; `all`, `none` or `p:<project id>`.
 */
export type InboxQuery = { scope: HandoffListScope; status: "all" | "ready" | "claimed"; target: string; project: string; q: string };

/** The summary list request for a query: `limit` rows from the top, or the page after `cursor`. */
export function listPath(query: InboxQuery, { limit, cursor = null }: { limit: number; cursor?: string | null }) {
  const params = new URLSearchParams({ view: "summary", scope: query.scope });
  if (query.scope === "open" && query.status !== "all") params.set("status", query.status);
  if (query.target === "any") params.set("target", "any");
  else if (query.target.startsWith("d:")) params.set("target", query.target.slice(2));
  if (query.project === "none") params.set("project", "none");
  else if (query.project.startsWith("p:")) params.set("project", query.project.slice(2));
  // Searched as typed, spaces included, as the browser did before; only blank text means no search.
  if (query.q.trim()) params.set("q", query.q.slice(0, HANDOFF_LIST.searchCharacters));
  params.set("limit", String(Math.min(Math.max(limit, 1), HANDOFF_LIST.maxLimit)));
  if (cursor) params.set("cursor", cursor);
  return `/api/handoffs?${params}`;
}

/** The project counts request for a scope, or for both (Manage projects). */
export const projectCountsPath = (scope: HandoffListScope | "all") => `/api/handoffs?view=project-counts&scope=${scope}`;

/** A full record as a list row, as the server builds one: for the in-app sample and for what a write returns. */
export function listItemOf(handoff: Handoff): HandoffListItem {
  const optional = {
    expiresAt: handoff.expiresAt, project: handoff.project, projectId: handoff.projectId, sourceDeviceId: handoff.sourceDeviceId,
    targetDeviceId: handoff.targetDeviceId, claimedBy: handoff.claimedBy, claimedByDeviceId: handoff.claimedByDeviceId,
    createdByName: handoff.createdByName, replyToId: handoff.replyToId, threadId: handoff.threadId, branch: handoff.branch,
    baseCommit: handoff.baseCommit, attachmentCount: handoff.attachments.length || null,
  };
  // An absent field means none, as on the wire: null, empty and zero values are left out.
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  const content = [...handoff.content], result = handoff.result ? [...handoff.result] : null;
  return {
    id: handoff.id, title: handoff.title, status: handoff.status, version: handoff.version, sourceDevice: handoff.sourceDevice,
    targetDevice: handoff.targetDevice, createdAt: handoff.createdAt, updatedAt: handoff.updatedAt, ...present,
    // Counted in code points, as SQLite counts characters.
    preview: content.slice(0, 180).join(""), characters: content.length,
    ...(result ? { resultPreview: result.slice(0, 180).join(""), resultCharacters: result.length } : {}),
  };
}

/** Whether a row with this status belongs to the list a query shows: its scope and, in the inbox, its status chip. */
export function inList(status: string, query: InboxQuery) {
  if (query.scope === "done") return status === "done";
  return status !== "done" && (query.status === "all" || status === query.status);
}

/** Replace the list row of a record a write returned; it leaves the list if it no longer belongs there. */
export function withWrite(rows: readonly HandoffListItem[], handoff: Handoff, query: InboxQuery) {
  const item = listItemOf(handoff);
  return rows.flatMap(row => row.id !== item.id ? [row] : inList(item.status, query) ? [item] : []);
}
