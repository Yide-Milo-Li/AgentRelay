"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock, Ellipsis, KeyRound, Pencil, Terminal } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { formatDay, formatTime } from "@/shared/formatting/date";
import { formatRelative } from "@/shared/formatting/relative-time";
import { connectionStatus, isExpiring } from "@/shared/formatting/connection-health";
import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { AGENT_PROFILES } from "@/shared/agent-profiles";
import { groupConnections, nameWithinDevice, type ConnectionGroupBy } from "@/features/agent-access/connection-view";

/** Expiry reads relative to now once it is close; further out the calendar date is the clearer answer. */
const RELATIVE_EXPIRY_DAYS = 60;

type Actions = {
  busy: boolean;
  onRename: (token: TokenInfo, name: string) => void;
  onMove: (token: TokenInfo, deviceId: string | null) => void;
  onRevoke: (token: TokenInfo) => void;
  selected: ReadonlySet<string>; onSelect: (token: TokenInfo, on: boolean) => void;
  /** The element that opened a dialog is handed over so focus can return to it. */
  onExtend: (token: TokenInfo, trigger: HTMLElement) => void;
  onRotate: (token: TokenInfo, trigger: HTMLElement) => void;
  onSetup: (token: TokenInfo, trigger: HTMLElement) => void;
};

type RowContext = {
  devices: readonly Device[]; now: number; showIssuer: boolean; showClient: boolean;
  /** Set while grouping by device: the group's device, whose name the row then leaves out of its title. */
  groupDevice: Device | null;
};

function ConnectionRow({ token, devices, now, showIssuer, showClient, groupDevice, busy, selected, onSelect, onRename, onMove, onRevoke, onExtend, onRotate, onSetup }: Actions & RowContext & { token: TokenInfo }) {
  const { t, locale } = useLang();
  const status = connectionStatus(token, now);
  const label = status === "revoked" || status === "expired" ? null : t.connStatus[status];
  const clientLabel = AGENT_PROFILES.find(profile => profile.id === token.clientProfile)?.label;
  const device = devices.find(item => item.id === token.deviceId) ?? null;
  const title = nameWithinDevice(token.name, groupDevice);
  const reported = token.lastClient ? `${token.lastClient.name}${token.lastClient.version ? ` ${token.lastClient.version}` : ""}` : null;
  const expiry = token.neverExpires || token.expiresAt === null ? t.permanentSelected
    : token.expiresAt - now <= RELATIVE_EXPIRY_DAYS * 86_400_000 ? t.connExpiresIn(formatRelative(token.expiresAt, now, locale)) : t.tokenValidUntil(formatDay(token.expiresAt, locale));
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(token.name), [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null), renaming = useRef(false);
  const [menu, setMenu] = useState(false), menuRef = useRef<HTMLDivElement>(null), moreButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);

  function save() {
    // Enter and the blur it causes both arrive here; only the first one counts.
    if (!renaming.current) return;
    renaming.current = false; setEditing(false);
    const next = draft.trim();
    if (next && next !== token.name) onRename(token, next);
  }
  return <div className="token-row connection-row">
    <div className="connection-main">
      <div className="connection-title">
        <input type="checkbox" className="conn-check" aria-label={t.connSelect(token.name)} checked={selected.has(token.id)} disabled={busy} onChange={event => onSelect(token, event.target.checked)} />
        {editing
          ? <input ref={input} className="device-rename" aria-label={t.connectionRenameLabel(token.name)} value={draft} maxLength={80} onChange={event => setDraft(event.target.value)} onBlur={save}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); save(); } else if (event.key === "Escape") { event.preventDefault(); renaming.current = false; setEditing(false); } }} />
          : <strong title={title === token.name ? undefined : token.name}>{title}</strong>}
        {label && <small className="conn-status" data-status={status}>{label}</small>}
        {showClient && clientLabel && clientLabel !== title && <small className="conn-client">{clientLabel}</small>}
      </div>
      {/* One scannable line of facts; only an approaching expiry is coloured. */}
      <p className="connection-meta">
        <span className="tnum" title={token.lastAuthenticatedAt ? formatTime(token.lastAuthenticatedAt, locale) : undefined}>
          {token.lastAuthenticatedAt ? t.connLastUsed(formatRelative(token.lastAuthenticatedAt, now, locale)) : t.connNeverUsed}</span>
        <span className="tnum" data-warn={isExpiring(token, now) || undefined}>{expiry}</span>
        {reported && <span>{t.connReportsAs(reported)}</span>}
        {showIssuer && token.createdByName && <span>{t.connectionIssuedBy(token.issuedByViewer ? t.connYou(token.createdByName) : token.createdByName)}</span>}
      </p>
    </div>
    <div className="connection-actions">
      {/* The device tag carries the device's colour and doubles as the control that moves the connection. */}
      <label className="select-quiet device-chip" data-line={device?.line ?? "neutral"} data-unbound={device ? undefined : true} title={device ? undefined : t.connectionUnboundHint}>
        <select aria-label={`${t.connectionMove} ${token.name}`} value={device?.id ?? ""} disabled={busy}
          onChange={event => onMove(token, event.target.value || null)}>
          <option value="">{t.connectionUnbound}</option>
          {devices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <ChevronDown size={13} aria-hidden="true" />
      </label>
      <span className="sr-only">{t.connectionLabelNote}</span>
      <button type="button" className="btn small" disabled={busy} onClick={() => setConfirming(true)}>{t.revoke}</button>
      <div className="menu-wrap" ref={menuRef} data-menu-open={menu || undefined}
        onKeyDown={event => { if (event.key === "Escape" && menu) { event.preventDefault(); event.stopPropagation(); setMenu(false); moreButton.current?.focus(); } }}>
        <button ref={moreButton} type="button" className="icon" title={t.more} aria-label={t.connMore(token.name)} aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu(value => !value)}><Ellipsis size={17} /></button>
        {menu && <div className="menu" role="menu" data-shortcut-layer>
          <button role="menuitem" onClick={() => { setMenu(false); onExtend(token, moreButton.current as HTMLElement); }}><Clock size={15} />{t.connExtend}</button>
          <button role="menuitem" disabled={!token.issuedByViewer} title={token.issuedByViewer ? undefined : t.connRotateNotYours(token.createdByName)}
            onClick={() => { setMenu(false); onRotate(token, moreButton.current as HTMLElement); }}><KeyRound size={15} />{t.connRotate}</button>
          <button role="menuitem" onClick={() => { setMenu(false); onSetup(token, moreButton.current as HTMLElement); }}><Terminal size={15} />{t.connSetup}</button>
          {/* Renaming only changes the label, so it follows the actions that change the credential itself. */}
          <button role="menuitem" disabled={editing} onClick={() => { setMenu(false); setDraft(token.name); renaming.current = true; setEditing(true); }}><Pencil size={15} />{t.connectionRename}</button>
        </div>}
      </div>
    </div>
    {confirming && <div className="confirm" role="alert" data-shortcut-layer
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setConfirming(false); } }}>
      <span>{t.revokeAsk(token.name)}</span>
      <button ref={cancel} type="button" className="btn" onClick={() => setConfirming(false)}>{t.cancel}</button>
      <button type="button" className="btn danger" disabled={busy} onClick={() => { setConfirming(false); onRevoke(token); }}>{t.revokeYes}</button>
    </div>}
  </div>;
}

/** Usable connections in groups. Member groups carry the issuer's "revoke all"; device groups are only a way to browse. */
export default function ConnectionList({ tokens, active, devices, currentDeviceId, groupBy, now, onRevokeGroup, onOffboard, ...actions }: Actions & {
  tokens: readonly TokenInfo[]; devices: readonly Device[]; currentDeviceId: string | null; groupBy: ConnectionGroupBy; now: number;
  /** Every usable connection, so a group's revoke covers the issuer's whole set even while filters hide some of it. */
  active: readonly TokenInfo[];
  onRevokeGroup: (tokens: readonly TokenInfo[], trigger: HTMLElement) => void;
  /** Another member's group offers the guided removal instead of a bare "revoke all". */
  onOffboard: (issuerRef: string, name: string | null, trigger: HTMLElement) => void;
}) {
  const { t } = useLang();
  // Who issued a connection is only worth a line on each row when more than one member has issued them.
  const severalIssuers = new Set(active.map(token => token.issuerRef)).size > 1;
  return <div className="token-list" role="group" aria-label={t.tokensGroup}>
    {groupConnections(tokens, groupBy, devices, AGENT_PROFILES, currentDeviceId).map(group => {
      const issuerSet = group.issuerRef === null ? [] : active.filter(token => token.issuerRef === group.issuerRef);
      const name = group.clientId !== null ? AGENT_PROFILES.find(profile => profile.id === group.clientId)?.label ?? t.connClientOther
        : group.issuerRef === null ? group.device?.name ?? t.connectionUnbound
        : group.issuerName ? group.viewer ? t.connYou(group.issuerName) : group.issuerName : t.issuerUnknown;
      const byDevice = groupBy === "device";
      return <section className="connection-group" key={group.key} data-line={group.device?.line ?? "neutral"} data-by={groupBy}>
        <div className="connection-group-head"><h3><i aria-hidden="true" />{name}</h3>
          {byDevice && group.device?.id === currentDeviceId && <small className="conn-here">{t.thisDevice}</small>}
          {byDevice && group.device && <code className="conn-device-id">{group.device.id}</code>}
          {(byDevice || group.clientId !== null) && <small>{t.connGroupActive(group.items.length)}</small>}
          {group.issuerRef !== null && <small>{t.connGroupActive(issuerSet.length)}</small>}
          {group.issuerRef !== null && (group.viewer
            ? <button type="button" className="btn small" disabled={actions.busy}
                onClick={event => onRevokeGroup(issuerSet, event.currentTarget)}>{t.connRevokeAll(issuerSet.length)}</button>
            : <button type="button" className="btn small" disabled={actions.busy}
                onClick={event => onOffboard(group.issuerRef as string, group.issuerName, event.currentTarget)}>{t.offOpen}</button>)}</div>
        {group.items.map(token => <ConnectionRow key={token.id} token={token} devices={devices} now={now} showIssuer={byDevice && severalIssuers} showClient={groupBy !== "client"} groupDevice={byDevice ? group.device : null} {...actions} />)}
      </section>;
    })}
  </div>;
}
