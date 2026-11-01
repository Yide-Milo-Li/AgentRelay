"use client";
import { useLayoutEffect, useRef } from "react";
import { X, TriangleAlert } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Handoff } from "@/shared/contracts/handoffs";
import type { StorageHandoff } from "@/shared/contracts/storage";
import { containDialogFocus } from "@/shared/browser/keyboard-shortcuts";
import { formatStorageBytes } from "../storage-formatting";
import { MarkdownViewer } from "./MarkdownViewer";
import AttachmentGallery from "./AttachmentGallery";

/** Native modal focus and inertness match the existing composer, including returning to the opener. */
function useStorageDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    element?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return dialog;
}

export function StorageDeleteDialog({ rows, busy, onClose, onDelete }: { rows: StorageHandoff[]; busy: boolean; onClose: () => void; onDelete: () => void }) {
  const { t, locale } = useLang(), s = t.storage;
  const dialog = useStorageDialog();
  const bytes = rows.reduce((sum, row) => sum + row.logicalBytes, 0), imageCount = rows.reduce((sum, row) => sum + row.attachmentCount, 0);
  const activeCount = rows.filter(row => row.status === "ready" || row.status === "claimed").length;
  return <dialog ref={dialog} className="compose storage-confirm" role="alertdialog" aria-labelledby="storage-delete-title" aria-describedby="storage-delete-description"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => containDialogFocus(event, dialog.current)}>
    <h2 id="storage-delete-title">{s.deleteTitle(rows.length)}</h2>
    <p id="storage-delete-description">{s.deleteBody}</p>
    <p className="storage-selected-data tnum">{s.selectedData(formatStorageBytes(bytes, locale))}</p>
    {imageCount > 0 && <p className="storage-selected-data">{s.deleteImages(imageCount)}</p>}
    {activeCount > 0 && <p className="storage-active-warning"><TriangleAlert size={17} aria-hidden="true" />{s.activeWarning(activeCount)}</p>}
    <div className="storage-dialog-actions">
      <button className="btn" data-initial-focus disabled={busy} onClick={onClose}>{t.cancel}</button>
      <button className="btn danger" disabled={busy} onClick={onDelete}>{busy ? t.working : s.deleteAction}</button>
    </div>
  </dialog>;
}

export function StoragePreviewDialog({ row, error, onClose }: { row: Handoff | null; error: string | null; onClose: () => void }) {
  const { t } = useLang(), s = t.storage;
  const dialog = useStorageDialog();
  return <dialog ref={dialog} className="compose storage-preview" aria-labelledby="storage-preview-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => containDialogFocus(event, dialog.current)}>
    <header className="compose-head"><h2 id="storage-preview-title">{row?.title ?? s.preview}</h2>
      <button className="icon" data-initial-focus aria-label={t.close} onClick={onClose}><X size={18} /></button></header>
    {error ? <p role="alert" className="form-error">{error}</p> : row ? <>
      <p className="muted">{row.project || t.noProject} · {row.sourceDevice} → {row.targetDevice}</p>
      {row.content ? <div className="storage-preview-text" tabIndex={0} aria-label={t.promptText}><MarkdownViewer content={row.content} /></div> : <p className="prompt-empty">{t.images.imagesOnly}</p>}
      <AttachmentGallery attachments={row.attachments} basePath={`/api/storage/handoffs/${encodeURIComponent(row.id)}/attachments`} />
    </> : <p role="status">{s.loadingPreview}</p>}
  </dialog>;
}
