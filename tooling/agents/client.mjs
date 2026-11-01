// One client implementation for repository installs and Release archives. Stdout is a protocol channel for headers/bridge.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface, emitKeypressEvents } from "node:readline";
import os from "node:os";
import path from "node:path";
import { resolveSite, verifyConnection, persistUserEnv, loadProfiles, profilePath, expandHome, RULE_BEGIN, RULE_END } from "./device-setup.mjs";
import { ClientError, clientHome, readManifest, saveManifest, systemStore, credentialRefs, envName, readConnection, authHeaders } from "./credential-store.mjs";
import { planConfiguration, planInstructions, applyFileChanges } from "./client-config.mjs";
import { installClient, rollbackClient, installedClientVersion, CLIENT_VERSION } from "./client-install.mjs";
import { activeConnectionId, markActive } from "./active-connection.mjs";
import { clientCommand, hasSkillTemplate, inspectSkill, planSkillRemoval, pruneSkillDirs, removedSkillDirs, samePath, withoutConflicts } from "./skill-install.mjs";
import { createBridge } from "./mcp-bridge.mjs";
import { UploadError, uploadImages } from "./upload-attachments.mjs";
import { DownloadError, downloadImages } from "./download-attachments.mjs";
import { checkBase, gitContext } from "./git-context.mjs";
import { checkGateway, copyToClipboard, gatewayRef, savedGateway, siteOrigin, validGateway } from "./gateway.mjs";

export const HELP = `AgentRelay local client (Node.js >=22.13)
  install [--json]                Install/update the stable user launcher
  gateway --url <site> --stdin [--storage os|env]
                                  Save this Site's gateway token (piped on stdin) for every agent on this device
  gateway --url <site> --copy [--storage os|env]
                                  Copy the saved gateway token to the clipboard, for a password manager; never printed
  connect --profile <claude-code|codex|antigravity|deepseek-harness> --url <site/api/agent/mcp>
          [--device <id>] [--connection <id>] [--storage os|env] [--transport auto|direct|bridge]
          [--stdin] [--from-env] [--renew-gateway] [--lang en|zh] [--config-file <path>] [--rule-file <path>]
          [--skill-dir <path>] [--no-skill] [--json]
  skill --connection <id> [--remove] [--skill-dir <path>] [--rule-file <path>] [--lang en|zh] [--json]
                                  Install, repair or remove the agentrelay skill with the saved credentials
  verify --connection <id> [--json]
                                  Check credentials, resolved identity, all five tools and the skill
  headers --connection <id>        JSON headers for the agent only; do not run to inspect credentials
  bridge --connection <id>         Stdio MCP fallback
  upload --connection <id> | --agent <profile> [--retry-key <key>] <image> ...
  download --connection <id> | --agent <profile> [--out <folder>] <handoffId>
                                  --agent uses that agent's active connection on this device
  context [--since <commit>]       JSON code state of the current folder's repository (read-only, no network)
  check-base --commit <hash> [--branch <name>]
                                  Fetch, then compare the checkout with a handoff's code state (never switches)
  rollback                        Select the previous installed client version
A device-bound connection also gets the agentrelay skill and a short rule pointing to it; --no-skill keeps the full rule.
Connect reads hidden input, or --stdin accepts one JSON object with agentToken and gatewayToken.
--from-env explicitly imports the legacy AGENTRELAY_AGENT_TOKEN / AGENTRELAY_SITES_GATEWAY_TOKEN.
Environment storage is plaintext and inherited by child processes; it is never selected automatically.`;

export function parseArgs(args) {
  const command = args[0] ?? "help", options = {}, positional = [];
  const values = new Set(["profile", "agent", "url", "device", "connection", "storage", "transport", "lang", "retry-key", "out", "config-file", "rule-file", "skill-dir", "since", "commit", "branch"]);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (["--stdin", "--from-env", "--renew-gateway", "--no-skill", "--remove", "--json", "--copy"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg.startsWith("--") && values.has(arg.slice(2)) && args[i + 1] && !args[i + 1].startsWith("--")) options[arg.slice(2)] = args[++i];
    else if (arg.startsWith("--")) throw new ClientError("Unknown or incomplete option. Run agentrelay help.");
    else positional.push(arg);
  }
  return { command, options, positional };
}

function versionAtLeast(text, minimum) {
  const found = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found) return false;
  const actual = found.slice(1).map(Number);
  for (let i = 0; i < 3; i++) { if (actual[i] !== minimum[i]) return actual[i] > minimum[i]; }
  return true;
}
/** These are verified compatibility baselines, not claims about the first version that introduced helpers. */
export function chooseTransport(profile, requested = "auto", run = spawnSync) {
  if (!["auto", "direct", "bridge"].includes(requested)) throw new ClientError("Choose auto, direct or bridge transport.");
  // Agents that only start the stdio bridge (Antigravity, DeepSeek Harness) have no header helper to probe for.
  const bridgeOnly = loadProfiles().find(item => item.id === profile && item.bridge);
  if (bridgeOnly) { if (requested === "direct") throw new ClientError(`${bridgeOnly.label} requires bridge transport.`); return "bridge"; }
  if (requested !== "auto") return requested;
  const binary = profile === "codex" ? "codex" : "claude";
  const result = run(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return !result.error && result.status === 0 && versionAtLeast(result.stdout, profile === "codex" ? [0, 164, 0] : [2, 1, 310]) ? "direct" : "bridge";
}

async function hiddenInput(label) {
  if (!process.stdin.isTTY) throw new ClientError("Use --stdin with piped credential JSON, or run connect in an interactive terminal.");
  process.stderr.write(`${label}: `);
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => { process.stdin.off("keypress", keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n"); };
    function keypress(text, key = {}) {
      if (key.ctrl && key.name === "c") { finish(); reject(new Error("Setup cancelled. No connection was configured.")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(value.trim()); }
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    process.stdin.on("keypress", keypress);
  });
}

export async function verifyCredentials(record, secrets, fetchImpl = fetch) {
  const verdict = await verifyConnection({ endpoint: record.endpoint, ...secrets, fetchImpl });
  if (!verdict.ok) throw new ClientError("The Site did not accept both credentials and expose the five expected tools. Check the Site URL, gateway credential and Agent Token.");
  let response, diagnostic;
  try {
    response = await fetchImpl(new URL("/api/agent/connection", record.endpoint), { headers: authHeaders(secrets), signal: AbortSignal.timeout(15_000), redirect: "error" });
    diagnostic = await response.json();
  } catch { throw new ClientError("Connection diagnostics are unavailable. Deploy the identity upgrade to this Site first."); }
  if (!response.ok || !diagnostic.connection?.id) throw new ClientError("Connection diagnostics refused authentication. Check or renew the credentials.");
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(diagnostic.connection.id) ||
    (diagnostic.connection.deviceId !== null && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(diagnostic.connection.deviceId)))
    throw new ClientError("Connection diagnostics returned an invalid connection or device id.");
  if (record.id && diagnostic.connection.id !== record.id) throw new ClientError("This Agent Token belongs to another connection. Copy the token for the selected connection.");
  if (record.deviceId && diagnostic.connection.deviceId !== record.deviceId) throw new ClientError("The selected device differs from the connection's device label. Correct the label in the Site first.");
  return diagnostic;
}

/** Verify and preflight before any writes; restore this operation's configuration and vault changes on failure. */
export async function connect(options, secrets, { home = clientHome(), userHome = os.homedir(), store, fetchImpl, launcher, node, configFile, ruleFile, skillDir, persist = persistUserEnv } = {}) {
  const profiles = loadProfiles().map(item => item.id);
  if (!profiles.includes(options.profile)) throw new ClientError(`Choose --profile ${profiles.join(", ")}.`);
  if (options.lang && !["en", "zh"].includes(options.lang)) throw new ClientError("Choose --lang en or zh.");
  if (options.device && !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(options.device)) throw new ClientError("Use the registered device id from the Site.");
  const storage = options.storage ?? "os";
  if (!["os", "env"].includes(storage)) throw new ClientError("Choose --storage os or --storage env.");
  if (!/^agentrelay_[a-f0-9]{64}$/i.test(secrets.agentToken ?? "") || typeof secrets.gatewayToken !== "string" || !secrets.gatewayToken.trim() || /[\r\n]/.test(secrets.gatewayToken)) throw new ClientError("Enter a valid personal Agent Token and this Site's gateway token.");
  const { endpoint } = resolveSite({ url: options.url });
  const diagnostic = await verifyCredentials({ endpoint, id: options.connection, deviceId: options.device }, secrets, fetchImpl);
  const id = diagnostic.connection.id, manifest = readManifest(home), previous = structuredClone(manifest);
  if (Object.values(manifest.connections).some(item => new URL(item.endpoint).origin !== new URL(endpoint).origin)) throw new ClientError("This client currently supports one Site. Use a separate OS user for a second Site.");
  const refs = credentialRefs(new URL(endpoint).origin, id), profile = loadProfiles().find(item => item.id === options.profile);
  // `~` in a path option means the home folder in every shell, PowerShell and cmd included.
  const [configOption, ruleOption, skillOption] = [configFile, ruleFile, skillDir].map(file => file && expandHome(file, userHome));
  const configTarget = path.resolve(configOption ?? profilePath(profile, profile.config.file, userHome));
  const ruleTarget = path.resolve(ruleOption ?? profilePath(profile, profile.ruleFile, userHome)), lang = options.lang ?? "en";
  const placement = skillPlacement({ profile, deviceId: diagnostic.connection.deviceId, optOut: options["no-skill"], skillDir: skillOption, userHome });
  // The config, rule file, language and skill choice are kept so the `skill` command can redo the instructions later.
  const record = { id, endpoint, profile: options.profile, deviceId: diagnostic.connection.deviceId, storage, configFile: configTarget, ruleFile: ruleTarget, lang,
    skillDir: placement.target ?? placement.placeholder, noSkill: Boolean(options["no-skill"]),
    credentialRef: refs.agent, gatewayRef: refs.gateway, transport: chooseTransport(options.profile, options.transport), configVersion: 1 };
  const installed = launcher ? { launcher } : installClient({ home });
  const changes = withoutConflicts([
    ...planConfiguration({ record, launcher: installed.launcher, home: userHome, node, lang, configFile: configTarget, ruleFile: ruleTarget,
      skillDir: placement.target, placeholderDir: placement.placeholder, version: CLIENT_VERSION, root: installed.root }),
    ...staleSkillChanges({ manifest, placement, profile, userHome }),
  ]);
  const removedSkills = removedSkillDirs(changes);
  const vault = storage === "os" ? store ?? await systemStore() : null;
  const before = new Map(); let undoFiles;
  try {
    if (vault) {
      for (const [ref, value] of [[refs.agent, secrets.agentToken], [refs.gateway, secrets.gatewayToken]]) {
        before.set(ref, vault.get(ref)); vault.set(ref, value);
      }
    }
    undoFiles = applyFileChanges(changes);
    manifest.connections[id] = record; markActive(manifest, profile.id, id); saveManifest(manifest, home);
    if (storage === "env") {
      // Each connection has its own block, so configuring another agent never replaces the first agent's variables.
      const values = { [envName(refs.agent)]: secrets.agentToken, [envName(refs.gateway)]: secrets.gatewayToken };
      persist(Object.keys(values), { env: { ...process.env, ...values }, home: userHome, blockId: `connection-${id}`, label: options.profile });
    }
  } catch {
    const failures = [];
    const recover = (label, action) => { try { action(); } catch { failures.push(label); } };
    if (undoFiles) recover("agent configuration", undoFiles);
    recover("connection manifest", () => saveManifest(previous, home));
    if (vault) for (const [ref, value] of before) recover("OS credential store", () => { if (value == null) vault.remove(ref); else vault.set(ref, value); });
    if (failures.length) throw new ClientError(`Setup failed. Automatic recovery could not restore ${[...new Set(failures)].join(" and ")}. Review those local settings before reconnecting; no server token was revoked.`);
    throw new ClientError("Setup failed. The previous config and saved connection were restored. Check credential-store access and file permissions.");
  }
  pruneSkillDirs(removedSkills);
  return { ...diagnostic, profile, transport: record.transport, storage, files: changes.filter(change => !change.remove).map(change => change.file),
    configFile: configTarget, ruleFile: ruleTarget, skillDir: placement.target, placeholderDir: placement.placeholder, skillReason: placement.reason,
    removedSkills, launcher: installed.launcher, client: { version: CLIENT_VERSION, replaced: installed.replaced ?? null } };
}

/**
 * Where an agent's skill goes. The skill sends and claims as `self`, which only a connection bound to a device can
 * resolve; without it, `reason` says why, and an agent that also reads another agent's skill folder gets a placeholder
 * in its own folder that shadows that copy. `own` is the agent's skill folder either way.
 */
function skillPlacement({ profile, deviceId, optOut, skillDir, userHome }) {
  if (!profile.skillDir) return { target: null, placeholder: null, own: null, reason: "unsupported" };
  const own = path.resolve(skillDir ?? profilePath(profile, profile.skillDir, userHome));
  const reason = optOut ? "opted-out" : deviceId ? null : "unbound";
  return { target: reason ? null : own, placeholder: reason && profile.skillPlaceholder ? own : null, own, reason };
}

/**
 * The removals that leave one AgentRelay skill per agent: a managed skill in any folder this agent's skill has lived in
 * (its default folder, the one chosen now, and those its saved connections recorded, such as an earlier --skill-dir)
 * that is not being written now, whoever rendered it, since the agent follows its active connection.
 */
function staleSkillChanges({ manifest, placement, profile, userHome }) {
  const kept = [placement.target, placement.placeholder].filter(Boolean), outside = dir => dir && !kept.some(item => samePath(item, dir));
  const recorded = Object.values(manifest.connections).filter(record => record.profile === profile.id).map(record => record.skillDir);
  const agentDirs = profile.skillDir ? [profilePath(profile, profile.skillDir, userHome), placement.own, ...recorded] : recorded;
  return planSkillRemoval({ skillDirs: agentDirs.filter(outside) });
}

/** The rule file a saved connection uses: the one recorded, or for an older record the default if connect wrote there. */
function savedRuleFile({ record, profile, option, userHome }) {
  if (option) return path.resolve(expandHome(option, userHome));
  if (record.ruleFile) return record.ruleFile;
  const fallback = path.resolve(profilePath(profile, profile.ruleFile, userHome));
  if (!readText(fallback).includes(RULE_BEGIN)) throw new ClientError(`This connection was saved before its instruction file was recorded, and ${fallback} holds no AgentRelay rule. Pass --rule-file with the file it was set up with.`);
  return fallback;
}
/** The language of the AgentRelay rule already in `file`, for older records that did not save it. */
function ruleLanguage(file) {
  const text = readText(file), begin = text.indexOf(RULE_BEGIN), end = text.indexOf(RULE_END);
  return begin >= 0 && end > begin && text.slice(begin, end).includes("跨设备提示词交接") ? "zh" : "en";
}
function readText(file) { try { return readFileSync(file, "utf8"); } catch { return ""; } }

/**
 * Install, repair or remove the skill of an agent's active connection with its saved credentials, so the token is not
 * asked for again. This checkout's client is installed first, as connect does, and the skill is rendered from that
 * installed version, so the skill never calls commands its client lacks. The Site decides whether the connection is
 * bound; the rule block and skill are switched to match and the MCP config is left as it is. `remove` opts out.
 */
export async function setupSkill(options, { home = clientHome(), userHome = os.homedir(), store, env, fetchImpl, launcher } = {}) {
  if (options.lang && !["en", "zh"].includes(options.lang)) throw new ClientError("Choose --lang en or zh.");
  const { record, agentToken, gatewayToken } = await readConnection(options.connection, { home, store, env });
  const profile = loadProfiles().find(item => item.id === record.profile);
  if (!profile) throw new ClientError("This connection's agent is unknown to this client version. Update the client first.");
  const manifest = readManifest(home), active = activeConnectionId(manifest, record.profile, { userHome });
  if (active !== record.id) throw new ClientError(active
    ? `${profile.label} on this device uses connection ${active}, not ${record.id}. Run skill for ${active}, or run connect for ${record.id} to switch the agent to it.`
    : `Cannot tell which connection ${profile.label} on this device uses. Run connect for the connection it should use.`);
  const diagnostic = await verifyCredentials({ endpoint: record.endpoint, id: record.id }, { agentToken, gatewayToken }, fetchImpl);
  const installed = launcher ? { launcher } : installClient({ home });
  const deviceId = diagnostic.connection.deviceId, optOut = Boolean(options.remove);
  const skillOption = options["skill-dir"] && expandHome(options["skill-dir"], userHome);
  const placement = skillPlacement({ profile, deviceId, optOut, skillDir: skillOption ?? record.skillDir ?? undefined, userHome });
  const ruleTarget = savedRuleFile({ record, profile, option: options["rule-file"], userHome }), lang = options.lang ?? record.lang ?? ruleLanguage(ruleTarget);
  const next = { ...record, deviceId, ruleFile: ruleTarget, lang, skillDir: placement.target ?? placement.placeholder, noSkill: optOut };
  const changes = withoutConflicts([
    ...planInstructions({ record: next, launcher: installed.launcher, lang, ruleTarget, skillDir: placement.target, placeholderDir: placement.placeholder, version: CLIENT_VERSION, root: installed.root }),
    ...staleSkillChanges({ manifest, placement, profile, userHome }),
  ]);
  const removedSkills = removedSkillDirs(changes), undo = applyFileChanges(changes);
  try { manifest.connections[record.id] = next; markActive(manifest, profile.id, record.id); saveManifest(manifest, home); }
  catch {
    try { undo(); } catch { throw new ClientError("Saving the connection failed and the instruction files could not be restored. Review them before retrying."); }
    throw new ClientError("Saving the connection failed. The instruction and skill files were restored.");
  }
  pruneSkillDirs(removedSkills);
  return { connection: diagnostic.connection, profile, ruleFile: ruleTarget, skillDir: placement.target, placeholderDir: placement.placeholder, skillReason: placement.reason,
    removedSkills, launcher: installed.launcher, client: { version: CLIENT_VERSION, replaced: installed.replaced ?? null }, files: changes.filter(change => !change.remove).map(change => change.file) };
}

/**
 * After a rollback to a client without the skill: remove each active connection's skill and write the full rule, whose
 * commands that client has. A connection that fails is reported and left as it was.
 */
export function retireSkills({ home = clientHome(), userHome = os.homedir() } = {}) {
  const manifest = readManifest(home), launcher = path.join(home, "client", "agentrelay.mjs"), retired = [], failed = [];
  for (const record of Object.values(manifest.connections)) {
    const profile = loadProfiles().find(item => item.id === record.profile);
    if (!profile || !record.skillDir || activeConnectionId(manifest, record.profile, { userHome }) !== record.id || inspectSkill(record.skillDir)?.owner !== record.id) continue;
    try {
      const ruleTarget = savedRuleFile({ record, profile, userHome });
      applyFileChanges(withoutConflicts([...planInstructions({ record, launcher, lang: record.lang ?? ruleLanguage(ruleTarget), ruleTarget }),
        ...planSkillRemoval({ skillDirs: [record.skillDir], connection: record.id })]));
      pruneSkillDirs([record.skillDir]); retired.push(record.skillDir); record.skillDir = null;
    } catch { failed.push(record.skillDir); }
  }
  saveManifest(manifest, home);
  return { retired, failed };
}

/** Whether an active connection's skill matches what the Site says now; `fix` is the command that would correct it. */
export function skillStatus({ manifest, record, deviceId, launcher, installedVersion, userHome = os.homedir() }) {
  const profile = loadProfiles().find(item => item.id === record.profile);
  if (!profile?.skillDir) return { state: "unsupported" };
  const active = activeConnectionId(manifest, record.profile, { userHome });
  if (active !== record.id) return { state: "inactive", activeConnection: active };
  const dir = path.resolve(record.skillDir ?? profilePath(profile, profile.skillDir, userHome)), found = inspectSkill(dir);
  const full = found?.owner === record.id && !found.placeholder;
  const state = deviceId ? !full ? record.noSkill ? "opted-out" : "missing" : installedVersion && found.version !== installedVersion ? "outdated" : "installed"
    : full ? "stale" : "not-bound";
  const fix = ["missing", "stale", "outdated"].includes(state) ? `${clientCommand(launcher)} skill --connection ${record.id}` : undefined;
  return { state, ...full || state === "missing" ? { dir } : {}, ...full ? { version: found.version } : {}, ...fix ? { fix } : {} };
}

/**
 * After an update re-rendered skills: rewrite the rule block next to each of them, so the rule says what that skill
 * version reads from it (the device reference and the agent profile). Only active connections whose skill was just
 * re-rendered are touched; a rule that cannot be found or written is reported and left as it was.
 */
export function refreshRules({ skillDirs, version, root, launcher, home = clientHome(), userHome = os.homedir() }) {
  const updated = [], failed = [], manifest = readManifest(home);
  for (const record of Object.values(manifest.connections)) {
    if (!record.skillDir || !skillDirs.some(dir => samePath(dir, record.skillDir)) || activeConnectionId(manifest, record.profile, { userHome }) !== record.id) continue;
    const profile = loadProfiles().find(item => item.id === record.profile);
    let ruleTarget;
    try {
      ruleTarget = savedRuleFile({ record, profile, userHome });
      const lang = record.lang ?? ruleLanguage(ruleTarget);
      applyFileChanges(planInstructions({ record, launcher, lang, ruleTarget, skillDir: record.skillDir, version, root }).filter(change => samePath(change.file, ruleTarget)));
      updated.push(ruleTarget);
    } catch { failed.push(ruleTarget ?? record.skillDir); }
  }
  return { updated, failed };
}

/** `gateway --stdin`: check the piped token against the Site, then keep it for every agent on this device. */
export async function saveGateway({ url, storage = "os" }, input, { store, fetchImpl, persist = persistUserEnv, env = process.env, userHome = os.homedir() } = {}) {
  if (!["os", "env"].includes(storage)) throw new ClientError("Choose --storage os or --storage env.");
  const origin = siteOrigin(url), token = validGateway(input);
  await checkGateway(origin, token, fetchImpl);
  const { ref, variable } = gatewayRef(origin);
  if (storage === "env") {
    const saved = persist([variable], { env: { ...env, [variable]: token }, home: userHome, blockId: `gateway-${ref}`, label: "your agents" });
    return { origin, storage, where: saved.where, restart: saved.restart };
  }
  const vault = store ?? await systemStore();
  try { vault.set(ref, token); } catch { throw new ClientError("Cannot write to the OS credential store. Unlock it, or explicitly choose --storage env."); }
  return { origin, storage, where: "the OS credential store" };
}

/**
 * `gateway --copy`: put the saved gateway token of a Site on the clipboard, so the person can move it to a password
 * manager and paste it on another device. Only the gateway token: no Agent Token or connection is involved.
 */
export async function copyGateway({ url, storage = "os" }, { store, env = process.env, platform, run } = {}) {
  if (!["os", "env"].includes(storage)) throw new ClientError("Choose --storage os or --storage env.");
  const origin = siteOrigin(url);
  let token;
  try { token = savedGateway(origin, { storage, vault: storage === "env" ? null : store ?? await systemStore(), env }); }
  catch (e) { throw e instanceof ClientError ? e : new ClientError("Cannot read the OS credential store. Unlock it, or pass --storage env if the token was saved there."); }
  if (!token) throw new ClientError(`No gateway token is saved for ${origin} on this device. Save it with gateway --stdin, or run connect.`);
  copyToClipboard(token, { platform, run });
  return { origin };
}

/** What a person reads after `install`: whether anything changed, where the launcher is and what was refreshed. */
export function installSummary(result) {
  const first = result.replaced ? `Installed AgentRelay client ${result.version} (updated from ${result.replaced}).`
    : result.fresh ? `Installed AgentRelay client ${result.version}.` : `AgentRelay client ${result.version} is already installed and selected.`;
  const lines = [first, `  Launcher:  ${result.launcher}`];
  if (result.skills?.refreshed.length) lines.push(`  Skills:    re-rendered ${result.skills.refreshed.length} for this version`);
  for (const dir of result.skills?.failed ?? []) lines.push(`  Not updated: ${dir}. Run connect again for its agent.`);
  if (result.rules?.updated.length) lines.push(`  Rules:     updated ${result.rules.updated.length} to match`);
  for (const file of result.rules?.failed ?? []) lines.push(`  Rule not updated: ${file}. Run the skill command for its agent.`);
  lines.push("Restart or reconnect your agents to use this version.");
  return lines.join("\n");
}

const SKILL_STATES = {
  installed: skill => `installed (client ${skill.version})`,
  missing: () => "missing",
  stale: () => "installed, but the connection is no longer bound to a device",
  outdated: skill => `rendered by client ${skill.version}; update it`,
  "opted-out": () => "not installed (opted out)",
  "not-bound": () => "not installed: the connection is not bound to a device",
  inactive: skill => `not used here: ${skill.activeConnection ?? "another connection"} is this agent's active connection`,
  unsupported: () => "not available for this agent",
};
/**
 * What a person reads after `verify`. It describes the saved credentials, never a running agent. It names the
 * connection by id only: a name can hold characters that a Windows console would garble.
 */
export function verifySummary({ connection, workspace, skill }) {
  const lines = [`Connection ${connection.id} works: the Site accepted its credentials and offers all five tools.`,
    `  Device:     ${connection.deviceId ?? "not bound to a device"}`,
    `  Workspace:  ${workspace?.shared ? "shared" : "personal"}`,
    `  Expires:    ${connection.expiresAt ? new Date(connection.expiresAt).toISOString().slice(0, 10) : "never"}`,
    `  Skill:      ${(SKILL_STATES[skill.state] ?? (() => skill.state))(skill)}`];
  if (skill.fix) lines.push(`  Fix:        ${skill.fix}`);
  lines.push("This checks the saved credentials, not a running agent session.");
  return lines.join("\n");
}

/** The connection `profileId` uses on this device: the one its MCP config was last set up for. */
export function agentConnection(profileId, { home = clientHome(), userHome = os.homedir() } = {}) {
  if (!loadProfiles().some(item => item.id === profileId)) throw new ClientError(`Unknown agent profile ${profileId}. Use the profile your AgentRelay rule names.`);
  const id = activeConnectionId(readManifest(home), profileId, { userHome });
  if (!id) throw new ClientError(`No connection is set up for ${profileId} on this device. Run connect for it first.`);
  return id;
}

async function readStdin(limit) {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > limit) throw new ClientError("The piped input is too large."); }
  return input;
}

/** What a person reads after `connect` or `skill`: files, how to use the skill, and what to do next. Never a credential. */
export function setupSummary(result, { title = "Configured" } = {}) {
  const { profile, connection } = result, fix = `${clientCommand(result.launcher)} skill --connection ${connection.id}`;
  const lines = [`${title} ${profile.label} for connection ${connection.id} (${connection.deviceId ? `device ${connection.deviceId}` : "not bound to a device"}).`];
  if (result.client?.replaced) lines.push(`  Client:        updated from ${result.client.replaced} to ${result.client.version}`);
  if (result.configFile) lines.push(`  MCP config:    ${result.configFile}`);
  lines.push(`  Instructions:  ${result.ruleFile} (${result.skillDir ? "a short rule that points to the agentrelay skill" : "the full handoff rule"})`);
  if (result.skillDir) lines.push(`  Skill:         ${result.skillDir}`,
    `                 Ask in plain words, for example "hand this off to my desktop", or run ${profile.skillCommand}.`);
  else if (result.skillReason === "unbound") lines.push("  Skill:         not installed, because this connection is not bound to a device.",
    "                 Bind it to this device on the Site's Agents page, then run:", `                 ${fix}`);
  else if (result.skillReason === "opted-out") lines.push(`  Skill:         not installed (--no-skill or --remove). To add it later: ${fix}`);
  if (result.placeholderDir) lines.push(`  Placeholder:   ${result.placeholderDir}`, `                 keeps ${profile.label} from loading another agent's agentrelay skill.`);
  for (const dir of result.removedSkills) lines.push(`  Removed:       the earlier skill in ${dir}`);
  if (result.transport) lines.push(`  Transport:     ${result.transport}; credentials in ${result.storage === "env" ? "environment variables" : "the OS credential store"}`);
  lines.push(`Next: restart or reconnect ${profile.label}, then check that it lists the five AgentRelay tools${result.skillDir ? " and the agentrelay skill" : ""}.`,
    "This check authenticated the local client, not a running agent session.");
  return lines.join("\n");
}

export async function main(args) {
  try {
    const { command, options, positional } = parseArgs(args);
    if (["help", "--help", "-h"].includes(command)) return console.log(HELP);
    if (command === "install") {
      const result = installClient(), rules = refreshRules({ skillDirs: result.skills.refreshed, version: result.version, root: result.root, launcher: result.launcher });
      return console.log(options.json ? JSON.stringify({ ...result, rules }) : installSummary({ ...result, rules }));
    }
    if (command === "rollback") {
      const version = rollbackClient();
      // An older client has no skill template and no commands for it: hand its agents back to the full rule.
      const retired = hasSkillTemplate(path.join(clientHome(), "client", "versions", version)) ? { retired: [], failed: [] } : retireSkills();
      for (const dir of retired.retired) console.log(`Removed the agentrelay skill in ${dir} and wrote the full rule, because client ${version} has no skill.`);
      for (const dir of retired.failed) console.log(`Could not remove the agentrelay skill in ${dir}. Run connect again for its agent.`);
      return console.log(`Selected client ${version}. Restart/reconnect the agent.`);
    }
    if (command === "connect") {
      if (!options.url) throw new ClientError("Copy the connect command from your Site; --url is required.");
      let secrets;
      if (options.stdin) {
        const input = await readStdin(32_768);
        try { secrets = JSON.parse(input); } catch { throw new ClientError("--stdin expects JSON with agentToken and gatewayToken."); }
      } else if (options["from-env"]) {
        secrets = { agentToken: process.env.AGENTRELAY_AGENT_TOKEN, gatewayToken: process.env.AGENTRELAY_SITES_GATEWAY_TOKEN ?? process.env.AGENTRELAY_SITES_GATEWAY_HEADER?.replace(/^Bearer /i, "") };
      } else {
        const origin = new URL(options.url).origin, storage = options.storage ?? "os";
        const label = loadProfiles().find(item => item.id === options.profile)?.label ?? options.profile;
        // Prompts and notes go to stderr; stdout carries only the result.
        process.stderr.write(`Setting up ${label}${options.device ? ` on device ${options.device}` : ""} for ${origin}${options.connection ? ` (connection ${options.connection})` : ""}.\n`);
        let gatewayToken = null;
        if (!options["renew-gateway"]) {
          try { gatewayToken = savedGateway(origin, { storage, vault: storage === "os" ? await systemStore() : null }); }
          catch { throw new ClientError("Cannot read the OS credential store. Unlock it, or explicitly choose --storage env."); }
        }
        if (gatewayToken) process.stderr.write("Using the gateway token already saved for this Site on this device.\n");
        else process.stderr.write("No gateway token is saved for this Site on this device yet. It is asked for after the Agent Token: get it from Codex\n"
          + `(gateway --url ${origin} --stdin, see the Site's setup step) or from your password manager. Press Ctrl+C to stop and come back.\n`);
        secrets = { agentToken: await hiddenInput("Agent Token (shown once on the Site)"),
          gatewayToken: gatewayToken ?? await hiddenInput("Sites gateway token (from Codex, or from your password manager)") };
      }
      const result = await connect(options, secrets, { configFile: options["config-file"], ruleFile: options["rule-file"], skillDir: options["skill-dir"] });
      if (options.json) return console.log(JSON.stringify({ connection: result.connection, workspace: result.workspace, transport: result.transport, storage: result.storage,
        files: result.files, skill: result.skillDir, removedSkills: result.removedSkills, launcher: result.launcher }, null, 2));
      return console.log(setupSummary(result));
    }
    if (command === "gateway") {
      if (!options.url) throw new ClientError("--url is required: the Site's URL.");
      if (Boolean(options.stdin) === Boolean(options.copy)) throw new ClientError("Choose --stdin to save the gateway token, or --copy to copy the saved one.");
      if (options.copy) {
        const { origin } = await copyGateway(options);
        return console.log(`Copied the gateway token for ${origin} to the clipboard. Save it in your password manager, then copy something else.\nClipboard history or sync may still keep a copy.`);
      }
      const saved = await saveGateway(options, await readStdin(8192));
      console.log(`The Site accepted the gateway token. Saved it for ${saved.origin} in ${saved.where}; connect reuses it for every agent on this device.`);
      return saved.restart ? console.log(saved.restart) : undefined;
    }
    if (command === "context") return console.log(JSON.stringify(gitContext({ since: options.since })));
    if (command === "check-base") {
      if (!options.commit) throw new ClientError("--commit is required. Pass the handoff's full baseCommit.");
      return console.log(JSON.stringify(checkBase({ commit: options.commit, branch: options.branch })));
    }
    // The skill is the same for every agent, so it names the agent and this device's manifest picks its connection.
    if (options.agent && !options.connection && ["upload", "download"].includes(command)) options.connection = agentConnection(options.agent);
    if (!options.connection) throw new ClientError("--connection is required. Copy its id from the Site's connect command.");
    if (command === "skill") {
      const result = await setupSkill(options);
      if (options.json) return console.log(JSON.stringify({ connection: result.connection, files: result.files, skill: result.skillDir, removedSkills: result.removedSkills }, null, 2));
      return console.log(setupSummary(result, { title: "Updated the instructions of" }));
    }
    const loaded = await readConnection(options.connection), { record, agentToken, gatewayToken } = loaded;
    if (command === "headers") return process.stdout.write(JSON.stringify(authHeaders(loaded)) + "\n");
    if (command === "verify") {
      // Checked against the Site, not the saved device: a connection moved or unbound there since setup is reported here.
      const diagnostic = await verifyCredentials({ endpoint: record.endpoint, id: record.id }, { agentToken, gatewayToken });
      const skill = skillStatus({ manifest: readManifest(), record, deviceId: diagnostic.connection.deviceId, launcher: path.join(clientHome(), "client", "agentrelay.mjs"),
        installedVersion: installedClientVersion() });
      return console.log(options.json ? JSON.stringify({ ...diagnostic, skill }, null, 2) : verifySummary({ ...diagnostic, skill }));
    }
    if (command === "bridge") {
      // Some agents need the bridge to adjust the Site's answers; their profile says which adjustments.
      const compatibility = loadProfiles().find(item => item.id === record.profile)?.bridgeCompatibility ?? [];
      const bridge = createBridge({ endpoint: record.endpoint, agentToken, gatewayToken, coreSchemas: compatibility.includes("core-schemas"),
        initializeOnly: compatibility.includes("initialize-only"), write: message => process.stdout.write(JSON.stringify(message) + "\n") });
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      lines.on("line", line => { void bridge.handle(line); }); lines.on("close", () => { void bridge.idle(); }); return;
    }
    const siteUrl = new URL(record.endpoint).origin, authorization = `Bearer ${gatewayToken}`;
    if (command === "upload") {
      const retryKey = options["retry-key"] ?? `cli-${crypto.randomUUID()}`;
      if (!/^[\x21-\x7e]{1,100}$/.test(retryKey)) throw new ClientError("Invalid upload retry key.");
      const attachments = await uploadImages({ files: positional, siteUrl, agentToken, authorization, retryKey });
      return console.log(JSON.stringify({ attachmentIds: attachments.map(item => item.id), attachments, retryKey }));
    }
    if (command === "download" && positional.length === 1) return console.log(JSON.stringify(await downloadImages({ handoffId: positional[0], siteUrl, agentToken, authorization, outDir: options.out })));
    throw new ClientError("Unknown command. Run agentrelay help.");
  } catch (e) {
    // Never echo third-party errors, response bodies, argv or supplied credential JSON.
    // The image commands' errors are written for people and carry no credential, like the client's own.
    const safe = e instanceof ClientError || e instanceof UploadError || e instanceof DownloadError ? e.message : "The client operation failed. Check local permissions and connection settings.";
    console.error(`AgentRelay: ${safe}`); process.exitCode = 1;
  }
}
