import type { DeviceLine } from "./devices";

/** Browser-safe project registry contracts. Projects reuse the device colour palette. */
export const PROJECT_NAME_MAX = 120;
export const MAX_PROJECTS = 500;

export type ProjectLine = DeviceLine;
/** `lastUsedAt` moves whenever a handoff is sent to the project; archived projects are hidden from pickers, not deleted. */
export type Project = { id: string; name: string; line: ProjectLine; archived: boolean; lastUsedAt: number;
  createdAt: number; updatedAt: number; version: number };
export type MergedProject = { id: string; into: Project; movedHandoffs: number };
export type DeletedProject = { id: string; detachedHandoffs: number };
