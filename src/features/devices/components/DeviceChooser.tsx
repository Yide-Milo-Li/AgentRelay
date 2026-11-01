"use client";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import { deviceNameKey } from "@/shared/formatting/device-identity";
import type { DeviceRegistry } from "@/features/devices/hooks/use-device-registry";
import DeviceCreateForm from "@/features/devices/components/DeviceCreateForm";

type Props = { registry: DeviceRegistry; currentId: string | null; onChoose: (device: Device) => void; onClose: () => void; notify: (message: string) => void };

/**
 * "Which device is this?": the registered devices to pick from, the common machines not registered yet, and a form for
 * any other. Adding a device here also makes it this browser's device, because that is the question being answered.
 */
export default function DeviceChooser({ registry, currentId, onChoose, onClose, notify }: Props) {
  const { t, errorText } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLButtonElement>(null);
  const [other, setOther] = useState(false), [adding, setAdding] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); first.current?.focus(); }, []);
  const taken = new Set(registry.devices.flatMap(device => [device.id, deviceNameKey(device.name)]));
  // The three common machines map to fixed ids in either language, offered until they are registered.
  const common = [{ id: "laptop", name: t.devices[0] }, { id: "desktop", name: t.devices[1] }, { id: "phone", name: t.devices[2] }]
    .filter(chip => !taken.has(chip.id) && !taken.has(deviceNameKey(chip.name)));
  const choose = (device: Device) => { onChoose(device); onClose(); };
  async function add(name: string, id: string) {
    setAdding(name);
    try { const device = await registry.create({ name, id }); notify(t.toastDeviceAdded(device.name)); choose(device); }
    catch (e) { notify(errorText(e)); } finally { setAdding(null); }
  }
  return <dialog ref={dialog} className="identity-dialog device-chooser" data-shortcut-layer aria-labelledby="chooser-title" aria-describedby="chooser-body"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="chooser-title">{t.chooserTitle}</h2>
    <p id="chooser-body">{t.chooserBody}</p>
    {registry.devices.length > 0 && <div className="chooser-list" role="group" aria-label={t.devicesGroup}>
      {registry.devices.map((device, i) => <button key={device.id} ref={i === 0 ? first : undefined} type="button" className="choice" data-line={device.line}
        aria-pressed={device.id === currentId} onClick={() => choose(device)}>
        <i aria-hidden="true" /><span>{device.name}</span><code>{device.id}</code></button>)}
    </div>}
    <div className="chips">
      {common.map((chip, i) => <button key={chip.id} ref={i === 0 && !registry.devices.length ? first : undefined} type="button" className="btn" disabled={adding !== null}
        aria-label={t.deviceChipLabel(chip.name)} onClick={() => add(chip.name, chip.id)}><Plus size={15} aria-hidden="true" />{chip.name}</button>)}
      {!other && <button type="button" className="btn quiet" onClick={() => setOther(true)}>{t.deviceOther}</button>}
    </div>
    {other && <DeviceCreateForm registry={registry} notify={notify} onCreated={choose} />}
    <div className="wizard-actions"><button type="button" className="btn" onClick={onClose}>{t.cancel}</button></div>
  </dialog>;
}
