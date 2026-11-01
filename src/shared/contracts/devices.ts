/** Browser-safe device registry contracts and the rules both sides apply to ids, names and colours. */
export const DEVICE_LINES = ["blue", "amber", "green", "violet", "teal", "brown", "neutral"] as const;
export type DeviceLine = (typeof DEVICE_LINES)[number];

/** A readable slug: 1–32 characters, lowercase letters, digits and inner hyphens. */
export const DEVICE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const DEVICE_ID_MAX = 32;
export const DEVICE_NAME_MAX = 80;
export const MAX_DEVICES = 50;

/** `any` is a pseudo-target that routes to whichever device picks the handoff up; it is never a row. */
export const ANY_DEVICE_ID = "any";
/** `self` means the device the calling Agent connection is bound to. It is resolved by the MCP adapter and is never a row. */
export const SELF_DEVICE_REF = "self";
export const RESERVED_DEVICE_IDS: readonly string[] = [ANY_DEVICE_ID, "all", "none", SELF_DEVICE_REF];
/** Normalised name keys that always mean "any device", in both interface languages. */
export const RESERVED_DEVICE_NAME_KEYS: readonly string[] = [ANY_DEVICE_ID, "any device", "任意设备"];

export type Device = { id: string; name: string; line: DeviceLine; createdAt: number; updatedAt: number; version: number };
/** What still points at a device; shown before it is deleted. */
export type DeviceUsage = { openHandoffs: number; totalHandoffs: number; connections: number };
export type DeletedDevice = { id: string; detachedHandoffs: number; unboundConnections: number; revokedConnections: number };
/** How a deleted device's Agent Tokens are handled. */
export type DeviceConnectionAction = "unbind" | "revoke";
