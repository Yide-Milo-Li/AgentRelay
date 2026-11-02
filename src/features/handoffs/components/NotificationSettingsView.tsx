"use client";
import { useEffect, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import InfoTip from "@/components/ui/InfoTip";
import type { Device } from "@/shared/contracts/devices";
import { EXPIRY_REMINDER_SCOPES, PROGRESS_SCOPES, type ExpiryReminderScope, type ProgressScope } from "@/shared/contracts/notifications";
import { formatRelative } from "@/shared/formatting/relative-time";
import type { NotificationControl } from "../hooks/use-notification-settings";
import { markNotificationHintSeen, readNotificationReceipt, type NotificationReceipt } from "../notification-browser";
import { permissionGuide } from "../notification-state";

type Props = { control: NotificationControl; devices: readonly Device[]; currentDeviceId: string | null; notify: (text: string) => void };

/** The checks for a test notification that never appeared. Folded, because most tests do appear. */
function MissingHelp() {
  const m = useLang().t.notifications.missing;
  return <details className="notification-missing">
    <summary>{m.summary}</summary>
    <ul><li>{m.focus}</li><li>{m.mac}</li><li>{m.running}</li><li>{m.details}</li></ul>
  </details>;
}

/**
 * Settings › Notifications. The state is one sentence in words, never a coloured pill; the options stay visible while
 * notifications are off, disabled, so the person can see what they would get before granting permission. A note that
 * tells the person what to do next stays in view; background on how an option behaves sits behind an information button.
 */
export default function NotificationSettingsView({ control, devices, currentDeviceId, notify }: Props) {
  const { t, locale, errorText } = useLang(), n = t.notifications;
  const { state, settings } = control, row = settings?.subscription ?? null, on = state === "on";
  const [picked, setPicked] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<NotificationReceipt | null>(null), [opened, setOpened] = useState(false);
  // Looking at this page once is enough to retire the footer reminder.
  useEffect(() => { markNotificationHintSeen(); }, []);
  useEffect(() => {
    if (!opened) return;
    let current = true;
    void readNotificationReceipt().then(value => { if (current) setReceipt(value); });
    return () => { current = false; };
  }, [opened, settings]);

  const deviceName = (id: string) => devices.find(device => device.id === id)?.name ?? id;
  const fallbackDevice = devices.find(device => device.id === currentDeviceId)?.id ?? devices[0]?.id ?? "";
  const chosen = row?.deviceId ?? picked ?? fallbackDevice;
  const relative = (value: number) => formatRelative(value, control.readAt, locale);

  const statusText = state === "loading" ? n.status.loading : state === "on" ? n.status.on(deviceName(row?.deviceId ?? chosen)) + (row?.lastAcceptedAt ? ` · ${n.delivered(relative(row.lastAcceptedAt))}` : "")
    : state === "unsupported" ? (control.reason === "api" ? n.status.unsupportedApi : n.status.unsupported) : n.status[state];
  const failing = on && !!row?.lastError && (!row.lastAcceptedAt || (row.lastAttemptAt ?? 0) > row.lastAcceptedAt);
  // Turning on sends a test at once, so the first thing the person reads afterwards is that it is on its way.
  const welcome = on && !failing && control.lastTest?.trigger === "enabled", tested = on && control.lastTest?.trigger === "manual";
  // Permission steps name the browser's own controls; they replace the general note, which says the same thing less exactly.
  const guideKey = permissionGuide(state, control.prompt), guide = guideKey && control.browser ? n.guide[control.browser] : null;
  const note = guide && guideKey ? guide[guideKey] : state === "off" ? (control.hint === "removed" ? n.notes.removed : chosen ? n.notes.off(deviceName(chosen)) : null)
    : state === "unavailable" ? n.notes.unavailable : state === "blocked" ? n.notes.blocked : state === "reconnect" ? n.notes.reconnect
    : failing ? n.notes.failed : welcome ? n.notes.welcome : null;

  const disabled = control.busy || !on;

  return <>
    <section className="setting-group" aria-labelledby="setting-notifications">
      <h2 id="setting-notifications">{n.thisBrowser}</h2>
      <div className="setting-row">
        <div className="setting-text">
          <strong>{n.title}</strong>{guide && guideKey !== "blocked" && <InfoTip label={t.infoAbout(n.title)}><p>{guide.quiet}</p></InfoTip>}
          <p role="status" data-state={state}>{statusText}</p>
          {note && <p className="notification-note" aria-live="polite">{note}</p>}
          {welcome && <MissingHelp />}
        </div>
        {state === "off" && <button type="button" className="btn primary" disabled={control.busy || !chosen} onClick={() => void control.enable(chosen)}>{n.turnOn}</button>}
        {state === "reconnect" && <button type="button" className="btn primary" disabled={control.busy || !row} onClick={() => void control.enable(row?.deviceId ?? chosen)}>{n.reconnectAction}</button>}
        {state === "on" && <button type="button" className="btn" disabled={control.busy} onClick={() => void control.disable()}>{n.turnOff}</button>}
        {state === "error" && <button type="button" className="btn" disabled={control.busy} onClick={() => void control.refresh()}>{t.retry}</button>}
      </div>
      {!!control.error && <p role="alert" className="shortcut-note">{errorText(control.error)}</p>}

      <div className="setting-row">
        <div className="setting-text"><strong><label htmlFor="notification-device">{n.device}</label></strong><InfoTip label={t.infoAbout(n.device)}><p>{n.deviceNote}</p></InfoTip></div>
        <select id="notification-device" className="setting-select" value={chosen} disabled={control.busy || (state !== "off" && !on)}
          onChange={event => { setPicked(event.target.value); if (on) void control.update({ deviceId: event.target.value }); }}>
          {!devices.length && <option value="">{n.noDevice}</option>}
          {devices.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}
        </select>
      </div>

      <div className="setting-row setting-options">
        <div className="setting-text"><strong id="notification-about">{n.about}</strong><p>{n.aboutNote}</p></div>
        <div className="setting-checks" role="group" aria-labelledby="notification-about">
          <label className="shortcut-setting"><input type="checkbox" checked={row?.notifyRequeue ?? true} disabled={disabled} onChange={event => void control.update({ notifyRequeue: event.target.checked })} />{n.requeue}</label>
          <label className="shortcut-setting"><input type="checkbox" checked={row?.notifyAny ?? false} disabled={disabled} onChange={event => void control.update({ notifyAny: event.target.checked })} />{n.any}</label>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <strong><label htmlFor="notification-progress">{n.progress}</label></strong>
          <p>{n.progressNote}</p>
        </div>
        <select id="notification-progress" className="setting-select" value={row?.notifyProgress ?? "done"} disabled={disabled}
          onChange={event => void control.update({ notifyProgress: event.target.value as ProgressScope })}>
          {PROGRESS_SCOPES.map(scope => <option value={scope} key={scope}>{n.progressScope[scope]}</option>)}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <strong><label htmlFor="notification-expiry">{n.expiry}</label></strong><InfoTip label={t.infoAbout(n.expiry)}><p>{n.expiryInfo}</p></InfoTip>
          <p>{n.expiryNote}</p>
        </div>
        <select id="notification-expiry" className="setting-select" value={row?.notifyExpiry ?? "device"} disabled={disabled}
          onChange={event => void control.update({ notifyExpiry: event.target.value as ExpiryReminderScope })}>
          {EXPIRY_REMINDER_SCOPES.map(scope => <option value={scope} key={scope}>{n.expiryScope[scope]}</option>)}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-text"><strong><label htmlFor="notification-details">{n.details}</label></strong><InfoTip label={t.infoAbout(n.details)}><p>{n.detailsNote}</p></InfoTip></div>
        <input id="notification-details" type="checkbox" className="setting-check" checked={row?.showDetails ?? true} disabled={disabled} onChange={event => void control.update({ showDetails: event.target.checked })} />
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <strong>{n.test}</strong><InfoTip label={t.infoAbout(n.test)}><p>{n.testNote}</p></InfoTip><p role="status">{tested ? n.testSent : ""}</p>
          {tested && <MissingHelp />}
        </div>
        <button type="button" className="btn" disabled={disabled} onClick={() => void control.test()}>{n.sendTest}</button>
      </div>

      <details className="notification-details" onToggle={event => setOpened(event.currentTarget.open)}>
        <summary>{n.delivery}</summary>
        <dl>
          <dt>{n.lastAccepted}</dt><dd>{row?.lastAcceptedAt ? relative(row.lastAcceptedAt) : n.never}</dd>
          <dt>{n.lastError}</dt><dd>{row?.lastError ?? n.none}</dd>
          <dt>{n.lastReceived}</dt><dd>{receipt ? relative(receipt.at) : n.noReceipt}</dd>
        </dl>
        <p className="shortcut-note">{n.deliveryNote}</p>
      </details>
    </section>

    {!!settings?.others.length && <section className="setting-group" aria-labelledby="setting-other-browsers">
      <div className="setting-head"><h2 id="setting-other-browsers">{n.others}</h2><InfoTip label={t.infoAbout(n.others)}><p>{n.othersNote}</p></InfoTip></div>
      <ul className="other-browsers">
        {settings.others.map(other => <li key={other.browserId} className="setting-row">
          <div className="setting-text">
            <strong>{other.label ?? n.browserFallback}</strong>
            <p>{[deviceName(other.deviceId), other.enabledBy && n.enabledBy(other.enabledBy), other.disabledAt ? n.expired : other.lastAcceptedAt ? n.delivered(relative(other.lastAcceptedAt)) : n.neverDelivered].filter(Boolean).join(" · ")}</p>
          </div>
          <button type="button" className="btn" disabled={control.busy} onClick={() => { void control.remove(other.browserId).then(done => { if (done) notify(n.removedToast); }); }}>{n.remove}</button>
        </li>)}
      </ul>
    </section>}
    <p className="shortcut-note setting-footnote">{n.osNote}</p>
  </>;
}
