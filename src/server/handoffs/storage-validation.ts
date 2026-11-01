import { AgentRelayError } from "@/server/core/agent-relay-error";
import { DEFAULT_STORAGE_FILTERS, STORAGE_PAGE_SIZE, STORAGE_SORTS, type HandoffDeletion, type StorageFilters } from "@/shared/contracts/storage";

/** Version 2 sorts by prompt text plus image bytes; cursors from the text-only ordering are refused rather than misread. */
export const STORAGE_CURSOR_VERSION = 2;
export type StorageCursor = { v: number; value: number; id: string; asOf: number; filters: string };
const invalid = () => new AgentRelayError("Invalid storage filters or cursor.");

function text(params: URLSearchParams, key: string, max: number) {
  const value = (params.get(key) ?? "").trim();
  if (value.length > max) throw invalid();
  return value;
}
function choice<T extends string>(value: string | null, choices: readonly T[], fallback: T): T {
  if (value === null) return fallback;
  if (!choices.includes(value as T)) throw invalid();
  return value as T;
}
function integer(value: string | null, fallback: number) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
  return Number(value);
}

export function storageFilterKey(filters: StorageFilters) { return JSON.stringify(filters); }

/** Cursors bind the sort position and time-based filters to the exact query that produced them. */
export function parseStorageQuery(params: URLSearchParams, now = Date.now()) {
  const ageDays = integer(params.get("ageDays"), 0);
  if (![0, 30, 90, 365].includes(ageDays)) throw invalid();
  const filters: StorageFilters = {
    ...DEFAULT_STORAGE_FILTERS,
    search: text(params, "search", 280), project: text(params, "project", 120),
    sourceDevice: text(params, "sourceDevice", 80), targetDevice: text(params, "targetDevice", 80),
    status: choice(params.get("status"), ["all", "ready", "claimed", "done"], "all"),
    expiration: choice(params.get("expiration"), ["all", "unexpired", "expired"], "all"),
    sort: choice(params.get("sort"), STORAGE_SORTS, "largest"),
    ageDays: ageDays as StorageFilters["ageDays"], minBytes: integer(params.get("minBytes"), 0),
  };
  let cursor: StorageCursor | null = null;
  const raw = params.get("cursor");
  if (raw !== null) {
    if (!raw || raw.length > 12_000) throw invalid();
    try { cursor = JSON.parse(decodeURIComponent(raw)) as StorageCursor; } catch { throw invalid(); }
    if (!cursor || cursor.v !== STORAGE_CURSOR_VERSION || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 128
      || !Number.isSafeInteger(cursor.value) || cursor.value < 0 || !Number.isSafeInteger(cursor.asOf)
      || cursor.asOf < 0 || cursor.asOf > now || cursor.filters !== storageFilterKey(filters)) throw invalid();
  }
  return { filters, cursor, asOf: cursor?.asOf ?? now };
}

export function encodeStorageCursor(cursor: StorageCursor) { return encodeURIComponent(JSON.stringify(cursor)); }

export function observedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new AgentRelayError("A current positive integer version is required.");
  return value;
}

export function parseHandoffDeletions(input: Record<string, unknown>): HandoffDeletion[] {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > STORAGE_PAGE_SIZE)
    throw new AgentRelayError("Select between 1 and 50 handoffs.");
  const ids = new Set<string>();
  return input.items.map(item => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id))
      throw new AgentRelayError("Handoff IDs must be unique, non-empty strings.");
    ids.add(item.id);
    return { id: item.id, version: observedVersion(item.version) };
  });
}
