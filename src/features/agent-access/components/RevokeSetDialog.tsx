"use client";
import { useEffect, useRef } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";

type Props = {
  tokens: readonly TokenInfo[]; devices: readonly Device[]; trigger: HTMLElement | null; busy: boolean;
  onClose: () => void; onConfirm: (tokens: readonly TokenInfo[]) => void;
};

/** The confirmation keeps the exact preview snapshot; the server refuses it if the issuer's active set changes meanwhile. */
export default function RevokeSetDialog({ tokens, devices, trigger, busy, onClose, onConfirm }: Props) {
  const { t } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  const close = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };
  return <dialog ref={dialog} className="identity-dialog" data-shortcut-layer aria-labelledby="issuer-preview-title" aria-describedby="issuer-risk"
    onCancel={event => { event.preventDefault(); close(); }}>
    <h2 id="issuer-preview-title">{t.issuerPreview}</h2><p id="issuer-risk">{t.issuerRisk}</p>
    <ul>{tokens.map(token => <li key={token.id}>{token.name} · {devices.find(device => device.id === token.deviceId)?.name ?? t.connectionUnbound}{token.neverExpires ? ` · ${t.permanentOption}` : ""}</li>)}</ul>
    <div className="wizard-actions"><button ref={cancel} type="button" className="btn" onClick={close}>{t.cancel}</button>
      <button type="button" className="btn danger" disabled={busy} onClick={() => { close(); onConfirm(tokens); }}>{t.issuerConfirm}</button></div>
  </dialog>;
}
