"use client";
import { Copy } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { copyText } from "@/shared/browser/clipboard";

type Props = { title: string; hint?: string; text: string; copyLabel: string; copiedMessage: string; notify: (message: string) => void };

/** A titled block of text with a copy button; the same shape for the AGENTS.md rule, the MCP config and a device rule. */
export default function CopyPanel({ title, hint, text, copyLabel, copiedMessage, notify }: Props) {
  const { errorText } = useLang();
  async function copy() { try { await copyText(text); notify(copiedMessage); } catch (e) { notify(errorText(e)); } }
  return <div className="panel">
    <div className="panel-head"><span>{title}</span><button type="button" className="btn small" onClick={copy}><Copy size={14} aria-hidden="true" />{copyLabel}</button></div>
    {hint && <p className="panel-hint">{hint}</p>}
    <pre className="code">{text}</pre>
  </div>;
}
