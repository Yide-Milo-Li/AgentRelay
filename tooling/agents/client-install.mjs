import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../environment/project-root.mjs";
import { ClientError, clientHome, readManifest } from "./credential-store.mjs";
import { activeConnectionId } from "./active-connection.mjs";
import { refreshSkills } from "./skill-install.mjs";

// Explicit allowlist shared by the repo installer and Release packager. No runtime/user files are copied.
export const CLIENT_FILES = ["scripts/agents/agentrelay.mjs", "tooling/agents/client.mjs", "tooling/agents/client-config.mjs",
  "tooling/agents/client-install.mjs", "tooling/agents/client-bootstrap.mjs", "tooling/agents/gateway.mjs", "tooling/agents/credential-store.mjs",
  "tooling/agents/device-setup.mjs", "tooling/agents/mcp-bridge.mjs",
  "tooling/agents/upload-attachments.mjs", "tooling/agents/download-attachments.mjs", "tooling/environment/project-root.mjs",
  "src/shared/formatting/device-rule.mjs", "src/shared/agent-profiles/profiles.json", "src/shared/agent-profiles/site-url.mjs",
  "src/shared/images/inspect-image.mjs", "tooling/agents/git-context.mjs", "tooling/agents/skill-install.mjs",
  "tooling/agents/active-connection.mjs", "tooling/agents/skill/agentrelay-placeholder/SKILL.md", "tooling/agents/skill/agentrelay/SKILL.md", "tooling/agents/skill/agentrelay/references/handoff-content.md",
  "tooling/agents/skill/agentrelay/references/handoff-receipt.md", "LICENSE"];
export const CLIENT_VERSION = "0.8.1";
// The installed client's only dependency. Its manifest pins the version so npm installs exactly this one.
const KEYRING = { name: "@napi-rs/keyring", version: "2.1.2" };
const keyringAddon = () => process.platform === "win32" ? `keyring-win32-${process.arch}-msvc` : process.platform === "darwin" ? `keyring-darwin-${process.arch}` : `keyring-linux-${process.arch}-gnu`;
/** Whether `root` holds the keyring and its addon for this platform, where Node resolves them for that client's files. */
export const hasKeyring = root => ["keyring", keyringAddon()].every(name => existsSync(path.join(root, "node_modules/@napi-rs", name)));

/**
 * Install the pinned keyring into `target` with npm, for a checkout whose dependencies were never installed. Output goes
 * to stderr, because stdout carries the command's own result. The arguments are fixed, so no secret can reach them.
 */
export function installKeyringWithNpm(target, run = spawnSync) {
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"];
  const options = { cwd: target, stdio: ["ignore", 2, 2], windowsHide: true, timeout: 300_000 };
  // npm is a .cmd script on Windows, which only a shell can start; the line is fixed text.
  const result = process.platform === "win32" ? run(`npm ${args.join(" ")}`, { ...options, shell: true }) : run("npm", args, options);
  if (result.error || result.status !== 0) throw new ClientError("npm could not install the OS keyring addon. Check the network and npm, or run npm run install:ci in this folder first.");
}

/** The keyring comes from the checkout's own dependencies when they are installed, otherwise from npm. */
export function copyClient(source, target, { npm = installKeyringWithNpm } = {}) {
  for (const file of CLIENT_FILES) {
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    cpSync(path.join(source, file), path.join(target, file));
  }
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "agentrelay-client", version: CLIENT_VERSION, private: true, type: "module", engines: { node: ">=22.13.0" }, dependencies: { [KEYRING.name]: KEYRING.version } }, null, 2) + "\n");
  if (hasKeyring(source)) {
    // Copy only keyring and its current platform addon, including their licenses.
    for (const name of ["keyring", keyringAddon()]) {
      mkdirSync(path.join(target, "node_modules/@napi-rs"), { recursive: true });
      cpSync(path.join(source, "node_modules/@napi-rs", name), path.join(target, "node_modules/@napi-rs", name), { recursive: true });
    }
  } else npm(target);
  if (!hasKeyring(target)) throw new ClientError("The OS keyring addon for this platform is unavailable.");
}

/**
 * Make sure this checkout's client version is installed, without selecting it. A version is copied into a staging
 * folder and renamed into place only when complete, so a failed install leaves every installed version as it was.
 */
export function ensureClient({ source = projectRoot, home = clientHome(), npm } = {}) {
  const versionRoot = path.join(home, "client/versions", CLIENT_VERSION), staging = `${versionRoot}.${crypto.randomUUID()}.tmp`;
  mkdirSync(path.dirname(versionRoot), { recursive: true });
  if (existsSync(versionRoot)) {
    if (!hasKeyring(versionRoot)) throw new ClientError(`The installed client in ${versionRoot} is incomplete. Delete that folder and run the command again.`);
    return versionRoot;
  }
  try { copyClient(source, staging, { npm }); renameSync(staging, versionRoot); }
  finally { rmSync(staging, { recursive: true, force: true }); }
  return versionRoot;
}

export function installClient({ source = projectRoot, home = clientHome(), npm } = {}) {
  const fresh = !existsSync(path.join(home, "client/versions", CLIENT_VERSION));
  const versionRoot = ensureClient({ source, home, npm });
  const currentFile = path.join(home, "client/current.json");
  let previous = null, replaced = null;
  try {
    const current = JSON.parse(readFileSync(currentFile, "utf8"));
    previous = current.version === CLIENT_VERSION ? current.previous : current.version;
    if (current.version !== CLIENT_VERSION) replaced = current.version;
  } catch { /* First installation. */ }
  const launcher = path.join(home, "client/agentrelay.mjs");
  writeFileSync(launcher, `import { readFileSync } from 'node:fs';\nconst { version } = JSON.parse(readFileSync(new URL('./current.json', import.meta.url)));\nif (!/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(version)) throw new Error('Invalid installed client version');\nawait import(new URL('./versions/' + version + '/scripts/agents/agentrelay.mjs', import.meta.url));\n`);
  writeFileSync(`${currentFile}.tmp`, JSON.stringify({ version: CLIENT_VERSION, previous }));
  renameSync(`${currentFile}.tmp`, currentFile);
  // Installed skills follow the selected client, so their text always matches the commands it offers.
  return { launcher, root: versionRoot, version: CLIENT_VERSION, replaced, fresh, skills: refreshInstalledSkills({ home, version: CLIENT_VERSION }) };
}

/**
 * Re-render the skills of each agent's active connection with client `version`'s template. A refresh that fails is
 * reported, never thrown: the version switch it follows has already happened and stays valid.
 */
export function refreshInstalledSkills({ home = clientHome(), version }) {
  let manifest;
  try { manifest = readManifest(home); } catch { return { refreshed: [], failed: [path.join(home, "connections.json")] }; }
  const records = Object.values(manifest.connections).filter(record => activeConnectionId(manifest, record.profile) === record.id);
  return refreshSkills({ records, launcher: path.join(home, "client", "agentrelay.mjs"), version, root: path.join(home, "client/versions", version) });
}
/** The client version the stable launcher runs, or null before the first installation. */
export function installedClientVersion(home = clientHome()) {
  try { return JSON.parse(readFileSync(path.join(home, "client/current.json"), "utf8")).version ?? null; } catch { return null; }
}
export function rollbackClient(home = clientHome()) {
  const file = path.join(home, "client/current.json"), current = JSON.parse(readFileSync(file, "utf8"));
  if (!current.previous || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(current.previous) || !existsSync(path.join(home, "client/versions", current.previous))) throw new ClientError("No previous installed version is available.");
  writeFileSync(`${file}.tmp`, JSON.stringify({ version: current.previous, previous: current.version })); renameSync(`${file}.tmp`, file);
  // A version without a skill template refreshes nothing; the rollback command then retires those skills.
  refreshInstalledSkills({ home, version: current.previous });
  return current.previous;
}
