import type { Actor } from "@/server/core/actor";
import { isSelfRef, selfUnavailable } from "@/server/core/self-device";

/** The device reference fields of each tool. */
const DEVICE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_handoff: ["sourceDevice", "targetDevice"], list_handoffs: ["targetDevice"], claim_handoff: ["device"],
};

/**
 * Resolve `self` to the device the calling connection is bound to, and let a bound connection leave `sourceDevice` out.
 * This is the only place `self` is interpreted; it names a device and grants nothing, so an explicit id is still accepted.
 */
export function bindSelf(tool: unknown, args: Record<string, unknown>, actor: Actor): Record<string, unknown> {
  const bound = { ...args };
  for (const field of DEVICE_FIELDS[String(tool)] ?? []) {
    if (!isSelfRef(bound[field])) continue;
    if (!actor.deviceId) throw selfUnavailable();
    bound[field] = actor.deviceId;
  }
  if (tool === "create_handoff" && bound.sourceDevice === undefined && actor.deviceId) bound.sourceDevice = actor.deviceId;
  return bound;
}
