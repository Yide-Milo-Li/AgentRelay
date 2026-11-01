"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { formatDay } from "@/shared/formatting/date";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import PermanentConnectionDialog from "./PermanentConnectionDialog";

/** Confirming closes the dialog without moving focus: the caller restores it once the change has been applied. */
type Props = { token: TokenInfo; trigger: HTMLElement | null; busy: boolean; onClose: () => void; onConfirm: (days: number | null) => void };

/** Sets a new lifetime counted from today. Choosing permanent asks for the same acknowledgement as creating one. */
export default function ExtendDialog({ token, trigger, busy, onClose, onConfirm }: Props) {
  const { t, locale } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), select = useRef<HTMLSelectElement>(null);
  const [days, setDays] = useState<number | null>(90), [riskOpen, setRiskOpen] = useState(false);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  const close = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };
  const current = token.neverExpires || token.expiresAt === null ? t.permanentSelected : t.tokenValidUntil(formatDay(token.expiresAt, locale));
  return <>
    <dialog ref={dialog} className="identity-dialog" data-shortcut-layer aria-labelledby="extend-title" aria-describedby="extend-body"
      onCancel={event => { event.preventDefault(); if (!riskOpen) close(); }}>
      <h2 id="extend-title">{t.extendTitle(token.name)}</h2>
      <p id="extend-body">{t.extendBody}</p>
      <p className="muted">{t.extendCurrent(current)}</p>
      <label className="field">{t.tokenValidity}
        <select ref={select} value={days === null ? "permanent" : days} onChange={event => { if (event.target.value === "permanent") setRiskOpen(true); else setDays(Number(event.target.value)); }}>
          {[30, 90, 365].map(value => <option key={value} value={value}>{t.days(value)}</option>)}<option value="permanent">{t.permanentOption}</option>
        </select></label>
      <div className="wizard-actions"><button ref={cancel} type="button" className="btn" onClick={close}>{t.cancel}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => { onClose(); onConfirm(days); }}>{t.extendConfirm}</button></div>
    </dialog>
    {riskOpen && <PermanentConnectionDialog onCancel={() => { setRiskOpen(false); requestAnimationFrame(() => select.current?.focus()); }}
      onConfirm={() => { setDays(null); setRiskOpen(false); requestAnimationFrame(() => select.current?.focus()); }} />}
  </>;
}
