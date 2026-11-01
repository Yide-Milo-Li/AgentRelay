"use client";
import { TriangleAlert } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { CONNECTION_EXPIRING_DAYS, CONNECTION_STALE_DAYS } from "@/shared/contracts/agent-tokens";
import type { AttentionSummary } from "@/features/agent-access/connection-view";

/** Suggests what to review; reviewing only filters the list and never revokes anything. */
export default function HygieneBanner({ summary, onReview }: { summary: AttentionSummary; onReview: () => void }) {
  const { t } = useLang();
  if (!summary.total) return null;
  const parts = [
    summary.unused ? t.connAttentionUnused(summary.unused) : null,
    summary.stale ? t.connAttentionStale(summary.stale, CONNECTION_STALE_DAYS) : null,
    summary.expiring ? t.connAttentionExpiring(summary.expiring, CONNECTION_EXPIRING_DAYS) : null,
  ].filter(Boolean);
  return <div className="banner warn conn-attention" role="status"><TriangleAlert size={16} aria-hidden="true" />
    <span><strong>{t.connAttentionTitle(summary.total)}</strong> · {parts.join(" · ")}</span>
    <button type="button" className="link" onClick={onReview}>{t.connAttentionReview}</button></div>;
}
