"use client";
import { useLang } from "@/components/providers/LanguageProvider";
import { findAgentProfile } from "@/shared/agent-profiles";
import { renderDeviceRule } from "@/shared/formatting/device-rule.mjs";
import CopyPanel from "@/features/agent-access/components/CopyPanel";

type Props = { device: { id: string; name: string }; siteUrl: string; notify: (message: string) => void; onBack: () => void; onConfirm: () => void };

/**
 * The Site's own plugin in ChatGPT or Codex: no token, no local client. It has no `self`, so each surface gets this
 * device's id its own way: a rule in Codex's user instructions, or a first message in a ChatGPT chat. Nothing assumes
 * a rule carries over between chats, and the page cannot see plugin connections, so the person confirms it.
 */
export default function PluginSetup({ device, siteUrl, notify, onBack, onConfirm }: Props) {
  const { t, lang } = useLang();
  const codexRules = findAgentProfile("codex")?.ruleFile ?? "~/.codex/AGENTS.md";
  return <div className="plugin-setup">
    <ol className="setup-steps">
      <li><h4>{t.pluginInstall}</h4><p>{t.pluginInstallBody}</p>
        <CopyPanel title="Codex" text={t.pluginInstallRequest} copyLabel={t.copyRequest} copiedMessage={t.toastRequestCopied} notify={notify} /></li>
      <li><h4>{t.pluginDevice(device.name)}</h4>
        <p>{t.pluginCodex(codexRules)}</p>
        <CopyPanel title={t.deviceRuleTitle(device.name)} text={renderDeviceRule(lang, siteUrl, device.id)} copyLabel={t.copyRule} copiedMessage={t.toastDeviceRuleCopied} notify={notify} />
        <p>{t.pluginChat}</p>
        <CopyPanel title="ChatGPT" text={t.pluginStartPrompt(device.id)} copyLabel={t.copyText} copiedMessage={t.toastTextCopied} notify={notify} />
        <p className="muted">{t.pluginCheck}</p></li>
    </ol>
    <p className="muted">{t.pluginNotes}</p>
    <div className="wizard-actions">
      <button type="button" className="btn" onClick={onBack}>{t.wizardBack}</button>
      <button type="button" className="btn primary" onClick={onConfirm}>{t.pluginConfirm}</button>
    </div>
  </div>;
}
