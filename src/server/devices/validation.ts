import { AgentRelayError } from "@/server/core/agent-relay-error";
import {
  DEVICE_ID_PATTERN, DEVICE_LINES, DEVICE_NAME_MAX, RESERVED_DEVICE_IDS, SELF_DEVICE_REF,
  type DeviceConnectionAction, type DeviceLine,
} from "@/shared/contracts/devices";
import { deviceNameKey, isReservedDeviceName } from "@/shared/formatting/device-identity";

type Input = Record<string, unknown>;

function hasControlCharacter(text: string) {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code < 160)) return true;
  }
  return false;
}

/** Display name (trimmed, inner whitespace collapsed) plus the key uniqueness is judged by. */
export function parseDeviceName(value: unknown) {
  if (typeof value !== "string") throw new AgentRelayError(`Device names must be 1–${DEVICE_NAME_MAX} characters with no control characters.`);
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > DEVICE_NAME_MAX || hasControlCharacter(value)) throw new AgentRelayError(`Device names must be 1–${DEVICE_NAME_MAX} characters with no control characters.`);
  if (isReservedDeviceName(name)) throw new AgentRelayError("“Any device” is reserved and can't be used as a device name.");
  if (deviceNameKey(name) === SELF_DEVICE_REF) throw new AgentRelayError("“self” is reserved and can't be used as a device name.");
  return { name, key: deviceNameKey(name) };
}

export function parseDeviceId(value: unknown) {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) throw new AgentRelayError("Device ids are 1–32 lowercase letters, digits or hyphens, and can't start or end with a hyphen.");
  if (RESERVED_DEVICE_IDS.includes(value)) throw new AgentRelayError("The ids any, all, none and self are reserved.");
  return value;
}

export function parseDeviceLine(value: unknown): DeviceLine {
  if (typeof value !== "string" || !(DEVICE_LINES as readonly string[]).includes(value)) throw new AgentRelayError("That line colour isn't available.");
  return value as DeviceLine;
}

export function parseVersion(input: Input) {
  if (!Number.isInteger(input.version) || Number(input.version) < 1) throw new AgentRelayError("The latest version is required.");
  return Number(input.version);
}

export function parseConnectionAction(value: unknown): DeviceConnectionAction {
  if (value === undefined || value === "unbind") return "unbind";
  if (value === "revoke") return "revoke";
  throw new AgentRelayError("connections must be unbind or revoke.");
}

/**
 * Any input must resolve to at most one device, so an id or name key may not repeat or shadow another device's.
 * A device whose own name equals its own id is fine; callers pass only the other devices.
 */
export function assertNoConflicts(others: readonly { id: string; nameKey: string }[], candidate: { id: string; nameKey: string }) {
  for (const other of others) {
    if (other.id === candidate.id) throw new AgentRelayError("That device id is already in use.", 409);
    if (other.nameKey === candidate.nameKey) throw new AgentRelayError("A device with that name already exists.", 409);
    if (other.id === candidate.nameKey) throw new AgentRelayError("That name matches another device's id. Choose a different name.", 409);
    if (other.nameKey === candidate.id) throw new AgentRelayError("That id matches another device's name. Choose a different id.", 409);
  }
}
