"use client";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { copyText } from "@/shared/browser/clipboard";
import type { AgentProfile } from "@/shared/agent-profiles";
import type { IssuedAgentToken, TokenInfo } from "@/shared/contracts/agent-tokens";
import { api } from "@/shared/http/client";
import CopyPanel from "@/features/agent-access/components/CopyPanel";
import { connectCommand, gatewayCopyCommand } from "@/features/agent-access/connect-command";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";

// A standalone Cloudflare deployment lets AgentRelay's agent path bypass Access: agents need no gateway token there.
const GATEWAY = DEPLOYMENT_TARGET === "sites";

type Props = {
  issued: IssuedAgentToken; profile: AgentProfile; siteUrl: string; notify: (message: string) => void; onDone: () => void;
  /** The bound device, if any. An unbound connection only gets the generic config. */
  device: { id: string; name: string } | null;
  /**
   * No other connection on this device has been used yet, so the device has most likely never saved the Site's gateway
   * token. Saving it then comes first, before the command that would otherwise stop and ask for it.
   */
  firstOnDevice: boolean;
};

/**
 * Set up, in the order the person acts: run the command on the device, paste the token it asks for (and, the first
 * time on a device of a ChatGPT Site, the Site's gateway token), then watch the credential come in. Everything else
 * is folded away.
 */
export default function ConnectionSecret({ issued, profile, siteUrl, device, firstOnDevice, notify, onDone }: Props) {
  const { t, lang, errorText } = useLang();
  const token = issued.token;
  const [checked, setChecked] = useState<TokenInfo | null>(null), [error, setError] = useState<unknown>(null), [shown, setShown] = useState(true);
  const command = connectCommand({ profile, deviceId: device?.id ?? null, connectionId: issued.id, siteUrl, lang });
  async function refresh() {
    try { const result = await api<{ tokens: TokenInfo[] }>("/api/agent-tokens"); setChecked(result.tokens.find(row => row.id === issued.id) ?? null); setError(null); }
    catch (e) { setError(e); }
  }
  useEffect(() => {
    let active = true;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= 180_000) { clearInterval(timer); return; }
      if (document.visibilityState !== "visible") return;
      api<{ tokens: TokenInfo[] }>("/api/agent-tokens").then(result => { if (active) setChecked(result.tokens.find(row => row.id === issued.id) ?? null); }).catch(e => { if (active) setError(e); });
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [issued.id]);
  async function copyToken() { try { await copyText(token); notify(t.toastTokenCopied); } catch (e) { notify(errorText(e)); } }
  const connected = !!checked?.lastAuthenticatedAt;
  const gateway = <>
    <p>{t.setupGatewayBody}</p>
    <CopyPanel title="Codex" text={t.gatewayRequest(siteUrl)} copyLabel={t.copyRequest} copiedMessage={t.toastRequestCopied} notify={notify} />
    <p>{t.setupGatewayOther}</p>
    <CopyPanel title={t.gatewayCopyTitle} text={gatewayCopyCommand(siteUrl)} copyLabel={t.copyCommand} copiedMessage={t.toastCommandCopied} notify={notify} />
  </>;
  return <div className="connection-secret">
    <ol className="setup-steps">
      {GATEWAY && firstOnDevice && <li className="setup-gateway-first"><h4>{t.setupGatewayFirst(device?.name ?? null)}</h4>{gateway}</li>}
      <li><h4>{t.setupRun(device?.name ?? null)}</h4><p className="muted">{t.setupRunHint}</p>
        <CopyPanel title={t.connectTitle(device?.name ?? profile.label)} text={command} copyLabel={t.copyCommand} copiedMessage={t.toastCommandCopied} notify={notify} /></li>
      <li><h4>{t.setupPaste}</h4>
        {shown ? <div className="secret">
          <p>{t.tokenSaveNow}</p>
          <label className="field">{t.tokenNew}<textarea readOnly value={token} rows={2} spellCheck={false} autoComplete="off" /></label>
          <div className="secret-actions">
            <button type="button" className="btn" onClick={copyToken}><Copy size={14} aria-hidden="true" />{t.copyToken}</button>
            <button type="button" className="link" onClick={() => setShown(false)}>{t.hideToken}</button>
          </div>
        </div> : null}
        {GATEWAY && !firstOnDevice && <details className="setup-gateway"><summary>{t.setupGateway}</summary>{gateway}</details>}</li>
    </ol>
    <div className="connection-verification" role="status" data-state={connected ? "connected" : "waiting"}>
      <strong>{connected ? <><Check size={15} aria-hidden="true" />{t.connectionAuthenticated(profile.label)}</> : t.connectionWaiting}</strong>
      <p className="muted">{t.connectionVerificationNote}</p>
      <div className="wizard-actions">
        <button type="button" className="btn small quiet" onClick={() => void refresh()}>{t.refresh}</button>
        <button type="button" className="btn small primary" onClick={onDone}>{t.setupDone}</button>
      </div>
    </div>
    {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
  </div>;
}
