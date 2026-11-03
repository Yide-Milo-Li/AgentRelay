import type { AttachmentInfo } from "./attachments";

/** Browser-safe wire shape; persisted owner and request-key fields stay server-side. */
export type Handoff = { id: string; title: string; project: string; sourceDevice: string; targetDevice: string; content: string;
  status: string; claimedBy: string | null; createdAt: number; updatedAt: number; expiresAt: number | null; version: number;
  /** Registry ids behind the snapshot names above; absent for sample rows and unregistered devices. */
  sourceDeviceId?: string | null; targetDeviceId?: string | null; claimedByDeviceId?: string | null;
  /** Registry id behind `project`; null for no project and for older rows not filed yet, absent for sample rows. */
  projectId?: string | null;
  /** Display name of the signed-in member or Agent Token issuer who sent it; absent for older and sample rows. */
  createdByName?: string | null;
  /** Ordered image metadata, never bytes; empty for text-only and older handoffs. */
  attachments: AttachmentInfo[];
  /** The completion receipt, untrusted Markdown text like the prompt; null until a completion writes one. Absent for sample rows. */
  result?: string | null;
  /** The handoff this one replies to, and the root of its thread; both null for a handoff that starts its own thread. */
  replyToId?: string | null; threadId?: string | null;
  /**
   * The code state the sender stopped at: a branch name and the full object id of its HEAD. Untrusted text like the
   * prompt, set only on creation; null when the sender gave none, absent for sample rows.
   */
  branch?: string | null; baseCommit?: string | null;
  /** The whole thread as metadata, present only when one handoff is read; null when it has no replies and is no reply. */
  thread?: HandoffThread | null };

/**
 * What an agent gets back from a write and in each list row: route, lifecycle and code state without the prompt, the
 * receipt or the image manifest, which `get_handoff` returns. Empty fields are left out to keep agent context small.
 */
export type HandoffSummary = { id: string; title: string; status: string; version: number; sourceDevice: string; targetDevice: string;
  createdAt: number; updatedAt: number; expiresAt?: number; project?: string; projectId?: string; sourceDeviceId?: string;
  targetDeviceId?: string; claimedBy?: string; claimedByDeviceId?: string; createdByName?: string; replyToId?: string;
  threadId?: string; branch?: string; baseCommit?: string; attachmentCount?: number };
/** One `list_handoffs` row: the summary plus bounded previews of the prompt and, when there is one, the receipt. */
export type HandoffListItem = HandoffSummary & { preview: string; characters: number; resultPreview?: string; resultCharacters?: number };

/** Limits that the server enforces and agents and the browser read. */
export const HANDOFF_LIMITS = { resultCharacters: 20000, threadSize: 100, titleCharacters: 160, branchCharacters: 200 } as const;

/**
 * The browser's inbox list (`GET /api/handoffs?view=summary`): `open` is the inbox (ready and claimed), `done` the
 * Done view. Rows are newest first; `limit` may cover pages already loaded, up to the 500-handoff window.
 */
export type HandoffListScope = "open" | "done";
export const HANDOFF_LIST = { pageSize: 50, maxLimit: 500, searchCharacters: 200 } as const;
/** One page of the inbox list: the same rows `list_handoffs` returns, the cursor of the next page, and the inbox badge. */
export type HandoffListPage = { handoffs: HandoffListItem[]; nextCursor: string | null; counts: { open: number } };
/** Handoffs per project id in a scope (`GET /api/handoffs?view=project-counts`); `none` counts those without a project. */
export type HandoffProjectCounts = { projects: Record<string, number> };

/** One handoff in a thread. Content and result are read one handoff at a time. */
export type HandoffThreadItem = { id: string; title: string; status: string; sourceDevice: string; targetDevice: string;
  replyToId: string | null; createdAt: number; hasResult: boolean;
  /** Registry ids behind the route names, so a thread shows each device in its colour; null for unregistered devices. */
  sourceDeviceId?: string | null; targetDeviceId?: string | null };
/** Active handoffs of a thread, oldest first. A root that expired or was deleted is simply missing from `items`. */
export type HandoffThread = { rootId: string; items: HandoffThreadItem[] };
