import {
  DEVICE_ID_MAX, DEVICE_ID_PATTERN, RESERVED_DEVICE_IDS, RESERVED_DEVICE_NAME_KEYS,
  type Device, type DeviceLine,
} from "@/shared/contracts/devices";
import type { Handoff } from "@/shared/contracts/handoffs";

// Pure helpers shared by the browser and the server, so both sides agree on what a device reference means.

/** NFKC, trimmed, whitespace collapsed, lowercased: the key two device names are compared by. */
export function deviceNameKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isReservedDeviceName(name: string) {
  return RESERVED_DEVICE_NAME_KEYS.includes(deviceNameKey(name));
}

export function isValidDeviceId(id: string) {
  return DEVICE_ID_PATTERN.test(id) && !RESERVED_DEVICE_IDS.includes(id);
}

/** ASCII slug of a name; empty when nothing usable remains (for example a Chinese-only name). */
export function slugifyDeviceId(name: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, DEVICE_ID_MAX).replace(/-+$/, "");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function randomDeviceSuffix(length = 4) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => BASE32[byte % 32]).join("");
}

/**
 * Suggest an id for a name that avoids everything in `taken`: `laptop`, then `laptop-2`, `laptop-3`.
 * A name with no ASCII letters falls back to `device-<suffix>`; pass a fixed `suffix` for a stable live preview.
 */
export function suggestDeviceId(name: string, taken: Iterable<string> = [], suffix = randomDeviceSuffix()) {
  const used = new Set(taken);
  const base = slugifyDeviceId(name) || `device-${suffix}`;
  const free = (id: string) => isValidDeviceId(id) && !used.has(id);
  if (free(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = `-${n}`;
    const candidate = base.slice(0, DEVICE_ID_MAX - tail.length).replace(/-+$/, "") + tail;
    if (free(candidate)) return candidate;
  }
  return `device-${randomDeviceSuffix(6)}`;
}

const AUTO_LINES: readonly DeviceLine[] = ["blue", "amber", "green", "violet", "teal", "brown"];
const SPARE_LINES = ["violet", "teal", "brown"] as const;
const KNOWN_LINES: Record<string, DeviceLine> = {
  desktop: "blue", "台式机": "blue", laptop: "amber", "笔记本": "amber", phone: "green", "手机": "green",
};

/** The colour a device name hashes to when nothing has been chosen: common devices keep theirs, others spread over the spare lines. */
export function heuristicLine(name: string): DeviceLine {
  const key = deviceNameKey(name);
  if (KNOWN_LINES[key]) return KNOWN_LINES[key];
  if (RESERVED_DEVICE_NAME_KEYS.includes(key)) return "neutral";
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return SPARE_LINES[hash % SPARE_LINES.length];
}

/** Prefer the heuristic colour, then the first colour no device uses yet. Neutral is never assigned automatically. */
export function defaultDeviceLine(name: string, used: Iterable<DeviceLine>): DeviceLine {
  const taken = new Set(used);
  const preferred = heuristicLine(name);
  if (preferred !== "neutral" && !taken.has(preferred)) return preferred;
  return AUTO_LINES.find(line => !taken.has(line)) ?? (preferred === "neutral" ? "blue" : preferred);
}

export type DeviceIndex = { devices: readonly Device[]; byId: ReadonlyMap<string, Device>; byNameKey: ReadonlyMap<string, Device> };

export function indexDevices(devices: readonly Device[]): DeviceIndex {
  return { devices, byId: new Map(devices.map(device => [device.id, device])), byNameKey: new Map(devices.map(device => [deviceNameKey(device.name), device])) };
}
export const EMPTY_DEVICE_INDEX = indexDevices([]);

/** Resolve a device id or name, case-insensitively. An id match wins over a name match. */
export function lookupDevice(index: DeviceIndex, ref: string): Device | undefined {
  const text = ref.trim();
  if (!text) return undefined;
  return index.byId.get(text.toLowerCase()) ?? index.byNameKey.get(deviceNameKey(text));
}

/** One end of a route as it should be displayed. */
export type Stop = { id: string | null; name: string; line: DeviceLine; registered: boolean };

/**
 * Show the registry's current name and colour when the reference still resolves. Otherwise fall back to the
 * snapshot name stored on the handoff, with a heuristic colour. `anyLabel` localises the reserved "any device" target.
 */
export function resolveStop(index: DeviceIndex, id: string | null | undefined, name: string, anyLabel?: string): Stop {
  const device = (id ? index.byId.get(id) : undefined) ?? lookupDevice(index, name);
  if (device) return { id: device.id, name: device.name, line: device.line, registered: true };
  if (isReservedDeviceName(name)) return { id: null, name: anyLabel ?? name, line: "neutral", registered: false };
  return { id: null, name, line: heuristicLine(name), registered: false };
}

/** Names on handoffs that resolve to no registered device, first spelling wins. The reserved "any device" is never listed. */
export function unregisteredNames(rows: readonly Handoff[], index: DeviceIndex): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const [id, name] of [[row.sourceDeviceId, row.sourceDevice], [row.targetDeviceId, row.targetDevice]] as const) {
      if (resolveStop(index, id, name).registered || isReservedDeviceName(name)) continue;
      const key = deviceNameKey(name);
      if (key && !seen.has(key)) seen.set(key, name.trim());
    }
  }
  return [...seen.values()];
}
