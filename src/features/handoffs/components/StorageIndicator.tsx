"use client";
import { HardDrive } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { StorageSummary } from "@/shared/contracts/storage";
import { formatStorageBytes, storageUsage } from "../storage-formatting";

export default function StorageIndicator({ summary, stale, onOpen }: { summary: StorageSummary | null; stale: boolean; onOpen: () => void }) {
  const { t, locale } = useLang();
  const { tone } = storageUsage(summary?.databaseBytes ?? null, summary?.limitBytes ?? 1);
  return <button className="storage-indicator" data-tone={tone} onClick={onOpen} title={stale ? t.storage.stale : t.storage.title}
    aria-label={`${t.storage.title}: ${summary?.databaseBytes == null ? t.storage.unavailable : formatStorageBytes(summary.databaseBytes, locale)}${stale ? ` · ${t.storage.stale}` : ""}`}>
    <HardDrive size={14} aria-hidden="true" /><span className="tnum">{summary?.databaseBytes == null ? "—" : formatStorageBytes(summary.databaseBytes, locale)}{stale ? " *" : ""}</span>
  </button>;
}
