"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import { formatDay, formatTime } from "@/shared/formatting/date";
import { formatRelative } from "@/shared/formatting/relative-time";
import type { Device } from "@/shared/contracts/devices";
import type { ConnectionEvent, ConnectionEventsPage } from "@/shared/contracts/agent-tokens";

const PAGE = 30;
const url = (before: string | null) => `/api/agent-tokens/events?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Connection history in a side panel. Entries are plain text; names and actors come from members and are never interpreted. */
export default function ActivityDrawer({ devices, trigger, onClose }: { devices: readonly Device[]; trigger: HTMLElement | null; onClose: () => void }) {
  const { t, locale, errorText } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]), [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<unknown>(null), [now, setNow] = useState(0);

  useEffect(() => {
    dialog.current?.showModal(); closeButton.current?.focus();
    let active = true;
    api<ConnectionEventsPage>(url(null)).then(page => { if (active) { setEvents(page.events); setNext(page.nextBefore); setNow(Date.now()); } })
      .catch(e => { if (active) setError(e); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function more() {
    setLoading(true); setError(null);
    try { const page = await api<ConnectionEventsPage>(url(next)); setEvents(old => [...old, ...page.events]); setNext(page.nextBefore); setNow(Date.now()); }
    catch (e) { setError(e); } finally { setLoading(false); }
  }
  const done = () => { onClose(); requestAnimationFrame(() => trigger?.focus()); };

  function describe(event: ConnectionEvent) {
    const who = event.actorName ?? t.activityUnknownActor, name = event.tokenName, detail = event.detail ?? {}, line = t.activityLine;
    const device = (id: unknown) => (typeof id === "string" ? devices.find(item => item.id === id)?.name ?? id : null);
    switch (event.kind) {
      case "created": return line.created(who, name);
      case "renamed": return line.renamed(who, text(detail.from), text(detail.to) || name);
      case "relabeled": return line.relabeled(who, name, device(detail.to));
      case "revoked": return detail.reason === "offboarding" ? line.revokedWithMember(who, name) : detail.reason === "device_deleted" ? line.revokedDeviceDeleted(who, name) : line.revoked(who, name);
      case "bulk_revoked": return line.bulk_revoked(who, typeof detail.count === "number" ? detail.count : 0, detail.issuer === null || detail.issuer === undefined ? null : text(detail.issuer) || t.issuerUnknown);
      case "extended": {
        if (typeof detail.to !== "number") return line.madePermanent(who, name);
        const until = formatDay(detail.to, locale);
        return typeof detail.from === "number" && detail.to < detail.from ? line.shortened(who, name, until) : line.extended(who, name, until);
      }
      case "rotated": return line.rotated(who, name);
      case "removed": return line.removed(who, name);
      default: return `${who} · ${event.kind} · ${name}`;
    }
  }

  return <dialog ref={dialog} className="identity-dialog activity-dialog" data-shortcut-layer aria-labelledby="activity-title"
    onCancel={event => { event.preventDefault(); done(); }}
    onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) done(); } }}>
    <div className="activity-head"><h2 id="activity-title">{t.activityTitle}</h2>
      <button ref={closeButton} type="button" className="btn quiet small" aria-label={t.activityClose} onClick={done}><X size={16} aria-hidden="true" /></button></div>
    <p className="muted">{t.activityBody}</p>
    {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
    {!loading && !error && !events.length && <p className="muted">{t.activityEmpty}</p>}
    {events.length > 0 && <ol className="activity-list">{events.map(event => <li key={event.id}>
      <span>{describe(event)}</span><time dateTime={new Date(event.at).toISOString()} title={formatTime(event.at, locale)}>{formatRelative(event.at, now, locale)}</time></li>)}</ol>}
    {loading && <p className="muted">{t.activityLoading}</p>}
    {next && !loading && <button type="button" className="btn more" onClick={() => void more()}>{t.activityMore}</button>}
  </dialog>;
}
