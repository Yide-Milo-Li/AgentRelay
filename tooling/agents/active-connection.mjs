// Which saved connection each agent on this device actually uses. An agent has one MCP entry, one rule block and one
// skill folder, so the connection its MCP config was last written for owns all three; other saved connections of the
// same agent are history (a migration in progress, or one revoked since).
import { readFileSync } from "node:fs";
import os from "node:os";
import { loadProfiles, profilePath } from "./device-setup.mjs";

const read = file => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

/**
 * The active connection id for `profileId`, or null when it cannot be told. Manifests written before this was recorded
 * fall back to the only saved connection of that agent, or to the one whose id its MCP config names.
 */
export function activeConnectionId(manifest, profileId, { userHome = os.homedir() } = {}) {
  const recorded = manifest.active?.[profileId];
  if (recorded && manifest.connections[recorded]) return recorded;
  const saved = Object.values(manifest.connections).filter(record => record.profile === profileId);
  if (saved.length <= 1) return saved[0]?.id ?? null;
  const profile = loadProfiles().find(item => item.id === profileId);
  const named = saved.filter(record => read(record.configFile ?? (profile ? profilePath(profile, profile.config.file, userHome) : "")).includes(record.id));
  return named.length === 1 ? named[0].id : null;
}

/** Record that `profileId`'s MCP config now starts connection `id`. */
export const markActive = (manifest, profileId, id) => { manifest.active = { ...manifest.active, [profileId]: id }; };
