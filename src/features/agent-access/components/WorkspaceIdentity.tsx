"use client";
import { useEffect, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import type { WorkspaceInfo } from "@/shared/contracts/workspace";

/** Who is signed in, whether the workspace is shared, and which device this browser acts as. */
export default function WorkspaceIdentity({ displayName, deviceName }: { displayName: string | null; deviceName: string | null }) {
  const { t, errorText } = useLang();
  const [info, setInfo] = useState<WorkspaceInfo | null>(null), [error, setError] = useState<unknown>(null);
  useEffect(() => { let active = true; api<WorkspaceInfo>("/api/workspace").then(value => { if (active) setInfo(value); }).catch(e => { if (active) setError(e); }); return () => { active = false; }; }, []);
  return <div className="workspace-identity">
    <p>{info ? info.shared ? t.workspaceShared : t.workspacePrivate : t.workspaceLoading}</p>
    <dl><dt>{t.workspaceViewer}</dt><dd>{info?.viewerName ?? displayName ?? t.workspaceUnknown}</dd>
      <dt>{t.workspaceDevice}</dt><dd>{deviceName || t.deviceNotChosen}</dd></dl>
    {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
  </div>;
}
