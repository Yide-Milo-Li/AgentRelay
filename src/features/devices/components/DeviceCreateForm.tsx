"use client";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import { DEVICE_ID_MAX, DEVICE_NAME_MAX } from "@/shared/contracts/devices";
import { deviceNameKey, isValidDeviceId, randomDeviceSuffix, suggestDeviceId } from "@/shared/formatting/device-identity";
import type { DeviceRegistry } from "@/features/devices/hooks/use-device-registry";

type Props = { registry: DeviceRegistry; notify: (message: string) => void; onCreated: (device: Device) => void };

/** Name plus id. The id follows the name until the person edits it, then stays exactly as typed. */
export default function DeviceCreateForm({ registry, notify, onCreated }: Props) {
  const { t, errorText } = useLang();
  const [name, setName] = useState(""), [typedId, setTypedId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  // A fixed suffix keeps the live suggestion of a non-ASCII name from changing on every render.
  const [suffix] = useState(() => randomDeviceSuffix());
  const taken = useMemo(() => registry.devices.flatMap(device => [device.id, deviceNameKey(device.name)]), [registry.devices]);
  const suggested = name.trim() ? suggestDeviceId(name, taken, suffix) : "";
  const id = typedId || suggested;
  const idProblem = !!id && !isValidDeviceId(id);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !id || idProblem) return;
    setBusy(true); setError(null);
    try {
      const device = await registry.create({ name, id });
      setName(""); setTypedId("");
      notify(t.toastDeviceAdded(device.name)); onCreated(device);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <form className="device-form" onSubmit={submit} aria-label={t.deviceNew}>
    <label className="field grow">{t.deviceName}
      <input value={name} onChange={e => setName(e.target.value)} maxLength={DEVICE_NAME_MAX} placeholder={t.deviceNamePh} required disabled={busy} autoComplete="off" /></label>
    <label className="field device-id-field">{t.deviceIdLabel}
      <input className="mono" value={id} onChange={e => setTypedId(e.target.value.trim().toLowerCase())} maxLength={DEVICE_ID_MAX} spellCheck={false} autoComplete="off"
        aria-invalid={idProblem || undefined} aria-describedby="device-id-hint" required disabled={busy} /></label>
    <button className="btn primary" disabled={busy || !name.trim() || !id || idProblem}><Plus size={16} aria-hidden="true" />{busy ? t.deviceAdding : t.deviceAdd}</button>
    <p id="device-id-hint" className={idProblem ? "form-error" : "muted"}>{idProblem ? t.deviceIdInvalid : t.deviceIdHint}</p>
    {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
  </form>;
}
