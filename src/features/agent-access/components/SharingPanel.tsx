"use client";
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import type { WorkspaceInfo } from "@/shared/contracts/workspace";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";

// A standalone Cloudflare deployment always sets its workspace key: whoever the Access policy admits shares it.
const ACCESS = DEPLOYMENT_TARGET === "cloudflare";
import CopyPanel from "@/features/agent-access/components/CopyPanel";

/**
 * Optional sharing: shows the caller's own id and a ready-to-paste request for the agent that deploys the Site.
 * Folded by default because most workspaces stay personal; the summary still says which kind this one is.
 */
export default function SharingPanel({ notify }: { notify: (message: string) => void }) {
  const { t, errorText } = useLang();
  const [info, setInfo] = useState<WorkspaceInfo | null>(null), [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    api<WorkspaceInfo>("/api/workspace").then(result => { if (active) setInfo(result); }).catch(e => { if (active) setError(e); });
    return () => { active = false; };
  }, []);
  return <details className="sharing-panel">
    <summary><span id="sharing-heading" className="sharing-title"><Users size={18} aria-hidden="true" />{t.sharingTitle}</span>
      {info && <small>{info.shared ? t.workspaceShared : t.sharingOptional}</small>}</summary>
    <p>{ACCESS ? t.sharingBodyAccess : t.sharingBody}</p>
    {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
    {!ACCESS && info?.shared === true && <p className="muted">{t.sharingOn}</p>}
    {!ACCESS && info?.shared === false && <CopyPanel title={t.sharingPromptTitle} hint={t.sharingOwnerNote} text={t.sharingPrompt(info.userId)}
      copyLabel={t.copySharingPrompt} copiedMessage={t.toastSharingPromptCopied} notify={notify} />}
  </details>;
}
