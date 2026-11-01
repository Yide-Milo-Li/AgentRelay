"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Device } from "@/shared/contracts/devices";
import { deviceNameKey } from "@/shared/formatting/device-identity";
import type { DeviceRegistry } from "@/features/devices/hooks/use-device-registry";
import type { CurrentDevice } from "@/features/devices/hooks/use-current-device";
import DeviceCreateForm from "@/features/devices/components/DeviceCreateForm";
import DeviceRow from "@/features/devices/components/DeviceRow";

type Props = {
  registry: DeviceRegistry; current: CurrentDevice;
  /** Names found on real handoffs that match no registered device. */
  seen: string[];
  /** Usable connections per device id; `null` while unknown. */
  connections: ReadonlyMap<string, number> | null; onOpenConnections: (deviceId: string) => void;
  onUseHere: (device: Device) => void; onChanged: () => void; notify: (message: string) => void;
};

export default function DevicesView({ registry, current, seen, connections, onOpenConnections, onUseHere, onChanged, notify }: Props) {
  const { t, errorText } = useLang();
  const [adding, setAdding] = useState<string | null>(null), [other, setOther] = useState(false);
  async function add(name: string, id?: string) {
    setAdding(name);
    try { const device = await registry.create({ name, id }); notify(t.toastDeviceAdded(device.name)); onChanged(); }
    catch (e) { notify(errorText(e)); } finally { setAdding(null); }
  }

  const empty = registry.loaded && registry.devices.length === 0 && !registry.error;
  // The three common machines map to fixed ids in either language. A name this browser already uses comes first.
  const common = [{ id: "laptop", name: t.devices[0] }, { id: "desktop", name: t.devices[1] }, { id: "phone", name: t.devices[2] }];
  const legacy = current.chosen && !current.registered && !common.some(chip => deviceNameKey(chip.name) === deviceNameKey(current.name)) ? [{ id: undefined, name: current.name }] : [];
  const chips: { id: string | undefined; name: string }[] = [...legacy, ...common];
  const chipKeys = new Set(chips.map(chip => deviceNameKey(chip.name)));
  const shownSeen = empty ? seen.filter(name => !chipKeys.has(deviceNameKey(name))) : seen;

  return <section className="guide devices" aria-labelledby="devices-title">
    <header className="guide-head"><h1 id="devices-title">{t.devicesTitle}</h1><p>{t.devicesBody}</p></header>

    {!registry.loaded ? <p className="muted devices-note">{t.devicesLoading}</p>
      : !!registry.error && registry.devices.length === 0 ? <p role="alert" className="form-error devices-note">{errorText(registry.error)} <button className="link" onClick={() => registry.refresh()}>{t.retry}</button></p>
      : empty ? <div className="device-onboarding">
          <h2>{t.devicesEmptyTitle}</h2><p>{t.devicesEmptyBody}</p>
          <div className="chips">{chips.map(chip => <button key={chip.name} className="btn" disabled={adding !== null} aria-label={t.deviceChipLabel(chip.name)} onClick={() => add(chip.name, chip.id)}><Plus size={15} aria-hidden="true" />{chip.name}</button>)}
            {/* One way to add at a time: the full form only when none of the common machines fits. */}
            {!other && <button className="btn quiet" onClick={() => setOther(true)}>{t.deviceOther}</button>}</div>
        </div>
      : <ul className="device-list" aria-label={t.devicesGroup}>
          {registry.devices.map(device => <DeviceRow key={device.id} device={device} isCurrent={current.id === device.id} registry={registry} connections={connections?.get(device.id) ?? 0} onOpenConnections={onOpenConnections} onUseHere={onUseHere} onChanged={onChanged} notify={notify} />)}
        </ul>}

    {registry.loaded && (!empty || other) && <div className="panel device-add">
      <div className="panel-head"><span>{t.deviceNew}</span></div>
      <DeviceCreateForm registry={registry} notify={notify} onCreated={onChanged} />
    </div>}

    {shownSeen.length > 0 && <div className="device-seen">
      <h2>{t.devicesSeenTitle}</h2>
      <p className="muted">{t.devicesSeenBody}</p>
      <ul>{shownSeen.map(name => <li key={name}><span>{name}</span>
        <button className="btn small" disabled={adding !== null} aria-label={`${t.deviceAddSeen}: ${name}`} onClick={() => add(name)}><Plus size={14} aria-hidden="true" />{t.deviceAddSeen}</button></li>)}</ul>
    </div>}
  </section>;
}
