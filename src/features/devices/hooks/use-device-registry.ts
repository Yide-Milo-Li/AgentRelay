"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/shared/http/client";
import type { DeletedDevice, Device, DeviceConnectionAction, DeviceLine, DeviceUsage } from "@/shared/contracts/devices";
import { indexDevices, type DeviceIndex } from "@/shared/formatting/device-identity";

export type DeviceRegistry = {
  devices: readonly Device[];
  index: DeviceIndex;
  /** True once the first fetch has finished, whether or not it succeeded. */
  loaded: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  create: (input: { name: string; id?: string; line?: DeviceLine }) => Promise<Device>;
  update: (device: Device, patch: { name?: string; line?: DeviceLine }) => Promise<Device>;
  remove: (device: Device, connections: DeviceConnectionAction) => Promise<DeletedDevice>;
  usage: (id: string) => Promise<DeviceUsage>;
};

/** The signed-in owner's devices. Mutations update the list in place and are never undone by an older refresh. */
export function useDeviceRegistry(): DeviceRegistry {
  const [devices, setDevices] = useState<readonly Device[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState<unknown>(null);
  const flight = useRef(false), epoch = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    if (flight.current) return Promise.resolve();
    flight.current = true;
    const started = epoch.current;
    return api<{ devices: Device[] }>("/api/devices")
      // A mutation that finished while this request was in flight is newer than its answer.
      .then(result => { if (started === epoch.current) { setDevices(result.devices); setError(null); } }, e => setError(e))
      .finally(() => { flight.current = false; setLoaded(true); });
  }, []);
  useEffect(() => {
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refresh]);

  const create = useCallback<DeviceRegistry["create"]>(async input => {
    const device = await api<Device>("/api/devices", "POST", input);
    epoch.current++;
    setDevices(old => [...old.filter(item => item.id !== device.id), device]);
    return device;
  }, []);
  const update = useCallback<DeviceRegistry["update"]>(async (device, patch) => {
    const updated = await api<Device>(`/api/devices/${device.id}`, "PATCH", { version: device.version, ...patch });
    epoch.current++;
    setDevices(old => old.map(item => item.id === updated.id ? updated : item));
    return updated;
  }, []);
  const remove = useCallback<DeviceRegistry["remove"]>(async (device, connections) => {
    const result = await api<DeletedDevice>(`/api/devices/${device.id}`, "DELETE", { version: device.version, connections });
    epoch.current++;
    setDevices(old => old.filter(item => item.id !== device.id));
    return result;
  }, []);
  const usage = useCallback(async (id: string) => (await api<{ usage: DeviceUsage }>(`/api/devices/${id}`)).usage, []);

  const index = useMemo(() => indexDevices(devices), [devices]);
  return { devices, index, loaded, error, refresh, create, update, remove, usage };
}
