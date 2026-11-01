"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { resolveStop, type DeviceIndex } from "@/shared/formatting/device-identity";

type Props = {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  devices: DeviceIndex;
  suggestions: readonly string[];
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  placeholder?: string;
};

export default function DeviceCombobox({
  name,
  label,
  value,
  onChange,
  devices,
  suggestions,
  disabled = false,
  required = false,
  maxLength = 80,
  autoFocus,
  placeholder,
}: Props) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  const currentStop = resolveStop(devices, null, value, t.devices[3]);

  // Unique suggestions list
  const allSuggestions = Array.from(new Set(suggestions.map(s => s.trim()).filter(Boolean)));

  const filtered = isFiltering && value.trim()
    ? allSuggestions.filter(item => {
        const key = item.toLowerCase();
        const query = value.trim().toLowerCase();
        if (key.includes(query)) return true;
        const dev = devices.byNameKey.get(item.toLowerCase());
        return dev ? dev.id.toLowerCase().includes(query) : false;
      })
    : allSuggestions;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setIsFiltering(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function selectDevice(item: string) {
    onChange(item);
    setOpen(false);
    setIsFiltering(false);
  }

  function toggleOpen() {
    if (disabled) return;
    setOpen(prev => {
      const next = !prev;
      if (next) setIsFiltering(false);
      return next;
    });
  }

  function handleInputClick() {
    if (disabled) return;
    if (!open) {
      setOpen(true);
      setIsFiltering(false);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
    setIsFiltering(true);
    if (!open) setOpen(true);
  }
  function handleBlur() {
    const trimmed = value.trim();
    if (!trimmed) return;
    const match = allSuggestions.find(s => s.toLowerCase() === trimmed.toLowerCase());
    if (match && match !== value) onChange(match);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setIsFiltering(false);
        inputRef.current?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      if (!open) {
        event.preventDefault();
        setOpen(true);
        setIsFiltering(false);
        return;
      }
      event.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = at >= 0 ? (at + 1) % items.length : 0;
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === "ArrowUp") {
      if (open) {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (at <= 0) {
          inputRef.current?.focus();
        } else {
          items[at - 1]?.focus();
        }
      }
      return;
    }
    if (event.key === "Tab") {
      if (open) {
        setOpen(false);
        setIsFiltering(false);
      }
    }
  }

  return (
    <div className="field" data-line={currentStop.line}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="device-combobox-wrap" ref={wrapRef} onKeyDown={handleKeyDown}>
        <span className="line-input">
          <i aria-hidden="true" />
          <input
            ref={inputRef}
            id={inputId}
            name={name}
            value={value}
            onChange={handleInputChange}
            onClick={handleInputClick}
            onBlur={handleBlur}
            required={required}
            maxLength={maxLength}
            disabled={disabled}
            autoFocus={autoFocus}
            placeholder={placeholder}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? `${inputId}-listbox` : undefined}
          />
          <button
            type="button"
            className="device-toggle"
            tabIndex={-1}
            aria-label={label}
            aria-expanded={open}
            disabled={disabled}
            onClick={toggleOpen}
          >
            <ChevronDown className="device-chevron" size={14} aria-hidden="true" />
          </button>
        </span>
        {open && (
          <div
            ref={menuRef}
            id={`${inputId}-listbox`}
            className="menu device-menu device-combobox-menu"
            role="listbox"
            aria-label={label}
            data-shortcut-layer
          >
            {filtered.length > 0 ? (
              filtered.map(item => {
                const stop = resolveStop(devices, null, item, t.devices[3]);
                const checked = item.trim().toLowerCase() === value.trim().toLowerCase();
                return (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    data-line={stop.line}
                    onClick={() => selectDevice(item)}
                  >
                    <i className="stop" aria-hidden="true" />
                    <span className="device-menu-name">{item}</span>
                    {checked && <Check className="device-menu-check" size={15} aria-hidden="true" />}
                  </button>
                );
              })
            ) : (
              <div className="device-combobox-empty">{t.deviceNoMatch}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
