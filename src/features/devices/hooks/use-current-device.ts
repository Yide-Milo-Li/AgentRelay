"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { DeviceLine } from "@/shared/contracts/devices";
import { heuristicLine, lookupDevice, type DeviceIndex } from "@/shared/formatting/device-identity";

// v2 stores the registry id. v1 stored only the name; it is read once to migrate and kept in step so
// an older tab, or a device that has since been deleted, still has a name to fall back to.
const ID_KEY = "agentrelay.device.v2";
const NAME_KEY = "agentrelay.device.v1";
// Set when a person picks the device. Earlier versions wrote a default name on first visit without asking, so a stored
// device without this mark may be a guess.
const CHOSEN_KEY = "agentrelay.device.chosen.v1";
const listeners = new Set<() => void>();
// Keeps the choice for this tab when storage is blocked (private windows, strict policies).
const memory: Record<string, string | null> = { [ID_KEY]: null, [NAME_KEY]: null, [CHOSEN_KEY]: null };

function read(key: string) {
  const held = memory[key];
  if (held !== null) return held;
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

function write(key: string, value: string) {
  if (read(key) === value) return;
  memory[key] = value;
  try { localStorage.setItem(key, value); } catch { /* Cloud records never depend on browser storage. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  // Other tabs changing the device fire "storage"; drop the tab-local copy so the new value wins.
  const onStorage = (event: StorageEvent) => {
    if (event.key === ID_KEY || event.key === NAME_KEY || event.key === CHOSEN_KEY) { memory[event.key] = null; listener(); }
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/**
 * `chosen` is false until this browser has been told which device it is; `name` is then empty. `confirmed` is true once
 * a person picked it in this version; a device stored by an earlier version without that is not confirmed.
 */
export type CurrentDevice = { id: string | null; name: string; line: DeviceLine; registered: boolean; chosen: boolean; confirmed: boolean };

/**
 * The device this browser acts as. A registered device follows renames by id. A name that is not registered, or
 * whose device was deleted, stays usable as plain text and links automatically once a device with that name exists.
 * `ready` means the registry loaded successfully, so an empty list is trusted. A browser with nothing stored has no
 * device: guessing a name would let a second machine pass as the first one once that name is registered.
 */
export function useCurrentDevice(index: DeviceIndex, ready: boolean) {
  const storedId = useSyncExternalStore(subscribe, () => read(ID_KEY), () => "");
  const storedName = useSyncExternalStore(subscribe, () => read(NAME_KEY), () => "");
  const confirmed = useSyncExternalStore(subscribe, () => read(CHOSEN_KEY), () => "") === "1";
  const device = (storedId ? index.byId.get(storedId) : undefined) ?? (storedName ? lookupDevice(index, storedName) : undefined);

  useEffect(() => {
    if (!ready) return;
    if (device) {
      write(ID_KEY, device.id);
      write(NAME_KEY, device.name);
    } else if (storedId) write(ID_KEY, "");
  }, [ready, device, storedId]);

  const current: CurrentDevice = device
    ? { id: device.id, name: device.name, line: device.line, registered: true, chosen: true, confirmed }
    : { id: null, name: storedName, line: storedName ? heuristicLine(storedName) : "neutral", registered: false, chosen: !!(storedName || storedId), confirmed };
  const select = useCallback((target: { id: string | null; name: string }) => {
    write(ID_KEY, target.id ?? "");
    write(NAME_KEY, target.name);
    write(CHOSEN_KEY, "1");
  }, []);
  /** The person says the stored device is right. */
  const confirm = useCallback(() => write(CHOSEN_KEY, "1"), []);
  return { current, select, confirm };
}
