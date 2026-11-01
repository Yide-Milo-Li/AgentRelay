import type { Handoff } from "@/shared/contracts/handoffs";
import { deviceNameKey } from "@/shared/formatting/device-identity";

/**
 * What this browser remembers about setup for this Site. `plugin` and `others` hold the person's own statements (the
 * page cannot see plugin connections), kept apart from what the server shows; `done` and `dismissed` end the checklist.
 */
export type SetupRecord = { done?: boolean; dismissed?: boolean; plugin?: string[]; others?: string[] };
export type SetupStepId = "device" | "agent" | "nextDevice" | "handoff";
/** `selfReported` marks a step done only because the person said so in this browser. */
export type SetupStep = { id: SetupStepId; done: boolean; selfReported: boolean };

type Row = Pick<Handoff, "status" | "sourceDevice" | "sourceDeviceId" | "claimedBy" | "claimedByDeviceId">;

/** A handoff claimed (and maybe finished) on a device other than the one that sent it: two devices have worked together. */
export function claimedElsewhere(row: Row) {
  if (row.status !== "claimed" && row.status !== "done") return false;
  if (row.claimedByDeviceId && row.sourceDeviceId) return row.claimedByDeviceId !== row.sourceDeviceId;
  return !!row.claimedBy && deviceNameKey(row.claimedBy) !== deviceNameKey(row.sourceDevice);
}

/** The loaded handoffs prove the workspace is past setup: a cross-device claim, or any finished handoff. */
export function setupEstablished(rows: readonly Row[]) {
  return rows.some(row => row.status === "done" || claimedElsewhere(row));
}

/**
 * The four steps for this browser. `connected` is the set of devices with a usable connection whose credential has been
 * used (null while unknown). Server evidence wins over a statement; a statement is only ever reported as one.
 */
export function setupSteps({ currentId, connected, record, rows }: {
  currentId: string | null; connected: ReadonlySet<string> | null; record: SetupRecord; rows: readonly Row[];
}): SetupStep[] {
  const evidence = connected ?? new Set<string>(), plugin = record.plugin ?? [], others = record.others ?? [];
  const here = !!currentId && evidence.has(currentId), herePlugin = !!currentId && plugin.includes(currentId);
  // Without a current device every connected device is someone else's; with one, only the others count.
  const elsewhere = [...evidence].filter(id => id !== currentId).length > (currentId ? 0 : 1);
  const elsewhereSaid = plugin.some(id => id !== currentId) || (!!currentId && others.includes(currentId));
  return [
    { id: "device", done: !!currentId, selfReported: false },
    { id: "agent", done: here || herePlugin, selfReported: !here && herePlugin },
    { id: "nextDevice", done: elsewhere || elsewhereSaid, selfReported: !elsewhere && elsewhereSaid },
    { id: "handoff", done: rows.some(claimedElsewhere), selfReported: false },
  ];
}
