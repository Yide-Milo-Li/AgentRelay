"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import type { CurrentDevice } from "@/features/devices/hooks/use-current-device";

type Props = { devices: readonly Device[]; current: CurrentDevice; onSelect: (device: Device) => void; onManage: () => void };

const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"])';

/** The top-bar "This device" control: registered devices, the current unregistered name if any, and a way to manage them. */
export default function DevicePicker({ devices, current, onSelect, onManage }: Props) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selectedId = current.registered ? current.id : null;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    const items = wrapRef.current?.querySelectorAll<HTMLElement>(ITEMS);
    const checked = wrapRef.current?.querySelector<HTMLElement>('[aria-checked="true"]:not([aria-disabled="true"])');
    (checked ?? items?.[0])?.focus();
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function dismiss() { setOpen(false); trigger.current?.focus(); }
  function choose(device: Device) { dismiss(); if (device.id !== selectedId) onSelect(device); }

  function onKeyDown(event: KeyboardEvent) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      return;
    }
    if (event.key === "Escape") {
      // Consume Escape for the open menu so the global handler leaves the page alone.
      event.preventDefault(); dismiss(); return;
    }
    if (event.key === "Tab") { setOpen(false); return; }
    const items = Array.from(wrapRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  }

  return <div className="device-pick-wrap" ref={wrapRef} onKeyDown={onKeyDown} data-menu-open={open || undefined}>
    <button ref={trigger} type="button" className="device-pick" title={t.thisDevice} aria-haspopup="menu" aria-expanded={open}
      aria-label={current.chosen ? `${t.thisDevice}: ${current.name}` : t.chooseThisDevice} data-unchosen={!current.chosen || undefined} onClick={() => setOpen(value => !value)}>
      <i className="here" data-line={current.line} aria-hidden="true" />
      <span className="device-caption" aria-hidden="true">{t.thisDevice}</span>
      <span className="device-current" aria-hidden="true">{current.chosen ? current.name : t.chooseShort}</span>
      <ChevronDown className="device-chevron" size={14} aria-hidden="true" />
    </button>
    {open && <div className="menu device-menu" role="menu" aria-label={t.thisDevice} data-shortcut-layer>
      {devices.map(device => {
        const checked = device.id === selectedId;
        return <button key={device.id} type="button" role="menuitemradio" aria-checked={checked} data-line={device.line} onClick={() => choose(device)}>
          <i className="stop" aria-hidden="true" /><span className="device-menu-name">{device.name}</span>
          {checked && <Check className="device-menu-check" size={15} aria-hidden="true" />}
        </button>;
      })}
      {current.chosen && !current.registered && <div role="menuitemradio" aria-checked="true" aria-disabled="true" className="device-menu-unregistered" data-line={current.line}>
        <i className="stop" aria-hidden="true" /><span className="device-menu-name">{current.name}</span>
        <span className="chip">{t.notRegistered}</span>
      </div>}
      <hr role="separator" />
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={15} aria-hidden="true" />{t.manageDevices}</button>
    </div>}
  </div>;
}
