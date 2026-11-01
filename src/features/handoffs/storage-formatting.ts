import type { StorageSummary } from "@/shared/contracts/storage";

/** Decimal units match the configured 10 GB display limit; prompt sizes count UTF-8 bytes. */
export function formatStorageBytes(bytes: number, locale = "en-US") {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(Math.max(1, bytes)) / 3)));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 2 }).format(bytes / 1000 ** unit)} ${units[unit]}`;
}

export function storageUsage(databaseBytes: number | null, limitBytes: number) {
  const percent = databaseBytes === null ? null : databaseBytes / limitBytes * 100;
  return { percent, tone: percent !== null && percent >= 95 ? "danger" : percent !== null && percent >= 80 ? "warn" : "normal" } as const;
}

export const STORAGE_KINDS = ["text", "database", "images", "pending"] as const;
export type StorageKind = typeof STORAGE_KINDS[number];
/** `bytes` is null when the size cannot be measured, which is different from an empty store. */
export type StorageSlice = { kind: StorageKind; bytes: number | null };

/**
 * Splits everything the instance stores into the kinds drawn on the composition bar. Prompt text lives inside the D1
 * file, so the rest of the file (indexes, metadata, reusable pages) is its measured size minus the text. Image bytes and
 * uploads awaiting cleanup live in R2, which has no fixed limit and never counts against the database quota.
 */
export function storageComposition(summary: StorageSummary) {
  const text = summary.handoffs.promptBytes;
  const database = summary.databaseBytes === null ? null : Math.max(0, summary.databaseBytes - text);
  const pending = summary.imageStorage.unattached.bytes + summary.imageStorage.pendingCleanup.bytes;
  const slices: StorageSlice[] = [
    { kind: "text", bytes: text }, { kind: "database", bytes: database },
    { kind: "images", bytes: summary.handoffs.imageBytes }, { kind: "pending", bytes: pending },
  ];
  const total = slices.reduce((sum, slice) => sum + (slice.bytes ?? 0), 0);
  return { slices, total, objectBytes: summary.handoffs.imageBytes + pending };
}

/** A share of the bar as a percentage; a non-zero share too small to round is shown as "<0.1%" rather than 0%. */
export function formatShare(bytes: number, total: number, locale = "en-US") {
  if (total <= 0 || bytes <= 0) return `${new Intl.NumberFormat(locale).format(0)}%`;
  const percent = bytes / total * 100, format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return percent < 0.1 ? `<${format.format(0.1)}%` : `${format.format(percent)}%`;
}
