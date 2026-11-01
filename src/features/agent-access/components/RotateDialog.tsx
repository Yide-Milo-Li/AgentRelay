"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import { AGENT_PROFILES, DEFAULT_AGENT_PROFILE, findAgentProfile } from "@/shared/agent-profiles";
import type { Device } from "@/shared/contracts/devices";
import type { IssuedAgentToken, TokenInfo } from "@/shared/contracts/agent-tokens";
import ConnectionSecret from "@/features/agent-access/components/ConnectionSecret";

type Props = {
  token: TokenInfo; devices: readonly Device[]; siteUrl: string; trigger: HTMLElement | null; notify: (message: string) => void;
  onClose: () => void; onRotated: (record: TokenInfo) => void; onConflict: () => void;
};

/** Confirm, replace the secret, then show the new one once together with the command that applies it. */
export default function RotateDialog({ token, devices, siteUrl, trigger, notify, onClose, onRotated, onConflict }: Props) {
  const { t, errorText } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [profileId, setProfileId] = useState(findAgentProfile(token.clientProfile ?? "")?.id ?? DEFAULT_AGENT_PROFILE.id);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  const close = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };
  const profile = findAgentProfile(profileId) ?? DEFAULT_AGENT_PROFILE, device = devices.find(item => item.id === token.deviceId) ?? null;

  async function rotate() {
    setBusy(true); setError(null);
    try {
      const result = await api<IssuedAgentToken>(`/api/agent-tokens/${token.id}/rotate`, "POST", { version: token.version });
      // The list only ever holds public metadata; the secret stays in this dialog until it is closed.
      const record: Partial<IssuedAgentToken> = { ...result }; delete record.token;
      setIssued(result); onRotated({ ...(record as TokenInfo), issuerRef: token.issuerRef, issuedByViewer: token.issuedByViewer }); notify(t.toastConnectionRotated);
    } catch (e) {
      setError(e);
      if (e instanceof AgentRelayClientError && e.status === 409) onConflict();
    } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="identity-dialog setup-dialog" data-shortcut-layer aria-labelledby="rotate-title" aria-describedby="rotate-body"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    {issued ? <>
      <h2 id="rotate-title">{t.rotateDoneTitle(token.name)}</h2>
      <label className="field">{t.setupAgent}
        <select value={profileId} onChange={event => setProfileId(event.target.value)}>
          {AGENT_PROFILES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
      <ConnectionSecret issued={issued} profile={profile} siteUrl={siteUrl} notify={notify} onDone={close} device={device && { id: device.id, name: device.name }} firstOnDevice={false} />
      <div className="wizard-actions"><button type="button" className="btn" onClick={close}>{t.offClose}</button></div>
    </> : <>
      <h2 id="rotate-title">{t.rotateTitle(token.name)}</h2>
      <p id="rotate-body">{t.rotateBody}</p>
      {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
      <div className="wizard-actions"><button ref={cancel} type="button" className="btn" disabled={busy} onClick={close}>{t.cancel}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void rotate()}>{busy ? t.working : t.rotateConfirm}</button></div>
    </>}
  </dialog>;
}
