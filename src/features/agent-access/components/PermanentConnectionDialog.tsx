"use client";
import { useEffect, useRef } from "react";
import { useLang } from "@/components/providers/LanguageProvider";

/** Consent is local to this selection. Cancelling leaves the previous lifetime unchanged. */
export default function PermanentConnectionDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  return <dialog ref={dialog} className="identity-dialog" aria-labelledby="permanent-title" aria-describedby="permanent-risk" data-shortcut-layer
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onCancel(); } }}>
    <h2 id="permanent-title">{t.permanentTitle}</h2>
    <p id="permanent-risk">{t.permanentRisk}</p>
    <p>{t.permanentAdvice}</p>
    <div className="wizard-actions"><button ref={cancel} type="button" className="btn" onClick={onCancel}>{t.cancel}</button>
      <button type="button" className="btn danger" onClick={onConfirm}>{t.permanentConfirm}</button></div>
  </dialog>;
}
