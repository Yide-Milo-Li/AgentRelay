"use client";
import { useLang } from "@/components/providers/LanguageProvider";
import { DEVICE_LINES, type DeviceLine } from "@/shared/contracts/devices";

/** The colour picker: one button per metro line. The selected line is announced through aria-pressed. */
export default function LineSwatches({ value, disabled, onChange }: { value: DeviceLine; disabled?: boolean; onChange: (line: DeviceLine) => void }) {
  const { t } = useLang();
  return <div className="swatches" role="group" aria-label={t.lineLabel}>
    {DEVICE_LINES.map(line => <button key={line} type="button" className="swatch" data-line={line} aria-pressed={value === line}
      aria-label={t.lineNames[line]} title={t.lineNames[line]} disabled={disabled} onClick={() => onChange(line)}><i aria-hidden="true" /></button>)}
  </div>;
}
