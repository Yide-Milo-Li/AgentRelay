"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Ellipsis, Palette, Pencil, Trash2 } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { copyText } from "@/shared/browser/clipboard";
import { DEVICE_NAME_MAX, type Device, type DeviceLine, type DeviceUsage } from "@/shared/contracts/devices";
import type { DeviceRegistry } from "@/features/devices/hooks/use-device-registry";
import LineSwatches from "@/features/devices/components/LineSwatches";

type Props = {
  device: Device; isCurrent: boolean; registry: DeviceRegistry;
  /** Usable connections bound to this device; the row links to them when there are any. */
  connections: number; onOpenConnections: (deviceId: string) => void;
  onUseHere: (device: Device) => void; onChanged: () => void; notify: (message: string) => void;
};

export default function DeviceRow({ device, isCurrent, registry, connections, onOpenConnections, onUseHere, onChanged, notify }: Props) {
  const { t, errorText } = useLang();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(device.name), [colouring, setColouring] = useState(false);
  const [menu, setMenu] = useState(false), [confirming, setConfirming] = useState(false), [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState<DeviceUsage | null>(null), [revoke, setRevoke] = useState(false), [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), moreButton = useRef<HTMLButtonElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null), renaming = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => { if (editing) { nameInput.current?.focus(); nameInput.current?.select(); } }, [editing]);
  useEffect(() => { if (confirming) cancelDelete.current?.focus(); }, [confirming]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);

  function startRename() { setMenu(false); setDraft(device.name); renaming.current = true; setEditing(true); }
  async function saveName() {
    // Enter and the blur it causes both arrive here; only the first one counts.
    if (!renaming.current) return;
    renaming.current = false; setEditing(false);
    const next = draft.trim();
    if (!next || next === device.name) return;
    setBusy(true);
    try { await registry.update(device, { name: next }); notify(t.toastDeviceRenamed); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  function cancelRename() { renaming.current = false; setEditing(false); }
  async function recolour(line: DeviceLine) {
    setColouring(false);
    if (line === device.line) return;
    setBusy(true);
    try { await registry.update(device, { line }); notify(t.toastDeviceColour); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function copyId() { try { await copyText(device.id); setCopied(true); notify(t.toastDeviceIdCopied); } catch (e) { notify(errorText(e)); } }
  function askDelete() {
    setMenu(false); setConfirming(true); setRevoke(false); setUsage(null);
    registry.usage(device.id).then(setUsage, e => notify(errorText(e)));
  }
  async function confirmDelete() {
    setBusy(true);
    try {
      await registry.remove(device, revoke ? "revoke" : "unbind");
      notify(t.toastDeviceDeleted(device.name)); onChanged();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }
  const uses = usage ? [usage.openHandoffs && t.deviceUsageHandoffs(usage.openHandoffs), usage.connections && t.deviceUsageConnections(usage.connections)].filter(Boolean).join(", ") : "";

  return <li className="device-row" data-line={device.line} data-current={isCurrent || undefined} data-menu-open={menu || undefined}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      // Consume Escape for the innermost open layer so the global handler leaves the page alone.
      if (menu) { setMenu(false); moreButton.current?.focus(); }
      else if (confirming) { setConfirming(false); moreButton.current?.focus(); }
      else if (colouring) setColouring(false);
      else return;
      event.preventDefault();
    }}>
    <div className="device-head">
      <button type="button" className="device-dot" aria-label={`${t.deviceColour}: ${device.name}`} aria-expanded={colouring} disabled={busy} onClick={() => setColouring(value => !value)}><i aria-hidden="true" /></button>
      <div className="device-title">
        {editing
          ? <input ref={nameInput} className="device-rename" aria-label={t.deviceRenameLabel(device.name)} value={draft} maxLength={DEVICE_NAME_MAX}
              onChange={event => setDraft(event.target.value)} onBlur={saveName}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveName(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename(); } }} />
          : <strong>{device.name}</strong>}
        {isCurrent && <span className="chip">{t.thisDevice}</span>}
      </div>
      <div className="device-meta">
        <span className="id-chip"><code>{device.id}</code>
          <button type="button" className="icon small" title={t.deviceCopyId} aria-label={`${t.deviceCopyId}: ${device.id}`} onClick={copyId}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></span>
        {connections > 0 && <button type="button" className="link" aria-label={t.deviceConnectionsOpen(device.name)} onClick={() => onOpenConnections(device.id)}>{t.deviceConnectionsLink(connections)}</button>}
        {!isCurrent && <button type="button" className="btn small" onClick={() => onUseHere(device)}>{t.useHere}</button>}
      </div>
      <div className="menu-wrap" ref={menuRef} data-menu-open={menu || undefined}>
        <button ref={moreButton} type="button" className="icon" title={t.more} aria-label={t.deviceMenu(device.name)} aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu(value => !value)}><Ellipsis size={17} /></button>
        {menu && <div className="menu" role="menu" data-shortcut-layer>
          <button role="menuitem" onClick={startRename}><Pencil size={15} />{t.deviceRename}</button>
          <button role="menuitem" onClick={() => { setMenu(false); setColouring(true); }}><Palette size={15} />{t.deviceColour}</button>
          <button role="menuitem" className="danger" onClick={askDelete}><Trash2 size={15} />{t.deviceDelete}</button>
        </div>}
      </div>
    </div>
    {colouring && <LineSwatches value={device.line} disabled={busy} onChange={recolour} />}
    {confirming && <div className="confirm device-confirm" role="alert" data-shortcut-layer>
      <div>
        <strong>{t.deviceDeleteAsk(device.name)}</strong>
        <p>{usage === null ? "" : uses ? t.deviceDeleteUses(uses) : t.deviceDeleteNone} {t.deviceDeleteNote}</p>
        {!!usage?.connections && <label className="check"><input type="checkbox" checked={revoke} onChange={event => setRevoke(event.target.checked)} />{t.deviceRevokeToo(usage.connections)}</label>}
      </div>
      <button ref={cancelDelete} className="btn" onClick={() => { setConfirming(false); moreButton.current?.focus(); }}>{t.cancel}</button>
      <button className="btn danger" disabled={busy} onClick={confirmDelete}>{t.deviceDeleteYes}</button>
    </div>}
  </li>;
}
