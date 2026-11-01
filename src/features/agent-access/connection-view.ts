import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { connectionAttention, connectionStatus, type ConnectionStatus } from "@/shared/formatting/connection-health";

export type ConnectionGroupBy = "member" | "device" | "client";
/** The agents that have a profile, in the order they are offered; anything else is grouped as "other". */
export type ProfileLabel = { id: string; label: string };
export const OTHER_CLIENT = "other";
export type StatusFilter = "all" | "attention" | Extract<ConnectionStatus, "pending" | "unused" | "active" | "idle">;
/** `issuer` is "all", "mine" or an issuerRef; `device` is "all", "none" or a device id. */
export type ConnectionFilters = { query: string; issuer: string; device: string; status: StatusFilter };
export const NO_FILTERS: ConnectionFilters = { query: "", issuer: "all", device: "all", status: "all" };

export type ConnectionGroup = {
  key: string; items: TokenInfo[];
  /** Member groups: the issuer's display name (null for legacy rows) and whether the viewer is that issuer. */
  issuerRef: string | null; issuerName: string | null; viewer: boolean;
  /** Device groups: the registered device, or null for connections without a known device. */
  device: Device | null;
  /** Client groups: a profile id, or OTHER_CLIENT for connections without a (known) profile. */
  clientId: string | null;
};

export const filtersActive = (filters: ConnectionFilters) =>
  filters.query.trim() !== "" || filters.issuer !== "all" || filters.device !== "all" || filters.status !== "all";

/** A connection's device only counts while it is still registered; anything else is "no device". */
const deviceOf = (token: TokenInfo, devices: readonly Device[]) => devices.find(device => device.id === token.deviceId) ?? null;

/** A connection's profile only counts while the profile still exists; anything else is "other". */
const clientOf = (token: TokenInfo, profiles: readonly ProfileLabel[]) => profiles.find(profile => profile.id === token.clientProfile) ?? null;

export function filterConnections(tokens: readonly TokenInfo[], filters: ConnectionFilters, devices: readonly Device[], now: number, profiles: readonly ProfileLabel[] = []): TokenInfo[] {
  const needle = filters.query.trim().toLowerCase();
  return tokens.filter(token => {
    const device = deviceOf(token, devices);
    if (filters.issuer === "mine" ? !token.issuedByViewer : filters.issuer !== "all" && token.issuerRef !== filters.issuer) return false;
    if (filters.device === "none" ? device : filters.device !== "all" && device?.id !== filters.device) return false;
    if (filters.status === "attention" ? !connectionAttention(token, now).length : filters.status !== "all" && connectionStatus(token, now) !== filters.status) return false;
    return !needle || [token.name, token.createdByName, device?.name, clientOf(token, profiles)?.label, token.lastClient?.name].some(value => value?.toLowerCase().includes(needle));
  });
}

/**
 * Member groups put the viewer first. Device groups start with `currentDeviceId` when given, then follow the registry
 * order and end with the unbound ones.
 */
export function groupConnections(tokens: readonly TokenInfo[], groupBy: ConnectionGroupBy, devices: readonly Device[], profiles: readonly ProfileLabel[] = [],
  currentDeviceId: string | null = null): ConnectionGroup[] {
  if (groupBy === "client") {
    return [
      ...profiles.map(profile => ({ key: profile.id, clientId: profile.id, items: tokens.filter(token => clientOf(token, profiles)?.id === profile.id) })),
      { key: OTHER_CLIENT, clientId: OTHER_CLIENT, items: tokens.filter(token => !clientOf(token, profiles)) },
    ].filter(group => group.items.length).map(group => ({ ...group, issuerRef: null, issuerName: null, viewer: false, device: null }));
  }
  if (groupBy === "device") {
    const ordered = [...devices.filter(device => device.id === currentDeviceId), ...devices.filter(device => device.id !== currentDeviceId)];
    return [
      ...ordered.map(device => ({ key: device.id, device, items: tokens.filter(token => deviceOf(token, devices)?.id === device.id) })),
      { key: "unbound", device: null, items: tokens.filter(token => !deviceOf(token, devices)) },
    ].filter(group => group.items.length).map(group => ({ ...group, issuerRef: null, issuerName: null, viewer: false, clientId: null }));
  }
  const byIssuer = new Map<string, TokenInfo[]>();
  for (const token of tokens) byIssuer.set(token.issuerRef, [...(byIssuer.get(token.issuerRef) ?? []), token]);
  const groups = [...byIssuer].map(([issuerRef, items]) => ({
    key: issuerRef, items, issuerRef, issuerName: items[0].createdByName, viewer: items[0].issuedByViewer, device: null, clientId: null,
  }));
  return [...groups.filter(group => group.viewer), ...groups.filter(group => !group.viewer)];
}

/**
 * Inside its device's group a default name such as "Laptop · Codex" repeats the heading, so only the rest is shown.
 * Names that do not start with the device name, or are nothing but it, stay whole.
 */
export function nameWithinDevice(name: string, device: Pick<Device, "name"> | null): string {
  const prefix = device ? `${device.name} · ` : null;
  return prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

export type Issuer = { ref: string; name: string | null; viewer: boolean };
export function issuersOf(tokens: readonly TokenInfo[]): Issuer[] {
  const seen = new Map<string, Issuer>();
  for (const token of tokens) if (!seen.has(token.issuerRef)) seen.set(token.issuerRef, { ref: token.issuerRef, name: token.createdByName, viewer: token.issuedByViewer });
  return [...seen.values()];
}

export type AttentionSummary = { unused: number; stale: number; expiring: number; total: number };
export function summarizeAttention(tokens: readonly TokenInfo[], now: number): AttentionSummary {
  const summary = { unused: 0, stale: 0, expiring: 0, total: 0 };
  for (const token of tokens) {
    const reasons = connectionAttention(token, now);
    if (!reasons.length) continue;
    summary.total++;
    for (const reason of reasons) summary[reason]++;
  }
  return summary;
}
