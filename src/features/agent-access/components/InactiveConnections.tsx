"use client";
import { useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { formatDay } from "@/shared/formatting/date";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";

type Props = { tokens: readonly TokenInfo[]; busy: boolean; onRemove: (token: TokenInfo) => void; onRemoveAll: () => void };

/** Revoked and expired connections: collapsed by default, read-only, and removable only after a confirmation. */
export default function InactiveConnections({ tokens, busy, onRemove, onRemoveAll }: Props) {
  const { t, locale } = useLang();
  // One confirmation at a time: a connection id, or "all".
  const [asking, setAsking] = useState<string | null>(null);
  if (!tokens.length) return null;
  return <details className="inactive-connections" onToggle={event => { if (!event.currentTarget.open) setAsking(null); }}>
    <summary>{t.inactiveTitle(tokens.length)}</summary>
    <div className="inactive-tools">
      {asking === "all"
        ? <div className="confirm" role="alert" data-shortcut-layer>
            <span>{t.inactiveRemoveAllAsk(tokens.length)}</span>
            <button type="button" className="btn" onClick={() => setAsking(null)}>{t.cancel}</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => { setAsking(null); onRemoveAll(); }}>{t.inactiveRemoveAll}</button>
          </div>
        : <button type="button" className="btn small" disabled={busy} onClick={() => setAsking("all")}>{t.inactiveRemoveAll}</button>}
    </div>
    <div className="token-list">
      {tokens.map(token => <div className="token-row" data-inactive key={token.id}>
        <div><strong>{token.name}</strong><span>{token.revokedAt !== null ? t.inactiveRevokedMeta(formatDay(token.revokedAt, locale), token.revokedByName, token.revokedReason ? t.revokedReasons[token.revokedReason] : null)
          : t.inactiveExpiredMeta(formatDay(token.expiresAt ?? token.createdAt, locale))}</span></div>
        {asking === token.id
          ? <div className="confirm" role="alert" data-shortcut-layer>
              <span>{t.inactiveRemoveAsk}</span>
              <button type="button" className="btn" onClick={() => setAsking(null)}>{t.cancel}</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => { setAsking(null); onRemove(token); }}>{t.inactiveRemove}</button>
            </div>
          : <button type="button" className="btn small" disabled={busy} onClick={() => setAsking(token.id)}>{t.inactiveRemove}</button>}
      </div>)}
    </div>
  </details>;
}
