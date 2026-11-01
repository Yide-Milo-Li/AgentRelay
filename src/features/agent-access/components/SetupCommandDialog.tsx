"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { AGENT_PROFILES, DEFAULT_AGENT_PROFILE, findAgentProfile } from "@/shared/agent-profiles";
import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { connectCommand } from "@/features/agent-access/connect-command";
import CopyPanel from "@/features/agent-access/components/CopyPanel";

type Props = { token: TokenInfo; devices: readonly Device[]; siteUrl: string; trigger: HTMLElement | null; notify: (message: string) => void; onClose: () => void };

/** The setup command again, without a secret. The secret was shown once; losing it means rotating it. */
export default function SetupCommandDialog({ token, devices, siteUrl, trigger, notify, onClose }: Props) {
  const { t, lang } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [profileId, setProfileId] = useState(findAgentProfile(token.clientProfile ?? "")?.id ?? DEFAULT_AGENT_PROFILE.id);
  useEffect(() => { dialog.current?.showModal(); closeButton.current?.focus(); }, []);
  const close = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };
  const profile = findAgentProfile(profileId) ?? DEFAULT_AGENT_PROFILE, device = devices.find(item => item.id === token.deviceId) ?? null;
  const command = connectCommand({ profile, deviceId: device?.id ?? null, connectionId: token.id, siteUrl, lang });
  return <dialog ref={dialog} className="identity-dialog setup-dialog" data-shortcut-layer aria-labelledby="setup-title" aria-describedby="setup-body"
    onCancel={event => { event.preventDefault(); close(); }}>
    <h2 id="setup-title">{t.setupTitle(token.name)}</h2>
    <p id="setup-body">{t.setupBody}</p>
    <label className="field">{t.setupAgent}
      <select value={profileId} onChange={event => setProfileId(event.target.value)}>
        {AGENT_PROFILES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
    <CopyPanel title={t.connectTitle(device?.name ?? profile.label)} text={command} copyLabel={t.copyCommand} copiedMessage={t.toastCommandCopied} notify={notify} />
    <div className="wizard-actions"><button ref={closeButton} type="button" className="btn" onClick={close}>{t.offClose}</button></div>
  </dialog>;
}
