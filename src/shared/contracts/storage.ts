import type { CleanupSummary } from "./attachments";
import type { Handoff } from "./handoffs";

export const STORAGE_PAGE_SIZE = 50;
export const DEFAULT_STORAGE_LIMIT_BYTES = 10_000_000_000;
export const STORAGE_CATEGORIES = ["ready", "claimed", "done", "expired"] as const;
export const STORAGE_SORTS = ["largest", "smallest", "oldest", "newest", "updated"] as const;
export type StorageCategory = typeof STORAGE_CATEGORIES[number];
export type StorageSort = typeof STORAGE_SORTS[number];
/** `logicalBytes` is prompt text (with any completion receipt) plus attached image bytes: the size every storage sort, filter and total uses. */
export type StorageGroup = { count: number; promptBytes: number; imageCount: number; imageBytes: number; logicalBytes: number };
export type StorageSummary = {
  databaseBytes: number | null;
  limitBytes: number;
  measuredAt: number;
  handoffs: StorageGroup;
  groups: Record<StorageCategory, StorageGroup>;
  /** Image objects live in R2, not D1: they are reported next to the database meter and never counted against it. */
  imageStorage: CleanupSummary;
};
export type StorageFilters = {
  search: string;
  status: "all" | "ready" | "claimed" | "done";
  expiration: "all" | "unexpired" | "expired";
  project: string;
  sourceDevice: string;
  targetDevice: string;
  ageDays: 0 | 30 | 90 | 365;
  minBytes: number;
  sort: StorageSort;
};
export const DEFAULT_STORAGE_FILTERS: StorageFilters = {
  search: "", status: "all", expiration: "all", project: "", sourceDevice: "", targetDevice: "",
  ageDays: 0, minBytes: 0, sort: "largest",
};
export type StorageHandoff = Omit<Handoff, "content" | "attachments"> & { promptBytes: number; attachmentCount: number; imageBytes: number; logicalBytes: number };
export type StoragePage = {
  handoffs: StorageHandoff[];
  nextCursor: string | null;
  totalCount: number;
  asOf: number;
  suggestions: { projects: string[]; sourceDevices: string[]; targetDevices: string[] };
};
export type HandoffDeletion = { id: string; version: number };
export type StorageDeletionResult = {
  results: { id: string; status: "deleted" | "conflict" | "not_found" }[];
  deletedCount: number;
};
