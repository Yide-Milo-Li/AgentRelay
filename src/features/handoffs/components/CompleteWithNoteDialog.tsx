"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { HANDOFF_LIMITS } from "@/shared/contracts/handoffs";

/** Closing never moves focus by itself: the caller decides where it goes once the completion has been applied or abandoned. */
type Props = { title: string; busy: boolean; onCancel: () => void; onConfirm: (result: string) => void };

/** Completes a claimed handoff with a receipt for its sender. The text is stored exactly as typed and is never interpreted. */
export default function CompleteWithNoteDialog({ title, busy, onCancel, onConfirm }: Props) {
  const { t } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  useEffect(() => { dialog.current?.showModal(); field.current?.focus(); }, []);
  const limit = HANDOFF_LIMITS.resultCharacters;
  return <dialog ref={dialog} className="identity-dialog note-dialog" data-shortcut-layer aria-labelledby="note-title" aria-describedby="note-body"
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (note.trim() && !busy) onConfirm(note); }}>
      <h2 id="note-title">{t.receipts.noteTitle}</h2>
      <p className="note-subject">{title}</p>
      <p id="note-body">{t.receipts.noteBody}</p>
      <label className="field">{t.receipts.noteLabel}
        <textarea ref={field} value={note} maxLength={limit} spellCheck={false} placeholder={t.receipts.notePlaceholder}
          onChange={event => setNote(event.target.value)} /></label>
      <p className="note-count tnum" aria-live="polite">{t.receipts.noteCount(note.length, limit)}</p>
      <div className="wizard-actions">
        <button type="button" className="btn" onClick={onCancel}>{t.cancel}</button>
        <button type="submit" className="btn primary" disabled={busy || !note.trim()}>{t.receipts.noteConfirm}</button>
      </div>
    </form>
  </dialog>;
}
