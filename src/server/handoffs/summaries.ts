import type { Handoff, HandoffListItem, HandoffSummary } from "@/shared/contracts/handoffs";

type RequiredFields = Pick<HandoffSummary, "id" | "title" | "status" | "version" | "sourceDevice" | "targetDevice" | "createdAt" | "updatedAt">;
/** The fields a summary is built from, whether they come from a full record or from the list query's columns. */
export type SummarySource = RequiredFields & { [K in Exclude<keyof HandoffSummary, keyof RequiredFields>]: HandoffSummary[K] | null | undefined };

export const PREVIEW_CHARACTERS = 180;

/** Null, empty and zero-image fields are left out: an absent field means none. */
export function toSummary(source: SummarySource): HandoffSummary {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === "" || (key === "attachmentCount" && value === 0)) continue;
    summary[key] = value;
  }
  return summary as HandoffSummary;
}

/** The agent-facing result of a write: everything but the prompt, the receipt and the image manifest. */
export function summarizeHandoff(handoff: Handoff): HandoffSummary {
  return toSummary({ id: handoff.id, title: handoff.title, status: handoff.status, version: handoff.version,
    sourceDevice: handoff.sourceDevice, targetDevice: handoff.targetDevice, createdAt: handoff.createdAt, updatedAt: handoff.updatedAt,
    expiresAt: handoff.expiresAt, project: handoff.project, projectId: handoff.projectId, sourceDeviceId: handoff.sourceDeviceId,
    targetDeviceId: handoff.targetDeviceId, claimedBy: handoff.claimedBy, claimedByDeviceId: handoff.claimedByDeviceId,
    createdByName: handoff.createdByName, replyToId: handoff.replyToId, threadId: handoff.threadId, branch: handoff.branch,
    baseCommit: handoff.baseCommit, attachmentCount: handoff.attachments.length });
}

/** A list row from SQL columns; the previews and sizes are computed by SQLite, so no full prompt reaches the Worker. */
export function listItem(source: SummarySource & { preview: string; characters: number; resultPreview: string | null; resultCharacters: number | null }): HandoffListItem {
  const { preview, characters, resultPreview, resultCharacters, ...fields } = source;
  return { ...toSummary(fields), preview, characters, ...(resultCharacters ? { resultPreview: resultPreview ?? "", resultCharacters } : {}) };
}
