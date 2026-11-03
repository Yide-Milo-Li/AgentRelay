"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import { formatRelative } from "@/shared/formatting/relative-time";
import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";

// On a standalone Cloudflare deployment the Access policy decides who signs in, and there is no gateway token to rotate.
const ACCESS = DEPLOYMENT_TARGET === "cloudflare";

type Props = {
  /** The member's display name, or null for connections issued before attribution existed. */
  name: string | null;
  /** The member's usable connections as the list shows them now; the revoke sends exactly these. */
  tokens: readonly TokenInfo[]; devices: readonly Device[]; now: number; trigger: HTMLElement | null;
  onClose: () => void; onRevoked: () => void; onConflict: () => void;
};

/** Removing someone is three steps, only one of which AgentRelay can do. The other two are written down, not faked. */
export default function OffboardingDialog({ name, tokens, devices, now, trigger, onClose, onRevoked, onConflict }: Props) {
  const { t, locale, errorText } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [sharingDone, setSharingDone] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState<unknown>(null);
  useEffect(() => { dialog.current?.showModal(); closeButton.current?.focus(); }, []);
  const close = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };
  const display = name ?? t.issuerUnknown;

  async function revoke() {
    setBusy(true); setError(null);
    try {
      await api("/api/agent-tokens/revoke-issuer", "POST", { connectionId: tokens[0].id, expectedTokenIds: tokens.map(token => token.id) });
      setDone(true); onRevoked();
    } catch (e) {
      setError(e);
      if (e instanceof AgentRelayClientError && e.status === 409) onConflict();
    } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="identity-dialog offboarding-dialog" data-shortcut-layer aria-labelledby="off-title"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2 id="off-title">{t.offTitle(display)}</h2>
    <p>{ACCESS ? t.offIntroAccess : t.offIntro}</p>
    <ol className="off-steps">
      <li><h3>{ACCESS ? t.offStep1Access : t.offStep1}</h3><p>{ACCESS ? t.offStep1AccessBody : t.offStep1Body}</p>
        <label className="check"><input type="checkbox" checked={sharingDone} onChange={event => setSharingDone(event.target.checked)} />{ACCESS ? t.offStep1AccessCheck : t.offStep1Check}</label></li>
      <li><h3>{done ? t.offStep2Done : t.offStep2(tokens.length)}</h3>
        {done ? <p role="status">{t.offDone}</p> : tokens.length === 0 ? <p>{t.offNone}</p> : <>
          <p>{t.offStep2Body}</p>
          <ul>{tokens.map(token => <li key={token.id}>{token.name} · {devices.find(device => device.id === token.deviceId)?.name ?? t.connectionUnbound}
            {" · "}{token.lastAuthenticatedAt ? t.connLastUsed(formatRelative(token.lastAuthenticatedAt, now, locale)) : t.connNeverUsed}{token.neverExpires ? ` · ${t.permanentOption}` : ""}</li>)}</ul>
          {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
          <button type="button" className="btn danger" disabled={busy} onClick={() => void revoke()}>{t.offConfirm(tokens.length)}</button></>}</li>
      {!ACCESS && <li><h3>{t.offStep3}</h3><p>{t.offStep3Body}</p></li>}
    </ol>
    <div className="wizard-actions"><button ref={closeButton} type="button" className="btn" onClick={close}>{t.offClose}</button></div>
  </dialog>;
}
