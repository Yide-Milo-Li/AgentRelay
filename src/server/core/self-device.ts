import { SELF_DEVICE_REF } from "@/shared/contracts/devices";
import { AgentRelayError } from "./agent-relay-error";

/** `self` stands for the device the calling Agent connection is bound to; the MCP adapter replaces it before a service sees it. */
export const isSelfRef = (value: unknown) => typeof value === "string" && value.trim().toLowerCase() === SELF_DEVICE_REF;

/** Raised when `self` is used without a bound connection behind it (a browser, the platform /mcp endpoint, or an unbound connection). */
export const selfUnavailable = () => new AgentRelayError("“self” only works for an Agent connection that is bound to a device. Use a device id instead.");
