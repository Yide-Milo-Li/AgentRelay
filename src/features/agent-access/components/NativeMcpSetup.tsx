"use client";
import { useLang } from "@/components/providers/LanguageProvider";
import { findAgentProfile } from "@/shared/agent-profiles";
import { renderDeviceRule } from "@/shared/formatting/device-rule.mjs";
import CopyPanel from "@/features/agent-access/components/CopyPanel";

type Props = { device: { id: string; name: string }; siteUrl: string; notify: (message: string) => void; onBack: () => void; onConfirm: () => void };

/**
 * A native MCP client on a standalone Cloudflare deployment: Claude Code, Codex or ChatGPT reach `/mcp` and sign in
 * through Cloudflare Access (Managed OAuth), so no token or local client is involved. Like the Site's plugin it has no
 * `self`, so each agent gets this device's id as a rule or a first message, and the person confirms the connection,
 * which the page cannot see.
 */
export default function NativeMcpSetup({ device, siteUrl, notify, onBack, onConfirm }: Props) {
  const { t, lang } = useLang();
  const endpoint = `${siteUrl}/mcp`;
  const claudeRules = findAgentProfile("claude-code")?.ruleFile ?? "~/.claude/CLAUDE.md", codexRules = findAgentProfile("codex")?.ruleFile ?? "~/.codex/AGENTS.md";
  return <div className="plugin-setup native-setup">
    <ol className="setup-steps">
      <li><h4>{t.nativeAdd}</h4><p>{t.nativeAddBody}</p>
        <p>{t.nativeClaudeCode}</p>
        <CopyPanel title="Claude Code" text={`claude mcp add --scope user --transport http agentrelay ${endpoint}`} copyLabel={t.copyCommand} copiedMessage={t.toastCommandCopied} notify={notify} />
        <p>{t.nativeCodex}</p>
        <CopyPanel title="Codex" text={`codex mcp add agentrelay --url ${endpoint}\ncodex mcp login agentrelay`} copyLabel={t.copyCommand} copiedMessage={t.toastCommandCopied} notify={notify} />
        <p>{t.nativeChatGpt}</p>
        <CopyPanel title="ChatGPT" text={endpoint} copyLabel={t.copyText} copiedMessage={t.toastTextCopied} notify={notify} /></li>
      <li><h4>{t.pluginDevice(device.name)}</h4>
        <p>{t.nativeRules(claudeRules, codexRules)}</p>
        <CopyPanel title={t.deviceRuleTitle(device.name)} text={renderDeviceRule(lang, siteUrl, device.id)} copyLabel={t.copyRule} copiedMessage={t.toastDeviceRuleCopied} notify={notify} />
        <p>{t.pluginChat}</p>
        <CopyPanel title="ChatGPT" text={t.pluginStartPrompt(device.id)} copyLabel={t.copyText} copiedMessage={t.toastTextCopied} notify={notify} />
        <p className="muted">{t.pluginCheck}</p></li>
    </ol>
    <p className="muted">{t.nativeNotes}</p>
    <div className="wizard-actions">
      <button type="button" className="btn" onClick={onBack}>{t.wizardBack}</button>
      <button type="button" className="btn primary" onClick={onConfirm}>{t.nativeConfirm}</button>
    </div>
  </div>;
}
