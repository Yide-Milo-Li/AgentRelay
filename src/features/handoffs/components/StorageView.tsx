"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownWideNarrow, ChevronLeft, ChevronRight, RefreshCw, Search, Trash2, TriangleAlert } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import InfoTip from "@/components/ui/InfoTip";
import { api } from "@/shared/http/client";
import { formatDay } from "@/shared/formatting/date";
import { DEFAULT_STORAGE_FILTERS, STORAGE_CATEGORIES, STORAGE_SORTS, type StorageFilters, type StorageHandoff, type StoragePage, type StorageSummary, type StorageDeletionResult } from "@/shared/contracts/storage";
import type { Handoff } from "@/shared/contracts/handoffs";
import type { Project } from "@/shared/contracts/projects";
import type { CleanupResult } from "@/shared/contracts/attachments";
import { formatStorageBytes } from "../storage-formatting";
import { StorageDeleteDialog, StoragePreviewDialog } from "./StorageDialogs";
import StorageOverview from "./StorageOverview";

type Props = { summary: StorageSummary | null; summaryError: unknown; refreshSummary: () => Promise<void>; onDeleted: () => Promise<void>;
  /** The project registry; the project filter sends a project id. */
  projects: readonly Project[] };

export default function StorageView({ summary, summaryError, refreshSummary, onDeleted, projects }: Props) {
  const { t, locale, errorText } = useLang(), s = t.storage;
  const [filters, setFilters] = useState<StorageFilters>(DEFAULT_STORAGE_FILTERS);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [revision, setRevision] = useState(0), [page, setPage] = useState<StoragePage | null>(null), [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState<unknown>(null), [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, StorageHandoff>>({});
  const [confirmation, setConfirmation] = useState<StorageHandoff[] | null>(null), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ row: Handoff | null; error: string | null } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const deleteFlight = useRef(false), previewRequest = useRef<AbortController | null>(null), selectPage = useRef<HTMLInputElement>(null);
  const params = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
  const cursor = cursors.at(-1); if (cursor) params.set("cursor", cursor);
  const query = params.toString(), requestKey = `${query}#${revision}`;
  const loading = loadedKey !== requestKey;
  const rows = Object.values(selected), selectedBytes = rows.reduce((sum, row) => sum + row.logicalBytes, 0);
  const visible = loading ? [] : page?.handoffs ?? [];
  const selectedOnPage = visible.filter(row => selected[row.id]).length;
  const bytes = (value: number) => formatStorageBytes(value, locale);

  useEffect(() => {
    const controller = new AbortController();
    api<StoragePage>(`/api/storage/handoffs?${query}`, "GET", undefined, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setPage(value); setLoadedKey(requestKey); setError(null); }
    }, failure => { if (!controller.signal.aborted) { setError(failure); setLoadedKey(requestKey); setPage(null); } });
    return () => controller.abort();
  }, [query, requestKey]);
  useEffect(() => {
    if (selectPage.current) selectPage.current.indeterminate = selectedOnPage > 0 && selectedOnPage < visible.length;
  }, [selectedOnPage, visible.length]);
  useEffect(() => () => previewRequest.current?.abort(), []);

  function change(patch: Partial<StorageFilters>) {
    setFilters(previous => ({ ...previous, ...patch })); setCursors([null]); setSelected({}); setNotice(null);
  }
  function preset(patch: Partial<StorageFilters>) {
    setFilters({ ...DEFAULT_STORAGE_FILTERS, ...patch }); setCursors([null]); setSelected({}); setNotice(null);
  }
  function move(next: (string | null)[]) { setCursors(next); setSelected({}); setNotice(null); }
  const refresh = useCallback(() => { setRevision(value => value + 1); void refreshSummary(); }, [refreshSummary]);
  function toggle(row: StorageHandoff) {
    setSelected(previous => {
      if (previous[row.id]) { const next = { ...previous }; delete next[row.id]; return next; }
      return Object.keys(previous).length < 50 ? { ...previous, [row.id]: row } : previous;
    });
    setNotice(null);
  }
  function closePreview() { previewRequest.current?.abort(); setPreview(null); }
  async function openPreview(id: string) {
    previewRequest.current?.abort();
    const controller = new AbortController(); previewRequest.current = controller;
    setPreview({ row: null, error: null });
    try {
      const row = await api<Handoff>(`/api/storage/handoffs/${encodeURIComponent(id)}`, "GET", undefined, { signal: controller.signal });
      if (!controller.signal.aborted) setPreview({ row, error: null });
    } catch (failure) { if (!controller.signal.aborted) setPreview({ row: null, error: errorText(failure) }); }
  }
  async function runCleanup() {
    setCleaning(true); setNotice(null);
    try {
      const result = await api<CleanupResult>("/api/storage/cleanup", "POST", {});
      setNotice(s.cleanupResult(result.reclaimedUploads, result.deletedObjects, result.pendingCleanup.count));
      await refreshSummary();
    } catch (failure) { setError(failure); } finally { setCleaning(false); }
  }
  async function remove() {
    if (!confirmation || deleteFlight.current) return;
    deleteFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await api<StorageDeletionResult>("/api/storage/handoffs/delete", "POST",
        { items: confirmation.map(({ id, version }) => ({ id, version })) }, { acceptStatuses: [409] });
      if (!Array.isArray(result.results)) throw new Error("Invalid deletion response");
      const deleted = new Set(result.results.filter(item => item.status === "deleted").map(item => item.id));
      setSelected(Object.fromEntries(confirmation.filter(row => !deleted.has(row.id)).map(row => [row.id, row])));
      const failed = result.results.length - result.deletedCount;
      setNotice(failed ? s.partialResult(result.deletedCount, failed) : s.deletedResult(result.deletedCount));
      setConfirmation(null); setRevision(value => value + 1);
      await onDeleted();
    } catch {
      // A lost response cannot prove whether the delete committed. Refresh reads, never retry the write.
      setConfirmation(null); setNotice(s.uncertainResult); setRevision(value => value + 1);
      await onDeleted();
    } finally { deleteFlight.current = false; setBusy(false); }
  }

  return <section className="storage-view" aria-labelledby="storage-title">
    <header className="storage-heading"><div><h2 id="storage-title">{s.title}</h2><p>{s.subtitle}</p></div>
      <button className="btn" onClick={refresh} disabled={busy}><RefreshCw size={15} aria-hidden="true" />{t.refresh}</button></header>
    <StorageOverview summary={summary} summaryError={summaryError} />
    <section className="storage-images" aria-labelledby="storage-images-title">
      <div className="storage-images-head"><div className="storage-images-title"><h2 id="storage-images-title">{s.imageStorage}</h2><InfoTip label={t.infoAbout(s.imageStorage)}><p>{s.imageStorageNote}</p></InfoTip></div>
        <button className="btn small" onClick={() => void runCleanup()} disabled={busy || cleaning || !summary}>{cleaning ? s.cleaning : s.runCleanup}</button></div>
      <p className="tnum">{summary ? s.imageTotal(summary.handoffs.imageCount, bytes(summary.handoffs.imageBytes)) : s.measuring}</p>
      {summary && summary.imageStorage.unattached.count > 0 && <p className="tnum">{s.unattached(summary.imageStorage.unattached.count, bytes(summary.imageStorage.unattached.bytes))}</p>}
      {summary && (summary.imageStorage.pendingCleanup.count > 0
        ? <p className="storage-warning" role="status"><TriangleAlert size={14} aria-hidden="true" />{s.pendingCleanup(summary.imageStorage.pendingCleanup.count, bytes(summary.imageStorage.pendingCleanup.bytes))}
          {summary.imageStorage.pendingCleanup.failing > 0 && ` ${s.cleanupFailing(summary.imageStorage.pendingCleanup.failing)}`}</p>
        : <p className="muted">{s.cleanupNone}</p>)}
    </section>
    <dl className="storage-groups" aria-label={s.promptBreakdown}>
      {STORAGE_CATEGORIES.map(category => <div key={category}><dt>{category === "expired" ? s.expired : t.status[category]}</dt>
        <dd className="tnum">{summary ? bytes(summary.groups[category].logicalBytes) : "—"}</dd>
        <dd>{summary ? t.count(summary.groups[category].count) : s.measuring}</dd></div>)}
    </dl>
    <section className="storage-manager" aria-labelledby="storage-manage-title">
      <div className="storage-manager-heading"><div><h2 id="storage-manage-title">{s.manage}</h2><p>{s.manageNote}</p></div>
        <span className="tnum" aria-live="polite">{loading ? t.working : page ? s.matches(page.totalCount) : ""}</span></div>
      <fieldset className="storage-controls" disabled={busy}>
        <legend className="sr-only">{s.filters}</legend>
        <div className="storage-presets" role="group" aria-label={s.shortcuts}>
          <button className="btn small" onClick={() => preset({ status: "done", ageDays: 30 })}>{s.oldCompleted}</button>
          <button className="btn small" onClick={() => preset({ sort: "largest" })}><ArrowDownWideNarrow size={14} aria-hidden="true" />{s.largestPrompts}</button>
          <button className="link" onClick={() => preset({})}>{s.reset}</button>
        </div>
        <div className="storage-filters storage-primary-filters">
          <label className="field storage-search">{s.search}<span className="storage-search-input"><Search size={15} aria-hidden="true" /><input type="search" value={filters.search} maxLength={280} onChange={event => change({ search: event.target.value })} /></span></label>
          <label className="field">{s.status}<select value={filters.status} onChange={event => change({ status: event.target.value as StorageFilters["status"] })}>
            <option value="all">{t.statusAll}</option>{["ready", "claimed", "done"].map(status => <option key={status} value={status}>{t.status[status]}</option>)}</select></label>
          <label className="field">{s.expiration}<select value={filters.expiration} onChange={event => change({ expiration: event.target.value as StorageFilters["expiration"] })}>
            <option value="all">{t.statusAll}</option><option value="unexpired">{s.unexpired}</option><option value="expired">{s.expired}</option></select></label>
          <label className="field">{s.sort}<select value={filters.sort} onChange={event => change({ sort: event.target.value as StorageFilters["sort"] })}>
            {STORAGE_SORTS.map(sort => <option key={sort} value={sort}>{s.sortOptions[sort]}</option>)}</select></label>
        </div>
        <details className="storage-advanced"><summary>{s.moreFilters}</summary><div className="storage-filters">
          <label className="field">{s.project}<select value={filters.project} onChange={event => change({ project: event.target.value })}>
            <option value="">{s.allProjects}</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.archived ? s.archivedProject(project.name) : project.name}</option>)}
          </select></label>
          <label className="field">{s.source}<input list="storage-sources" value={filters.sourceDevice} maxLength={80} placeholder={t.allDevices} onChange={event => change({ sourceDevice: event.target.value })} /></label>
          <label className="field">{s.target}<input list="storage-targets" value={filters.targetDevice} maxLength={80} placeholder={t.allDevices} onChange={event => change({ targetDevice: event.target.value })} /></label>
          <label className="field">{s.age}<select value={filters.ageDays} onChange={event => change({ ageDays: Number(event.target.value) as StorageFilters["ageDays"] })}>
            <option value="0">{s.anyAge}</option>{[30, 90, 365].map(days => <option key={days} value={days}>{s.olderThan(days)}</option>)}</select></label>
          <label className="field">{s.minimumSize}<input type="number" min="0" step="1" value={filters.minBytes || ""} placeholder="0" onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 0) change({ minBytes: value }); }} /></label>
        </div></details>
        <datalist id="storage-sources">{page?.suggestions.sourceDevices.map(value => <option key={value} value={value} />)}</datalist>
        <datalist id="storage-targets">{page?.suggestions.targetDevices.map(value => <option key={value} value={value} />)}</datalist>
      </fieldset>
      {!!error && <p className="storage-error" role="alert">{errorText(error)} <button className="link" onClick={refresh}>{t.retry}</button></p>}
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      <div className="storage-table-wrap" aria-busy={loading}>
        <table className="storage-table"><thead><tr><th className="storage-check"><input ref={selectPage} type="checkbox" aria-label={s.selectPage} checked={visible.length > 0 && selectedOnPage === visible.length}
          disabled={busy || !visible.length} onChange={() => { setSelected(selectedOnPage === visible.length ? {} : Object.fromEntries(visible.map(row => [row.id, row]))); setNotice(null); }} /></th>
          <th>{s.handoff}</th><th>{s.status}</th><th>{s.promptSize}</th><th>{s.created}</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.id} data-selected={!!selected[row.id]}>
            <td className="storage-check"><input type="checkbox" aria-label={s.selectHandoff(row.title)} checked={!!selected[row.id]} disabled={busy} onChange={() => toggle(row)} /></td>
            <td><button className="storage-row-title" onClick={() => void openPreview(row.id)}>{row.title}</button>
              <span className="storage-row-meta">{row.project || t.noProject} · {row.sourceDevice} → {row.targetDevice}</span></td>
            <td><span>{t.status[row.status] ?? row.status}</span>{row.expiresAt !== null && row.expiresAt <= (page?.asOf ?? 0) && <span className="storage-expired">{s.expired}</span>}</td>
            <td className="tnum">{bytes(row.logicalBytes)}{row.attachmentCount > 0 && <span className="storage-row-meta">{s.textPart(bytes(row.promptBytes))} · {s.imagePart(row.attachmentCount, bytes(row.imageBytes))}</span>}</td><td className="tnum">{formatDay(row.createdAt, locale)}</td>
          </tr>)}</tbody></table>
        {loading ? <p className="storage-list-message" role="status">{s.loading}</p> : !visible.length && !error ? <p className="storage-list-message">{page?.totalCount === 0 && summary?.handoffs.count === 0 ? s.empty : t.noMatch}</p> : null}
      </div>
      <div className="storage-pagination"><p>{s.page(cursors.length)} · {s.pageNote}</p><div>
        <button className="btn small" disabled={busy || loading || cursors.length === 1} onClick={() => move(cursors.slice(0, -1))}><ChevronLeft size={15} aria-hidden="true" />{s.previous}</button>
        <button className="btn small" disabled={busy || loading || !page?.nextCursor} onClick={() => { if (page?.nextCursor) move([...cursors, page.nextCursor]); }}>{s.next}<ChevronRight size={15} aria-hidden="true" /></button>
      </div></div>
    </section>
    {rows.length > 0 && <div className="storage-selection" role="group" aria-label={s.selection}>
      <div><strong>{s.selected(rows.length)}</strong><span className="tnum">{s.selectedData(bytes(selectedBytes))}</span></div>
      <button className="link" disabled={busy} onClick={() => { setSelected({}); setNotice(null); }}>{s.clearSelection}</button>
      <button className="btn danger" disabled={busy || loading} onClick={() => setConfirmation([...rows])}><Trash2 size={15} aria-hidden="true" />{s.deleteSelected}</button>
    </div>}
    {confirmation && <StorageDeleteDialog rows={confirmation} busy={busy} onClose={() => setConfirmation(null)} onDelete={() => void remove()} />}
    {preview && <StoragePreviewDialog row={preview.row} error={preview.error} onClose={closePreview} />}
  </section>;
}
