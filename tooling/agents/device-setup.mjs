// Shared building blocks for the device setup scripts. Secrets are only ever read from the environment,
// compared in memory and sent to the Site; they are never written to a file or printed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../environment/project-root.mjs";
import { fillValues } from "../../src/shared/agent-profiles/site-url.mjs";

export const ENDPOINT_SUFFIX = "/api/agent/mcp";
export const RULE_BEGIN = "<!-- agentrelay:device-rule:begin -->";
export const RULE_END = "<!-- agentrelay:device-rule:end -->";
const TOKEN_PATTERN = /^agentrelay_[a-f0-9]{64}$/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EXAMPLE_ENDPOINT = `https://agentrelay.example.chatgpt.site${ENDPOINT_SUFFIX}`;

export function loadProfiles() {
  return JSON.parse(readFileSync(path.join(projectRoot, "src", "shared", "agent-profiles", "profiles.json"), "utf8")).profiles;
}

export function findProfile(profiles, id) {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown profile "${id}". Available: ${profiles.map((item) => item.id).join(", ")}.`);
  return profile;
}

/** The Site's MCP endpoint from `--url` or AGENTRELAY_MCP_URL. Only a local development Worker may use plain http. */
export function resolveSite({ url, env = process.env } = {}) {
  const endpoint = new URL(url ?? env.AGENTRELAY_MCP_URL ?? EXAMPLE_ENDPOINT);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Use a Site endpoint without embedded credentials, query parameters or fragments.");
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && LOOPBACK.has(endpoint.hostname)))
    throw new Error("Use the HTTPS endpoint returned by the current AgentRelay site.");
  if (!endpoint.pathname.endsWith(ENDPOINT_SUFFIX)) throw new Error(`The endpoint must end with ${ENDPOINT_SUFFIX}.`);
  const siteUrl = endpoint.origin + endpoint.pathname.slice(0, -ENDPOINT_SUFFIX.length);
  return { endpoint: endpoint.href, siteUrl };
}

/** The stdio bridge script on this device, for profiles whose agent starts it. */
export const BRIDGE_SCRIPT = path.join(projectRoot, "scripts", "agents", "mcp-bridge.mjs");

export const renderProfileConfig = (profile, siteUrl, { gateway = true } = {}) => {
  const config = fillValues(profile.config.template, { siteUrl, bridgePath: BRIDGE_SCRIPT });
  return gateway ? config : withoutGateway(config);
};

const GATEWAY_REFERENCE = /OAI-Sites-Authorization|AGENTRELAY_SITES_GATEWAY_/;
/**
 * A profile's config for a deployment without the Sites gate: every header and variable that carries the gateway token
 * is left out. Text configs (TOML, YAML) lose the lines that name it; JSON configs lose the keys.
 */
export function withoutGateway(config) {
  if (typeof config === "string") return config.split("\n").filter(line => !GATEWAY_REFERENCE.test(line)).join("\n");
  if (Array.isArray(config)) return config.map(withoutGateway);
  if (!config || typeof config !== "object") return config;
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => !GATEWAY_REFERENCE.test(key) && !(typeof value === "string" && GATEWAY_REFERENCE.test(value)))
    .map(([key, value]) => [key, withoutGateway(value)]));
}

/** The variable holding the Sites gateway token. A deployment without that gate needs none; connect checks which. */
export const GATEWAY_SECRET = "AGENTRELAY_SITES_GATEWAY_TOKEN";

/** Fail before touching the agent when a secret is missing or the Agent Token is a retired credential. */
export function requireSecrets(profile, env = process.env) {
  for (const name of profile.secrets) {
    if (name === GATEWAY_SECRET) continue;
    if (!env[name]?.trim()) throw new Error(`Set ${name} in this terminal before configuring ${profile.label}. It is read from the environment and never written to a file.`);
  }
  if (!TOKEN_PATTERN.test(env.AGENTRELAY_AGENT_TOKEN ?? "")) {
    throw new Error("Use a newly issued agentrelay_ personal Agent Token; retired credentials are not supported.");
  }
}

/** Register the connection through the agent's own CLI. Returns the CLI's exit status. */
export function registerWithCli(profile, config, { endpoint } = {}) {
  if (!profile.cli) throw new Error(`${profile.label} has no setup command. Use its config file instead, or add the printed config yourself.`);
  const entry = (profile.config.entryPath ?? []).reduce((node, key) => node[key], config);
  const argv = profile.cli.args.map((arg) => (arg === "{entry}" ? JSON.stringify(entry) : fillValues(arg, { endpoint, bridgePath: BRIDGE_SCRIPT })));
  // An earlier registration would make the add fail; its absence is not an error.
  if (profile.cli.remove) spawnSync(profile.cli.command, profile.cli.remove, { stdio: "ignore", windowsHide: true });
  const result = spawnSync(profile.cli.command, argv, { stdio: "inherit", windowsHide: true });
  if (result.error) throw new Error(profile.cli.missing);
  return result.status ?? 1;
}

/** Call tools/list with the credentials, the same request any agent makes first. */
export async function verifyConnection({ endpoint, agentToken, gatewayToken, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${agentToken}`, ...(gatewayToken ? { "OAI-Sites-Authorization": `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
  } catch (error) {
    return { ok: false, detail: `Cannot reach the site (${error?.cause?.code ?? error?.message ?? "network error"}).` };
  }
  let body = null;
  try { body = await response.json(); } catch { /* A restricted site answers a wrong gateway token with an HTML page. */ }
  const tools = body?.result?.tools?.map((tool) => tool.name);
  const expected = ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"];
  if (response.ok && Array.isArray(tools) && expected.every(name => tools.includes(name)) && tools.length === expected.length) return { ok: true, tools };
  if (body?.result?.isError) return { ok: false, detail: `The site rejected the Agent Token (${body.result.content?.[0]?.text ?? response.status}).` };
  if (!body) return { ok: false, detail: `The site answered ${response.status} without MCP data. Check that the endpoint belongs to the current Site and, on ChatGPT Sites, the gateway token.` };
  return { ok: false, detail: `Unexpected answer from the site (status ${response.status}).` };
}

export function expandHome(file, home) {
  return file === "~" ? home : file.startsWith("~/") ? path.join(home, file.slice(2)) : file;
}

/** A profile's file on this device. When the agent's home variable (such as DSH_HOME) is set, paths under its default home move with it. */
export function profilePath(profile, file, home, env = process.env) {
  const moved = profile.home && env[profile.home.variable]?.trim();
  if (moved && file.startsWith(`${profile.home.path}/`)) return path.join(path.resolve(moved), file.slice(profile.home.path.length + 1));
  return expandHome(file, home);
}

/** Insert or replace a marked block; everything outside the markers stays exactly as it was. */
function upsertBlock(existing, beginMarker, endMarker, lines) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = [beginMarker, ...lines, endMarker].join(eol);
  const begin = existing.indexOf(beginMarker), end = existing.indexOf(endMarker);
  if (begin !== -1 && end > begin) return existing.slice(0, begin) + block + existing.slice(end + endMarker.length);
  if (!existing.trim()) return block + eol;
  return existing.replace(/\s*$/, "") + eol + eol + block + eol;
}

/** Cut a marked block and the blank line upsertBlock put before it; everything else stays as it was. */
function removeBlock(existing, beginMarker, endMarker) {
  const begin = existing.indexOf(beginMarker), end = existing.indexOf(endMarker);
  if (begin === -1 || end < begin) return existing;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const head = existing.slice(0, begin).replace(/(\r?\n)+$/, ""), tail = existing.slice(end + endMarker.length).replace(/^\r?\n/, "");
  if (!head) return tail.replace(/^(\r?\n)+/, "");
  return tail.trim() ? head + eol + tail : head + eol;
}

export const upsertRuleBlock = (existing, rule) => upsertBlock(existing, RULE_BEGIN, RULE_END, rule.split("\n"));
export const removeRuleBlock = existing => removeBlock(existing, RULE_BEGIN, RULE_END);

export const CONFIG_BEGIN = "# agentrelay:mcp-config:begin";
export const CONFIG_END = "# agentrelay:mcp-config:end";

/** Insert or replace AgentRelay's managed block in a `#`-commented config file such as Codex's config.toml. */
export const upsertConfigBlock = (existing, text) => upsertBlock(existing, CONFIG_BEGIN, CONFIG_END, text.split("\n"));
export const removeConfigBlock = existing => removeBlock(existing, CONFIG_BEGIN, CONFIG_END);

/** The text with AgentRelay's managed block cut out, to find an entry the user wrote by hand. */
function withoutConfigBlock(existing) {
  const begin = existing.indexOf(CONFIG_BEGIN), end = existing.indexOf(CONFIG_END);
  return begin !== -1 && end > begin ? existing.slice(0, begin) + existing.slice(end + CONFIG_END.length) : existing;
}

/**
 * For agents configured through a file (Codex): write the connection as a managed block. A table of the same name
 * outside the block would make the file invalid, so it is reported instead of duplicated.
 * @returns {string} The file that was written.
 */
export function registerWithFile(profile, text, { file, home, files = { read: readFileSync, write: writeFileSync, mkdir: mkdirSync } }) {
  const target = path.resolve(expandHome(file ?? profile.config.file, home));
  let existing = "";
  try { existing = files.read(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const table = profile.config.table.replaceAll(".", "\\.");
  if (new RegExp(`^\\s*\\[${table}\\]`, "m").test(withoutConfigBlock(existing))) {
    throw new Error(`${target} already defines [${profile.config.table}] outside AgentRelay's managed block. Remove that entry (it would duplicate this one) and run the command again.`);
  }
  files.mkdir(path.dirname(target), { recursive: true });
  files.write(target, upsertConfigBlock(existing, text));
  return target;
}

/**
 * The environment variables to save for a profile, with the tokens filled into their templates. Without a gateway
 * token (a deployment without the Sites gate) the variables made from it are left out rather than saved empty.
 */
export function persistValues(profile, env = process.env) {
  const gateway = env[GATEWAY_SECRET]?.trim();
  return Object.fromEntries(Object.entries(profile.persist).filter(([, template]) => gateway || !template.includes("{gatewayToken}"))
    .map(([name, template]) => [name, template.replaceAll("{agentToken}", env.AGENTRELAY_AGENT_TOKEN ?? "").replaceAll("{gatewayToken}", gateway ?? "")]));
}

export const ENV_BEGIN = "# agentrelay:env:begin";
export const ENV_END = "# agentrelay:env:end";
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The profile file a login shell reads. Shells without a POSIX `export` (fish) are left to the user. */
export function shellProfileFor({ platform, shell = "", home }) {
  const name = path.basename(shell);
  if (name === "fish" || name === "nu" || name === "pwsh") return null;
  if (name === "zsh") return path.join(home, ".zshrc");
  if (name === "bash") return path.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return path.join(home, ".profile");
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Insert or replace the `export` block for the given variables. */
export function upsertEnvBlock(existing, values, blockId = "") {
  const suffix = blockId ? `:${blockId}` : "";
  return upsertBlock(existing, ENV_BEGIN + suffix, ENV_END + suffix, Object.entries(values).map(([name, value]) => `export ${name}=${shellQuote(value)}`));
}
export const removeEnvBlock = (existing, blockId = "") => removeBlock(existing, ENV_BEGIN + (blockId ? `:${blockId}` : ""), ENV_END + (blockId ? `:${blockId}` : ""));

/**
 * Save variables to the user's own environment so every later session of the agent sees them. These are plaintext
 * values that the agent's child processes inherit, which is why callers must ask for it explicitly.
 * Windows: the User environment (registry), with values passed through the child's environment, never its arguments.
 * Elsewhere: a marked block in the login shell's profile file.
 * @returns {{ where: string, restart: string }}
 */
export function persistUserEnv(names, { label = "your agent", env = process.env, platform = process.platform, home, run = spawnSync, blockId = "", files = { read: readFileSync, write: writeFileSync, mkdir: mkdirSync } } = {}) {
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`Refusing to persist "${name}": not a plain environment variable name.`);
    if (!env[name]) throw new Error(`${name} is not set in this terminal, so there is nothing to save.`);
  }
  if (platform === "win32") {
    const snapshot = names.map((name, i) => `$agentrelayPrevious${i} = [Environment]::GetEnvironmentVariable('${name}', 'User')`).join("; ");
    const update = names.map((name) => `[Environment]::SetEnvironmentVariable('${name}', $env:${name}, 'User')`).join("; ");
    const restore = names.map((name, i) => `[Environment]::SetEnvironmentVariable('${name}', $agentrelayPrevious${i}, 'User')`).join("; ");
    const script = `${snapshot}; try { ${update} } catch { ${restore}; exit 1 }`;
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, stdio: "ignore", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("Windows did not accept the user environment change. Set the variables in System Properties > Environment Variables instead.");
    return { where: "your Windows user environment variables", restart: `Quit and reopen your terminal app (Windows Terminal, VS Code) and ${label} so they take effect: new tabs of an app that was already running keep the old environment.` };
  }
  const profile = shellProfileFor({ platform, shell: env.SHELL, home });
  if (!profile) throw new Error(`Cannot edit the profile of ${path.basename(env.SHELL ?? "")} automatically. Add the variables to your shell configuration yourself.`);
  let existing = "";
  try { existing = files.read(profile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  files.mkdir(path.dirname(profile), { recursive: true });
  const temporary = `${profile}.${crypto.randomUUID()}.tmp`;
  try {
    files.write(temporary, upsertEnvBlock(existing, Object.fromEntries(names.map((name) => [name, env[name]])), blockId), { mode: 0o600 });
    renameSync(temporary, profile);
  } finally { rmSync(temporary, { force: true }); }
  return { where: profile, restart: `Open a new terminal and restart ${label} so they take effect. Apps launched from the desktop do not read shell profiles.` };
}

/**
 * Undo persistUserEnv: on Windows delete the named User variables; elsewhere cut the marked blocks `blockIds` from the
 * login shell's profile. Values are never read or printed. A variable or block that is already gone is not an error.
 * @returns {{ where: string, restart: string }}
 */
export function clearUserEnv(names, { blockIds = [], label = "your agents", env = process.env, platform = process.platform, home, run = spawnSync, files = { read: readFileSync, write: writeFileSync, mkdir: mkdirSync } } = {}) {
  for (const name of names) if (!ENV_NAME.test(name)) throw new Error(`Refusing to clear "${name}": not a plain environment variable name.`);
  if (platform === "win32") {
    if (names.length) {
      const script = names.map((name) => `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`).join("; ");
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, stdio: "ignore", windowsHide: true });
      if (result.error || result.status !== 0) throw new Error("Windows did not accept the user environment change. Delete the variables in System Properties > Environment Variables instead.");
    }
    return { where: "your Windows user environment variables", restart: `Quit and reopen your terminal app and ${label} so the removal takes effect.` };
  }
  const profile = shellProfileFor({ platform, shell: env.SHELL, home });
  if (!profile) throw new Error(`Cannot edit the profile of ${path.basename(env.SHELL ?? "")} automatically. Remove the AgentRelay variables from your shell configuration yourself.`);
  let existing;
  try { existing = files.read(profile, "utf8"); } catch (error) { if (error.code === "ENOENT") return { where: profile, restart: "" }; throw error; }
  const next = blockIds.reduce((text, blockId) => removeEnvBlock(text, blockId), existing);
  if (next !== existing) {
    const temporary = `${profile}.${crypto.randomUUID()}.tmp`;
    try { files.write(temporary, next, { mode: 0o600 }); renameSync(temporary, profile); }
    finally { rmSync(temporary, { force: true }); }
  }
  return { where: profile, restart: `Open a new terminal and restart ${label} so the removal takes effect.` };
}
