"use client";
import { useSyncExternalStore } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import AgentConnections from "@/features/agent-access/components/AgentConnections";
import CopyPanel from "@/features/agent-access/components/CopyPanel";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";
// An example address in the shape of the platform's own: a Site, or a standalone Worker on workers.dev.
const canonicalSiteUrl = DEPLOYMENT_TARGET === "cloudflare" ? "https://agentrelay.example.workers.dev" : "https://agentrelay.example.chatgpt.site";
const TOOLS = ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"];

// Follow the deployed origin after a slug/domain change; local previews and the server keep the canonical URL.
const noSubscription = () => () => {};
function deployedOrigin() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) ? canonicalSiteUrl : window.location.origin;
}

type Props = {
  notify: (message: string, action?: { label: string; run: () => void }) => void;
  devices: readonly Device[]; currentDeviceId: string | null; onCreateDevice: (name: string) => Promise<Device>;
  /** Opens the connection list already narrowed to one device. */
  initialDevice?: string | null;
  /** Opens the connection wizard right away, as the setup checklist's "Connect an agent" does. */
  startWizard?: boolean;
  /** The person said this device's agent uses the Site's plugin, which leaves no connection to list. */
  onPluginConfirmed: (deviceId: string) => void;
};

/** The connections are the page. How agents without `connect` learn the procedure is reference, folded at the end. */
export default function AgentGuide({ notify, devices, currentDeviceId, onCreateDevice, initialDevice, startWizard = false, onPluginConfirmed }: Props) {
  const { t } = useLang();
  const siteUrl = useSyncExternalStore(noSubscription, deployedOrigin, () => canonicalSiteUrl);
  return <section className="guide agents-guide">
    <header className="guide-head"><h1>{t.guideTitle}</h1><p>{t.guideBody}</p></header>
    <AgentConnections siteUrl={siteUrl} notify={notify} devices={devices} currentDeviceId={currentDeviceId} onCreateDevice={onCreateDevice} initialDevice={initialDevice}
      startWizard={startWizard} onPluginConfirmed={onPluginConfirmed} />
    <details className="agent-reference"><summary>{t.withoutConnectTitle}</summary><p>{DEPLOYMENT_TARGET === "cloudflare" ? t.withoutConnectBodyAccess : t.withoutConnectBody}</p>
      <CopyPanel title={t.ruleTitle} text={t.agentRule(siteUrl)} copyLabel={t.copyRule} copiedMessage={t.toastRuleCopied} notify={notify} />
      <div className="tools"><h3>{t.toolsTitle}</h3>
        <dl>{TOOLS.map(name => <div key={name}><dt><code>{name}</code></dt><dd>{t.tools[name]}</dd></div>)}</dl></div>
    </details>
  </section>;
}
