"use client";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import InfoTip from "@/components/ui/InfoTip";
import { formatTime } from "@/shared/formatting/date";
import type { StorageSummary } from "@/shared/contracts/storage";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";
import { formatShare, formatStorageBytes, storageComposition, storageUsage, type StorageKind } from "../storage-formatting";

// On a standalone Cloudflare deployment R2 is billed above a free allowance, and the D1 limit depends on the plan.
const CLOUDFLARE = DEPLOYMENT_TARGET === "cloudflare";

type Props = { summary: StorageSummary | null; summaryError: unknown };

/**
 * One bar for everything stored, split by type, and one quota row per platform limit. D1 and R2 have separate limits
 * (10 GB and none), so the composition bar shows shares of the stored total and only the D1 row is drawn against a cap.
 */
export default function StorageOverview({ summary, summaryError }: Props) {
  const { t, locale, errorText } = useLang(), s = t.storage;
  const [focus, setFocus] = useState<StorageKind | null>(null);
  const bytes = (value: number) => formatStorageBytes(value, locale);
  const composition = summary ? storageComposition(summary) : null;
  // Uploads awaiting cleanup are transient, so their row only appears while there is something to clean.
  const slices = composition?.slices.filter(slice => slice.kind !== "pending" || (slice.bytes ?? 0) > 0) ?? [];
  const drawn = slices.filter(slice => (slice.bytes ?? 0) > 0);
  const { percent, tone } = storageUsage(summary?.databaseBytes ?? null, summary?.limitBytes ?? 1);
  const percentText = percent === null ? s.unavailable : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(percent)}%`;
  const share = (value: number) => formatShare(value, composition?.total ?? 0, locale);
  const hover = (kind: StorageKind) => ({ onMouseEnter: () => setFocus(kind), onMouseLeave: () => setFocus(null) });

  return <section className="storage-overview" aria-labelledby="storage-usage-title" data-tone={tone}>
    <div className="storage-usage-head"><h2 id="storage-usage-title" className="storage-total-label">{s.usage}</h2>
      {/* How the 10 GB is counted: needed once, so it waits behind the button instead of under the meters. */}
      <InfoTip label={t.infoAbout(s.usage)}><p>{CLOUDFLARE ? s.measurementNoteAccess : s.measurementNote}</p></InfoTip></div>
    <p className="storage-total tnum">{composition ? bytes(composition.total) : s.measuring}</p>
    {/* Each segment grows in proportion to its bytes but never below the CSS minimum width, so a type that is a tiny
        fraction of the total stays visible; flexbox hands the width it borrows back out proportionally from the others. */}
    <div className="storage-composition" aria-hidden="true" data-focus={focus ?? undefined}>
      {drawn.map(slice => <span key={slice.kind} className="storage-segment" data-kind={slice.kind} data-active={focus === slice.kind || undefined}
        style={{ flexGrow: slice.bytes ?? 0 }} title={`${s.kinds[slice.kind]} · ${bytes(slice.bytes ?? 0)} · ${share(slice.bytes ?? 0)}`} {...hover(slice.kind)} />)}
    </div>
    <ul className="storage-legend" aria-label={s.composition} data-focus={focus ?? undefined}>
      {(composition ? slices : []).map(slice => <li key={slice.kind} data-kind={slice.kind} data-active={focus === slice.kind || undefined} {...hover(slice.kind)}>
        <span className="storage-swatch" aria-hidden="true" /><span className="storage-legend-name">{s.kinds[slice.kind]}</span>
        <span className="tnum">{slice.bytes === null ? s.unavailable : bytes(slice.bytes)}</span>
        <span className="tnum storage-legend-share">{slice.bytes === null ? "—" : share(slice.bytes)}</span></li>)}
    </ul>
    <h3 className="storage-limits-title">{s.limits}</h3>
    <div className="storage-quota">
      <span>{s.databaseQuota}</span>
      <span className="storage-meter-value tnum">{summary?.databaseBytes == null ? s.unavailable : s.capacity(bytes(summary.databaseBytes), bytes(summary.limitBytes))}</span>
      <span className="tnum storage-quota-percent">{percentText}</span>
      {/* A non-zero usage keeps a sliver so "almost empty" never looks identical to "unmeasured". */}
      <div className="storage-meter" role="progressbar" aria-label={s.databaseQuota} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.min(100, percent)} aria-valuetext={percentText}>
        <span style={{ width: percent ? `max(3px, ${Math.min(100, percent)}%)` : 0 }} /></div>
    </div>
    <div className="storage-quota">
      <span>{s.objectQuota}</span>
      <span className="tnum">{composition ? bytes(composition.objectBytes) : "—"}</span>
      <span className="storage-quota-percent">{CLOUDFLARE ? s.r2Allowance : s.noFixedLimit}</span>
    </div>
    <div className="storage-measurement"><span>{summary ? s.measured(formatTime(summary.measuredAt, locale)) : s.measuring}</span>
      {tone !== "normal" && <span className="storage-warning"><TriangleAlert size={14} aria-hidden="true" />{tone === "danger" ? s.critical : s.warning}</span>}</div>
    {!!summaryError && <p className="storage-warning" role="alert">{summary ? s.stale : errorText(summaryError)}</p>}
  </section>;
}
