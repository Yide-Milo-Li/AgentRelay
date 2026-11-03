import { ClientError, envName } from "./credential-store.mjs";
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { CONFIG_BEGIN, CONFIG_END, upsertConfigBlock, upsertRuleBlock, removeConfigBlock, removeRuleBlock, loadProfiles, findProfile, profilePath } from "./device-setup.mjs";
import { renderDeviceRule, renderSkillRule } from "../../src/shared/formatting/device-rule.mjs";
import { clientCommand, planSkill } from "./skill-install.mjs";

const quoteToml = value => JSON.stringify(value);
/** Helper commands pass only paths and connection ids. Reject shell metacharacters rather than guessing escaping. */
export function helperCommand(node, launcher, id, platform = process.platform) {
  if ([node, launcher, id].some(value => /[\r\n"`$%!&|<>^]/.test(value))) throw new ClientError("The installation path cannot be represented safely in a header helper command. Choose --transport bridge.");
  const quote = value => platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(node)} ${quote(launcher)} headers --connection ${quote(id)}`;
}

export function connectionConfig({ profile, endpoint, id, launcher, node = process.execPath, transport = "bridge", platform, storage, credentialRef, gatewayRef }) {
  const args = [launcher, "bridge", "--connection", id];
  const { label, config } = findProfile(loadProfiles(), profile);
  if (config.format === "yaml") {
    if (transport !== "bridge") throw new ClientError(`${label} requires bridge transport.`);
    // dsh strips inherited variables named like *KEY*/*TOKEN*/*SECRET* from MCP servers, so environment-stored
    // credentials are forwarded by name. Only the variable names enter the file, never their values.
    const forwarded = storage === "env" ? [credentialRef, gatewayRef].filter(Boolean).map(envName) : [];
    // A bare top-level row only overrides a row that already exists; a new plugin row must sit in an insert block.
    return [
      "- insert:",
      `    - id: ${config.rowId}`,
      `      name: "@deepseek-ai/dsh-mcp-client"`,
      "      config:",
      "        serverName: agentrelay",
      "        transport: stdio",
      `        command: ${quoteToml(node)}`,
      `        args: [${args.map(quoteToml).join(", ")}]`,
      ...(forwarded.length ? ["        env:", ...forwarded.map(name => `          ${name}: !!js process.env.${name}`)] : []),
    ].join("\n");
  }
  if (profile === "codex") {
    const body = transport === "direct"
      ? `url = ${quoteToml(endpoint)}\nhttp_headers_helper = ${quoteToml(helperCommand(node, launcher, id, platform))}`
      : `command = ${quoteToml(node)}\nargs = ${JSON.stringify(args)}`;
    return `[mcp_servers.agentrelay]\n${body}`;
  }
  return transport === "direct"
    ? { type: "http", url: endpoint, headersHelper: helperCommand(node, launcher, id, platform) }
    : { command: node, args };
}

const read = file => { try { return readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };

const unquote = value => value.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");

/** The "- " items of a YAML block sequence at column 0: each runs up to the next line that starts at column 0. */
function sequenceItems(lines) {
  const items = [];
  lines.forEach((line, index) => {
    if (!/^\S/.test(line)) return;
    if (items.length && items.at(-1).end === lines.length) items.at(-1).end = index;
    if (/^-(\s|$)/.test(line)) items.push({ start: index, end: lines.length });
  });
  for (const item of items) while (item.end > item.start + 1 && !lines[item.end - 1].trim()) item.end--;
  return items;
}

/** The id and serverName values one patch row declares, from its lines (the first starts with "-"). */
function rowFacts(body) {
  const inline = body[0].match(/^-(\s+)\S/);
  // Keys sit after "- " on the first line, or at the indentation of the first key below a bare "-".
  const column = inline ? inline[1].length + 1 : body.slice(1).find(line => line.trim())?.match(/^ */)[0].length;
  const idLine = body[0].match(/^-\s+id:(.*)$/) ?? body.slice(1).map(line => column && line.match(new RegExp(`^ {${column}}id:(.*)$`))).find(Boolean);
  return { id: idLine ? unquote(idLine[1]) : null, serverNames: body.map(line => line.match(/^\s+serverName:(.*)$/)).filter(Boolean).map(match => unquote(match[1])) };
}

/** The rows one top-level item declares: itself, or the block sequence under "- insert:". Null when it cannot be read safely. */
function itemRows(body) {
  if (!/^-\s+insert:\s*(#.*)?$/.test(body[0])) return /^-\s+insert:/.test(body[0]) ? null : [rowFacts(body)];
  const rest = body.slice(1), indent = rest.find(line => line.trim() && !line.trim().startsWith("#"))?.match(/^( +)-(\s|$)/)?.[1];
  if (!indent || rest.some(line => line.trim() && !line.startsWith(indent))) return null;
  const inner = rest.map(line => line.slice(indent.length));
  return sequenceItems(inner).map(item => rowFacts(inner.slice(item.start, item.end)));
}

/**
 * Insert or replace AgentRelay's insert block in a Cordis patch file (DeepSeek Harness), a top-level YAML block
 * sequence. dsh rewrites this file itself (locale, theme and other settings), which can move or drop comments, so the
 * block is found by the id of the row inside it instead of marker comments. A bare top-level row with that id (which
 * dsh treats as an override of a missing row) is replaced too. Every other item, comment and line ending stays as it was.
 */
export function upsertPatchRow(existing, block, rowId) {
  const { eol, lines, readable, ours } = patchItems(existing, rowId);
  if (readable.some(item => item.rows.some(row => row.id !== rowId && row.serverNames.includes("agentrelay"))))
    throw new ClientError("Another DeepSeek Harness row already uses serverName agentrelay. Review and remove it before connecting; no files changed.");
  const blockLines = block.split("\n");
  if (ours.length) return [...lines.slice(0, ours[0].start), ...blockLines, ...lines.slice(ours[0].end)].join(eol);
  if (!existing.trim()) return blockLines.join(eol) + eol;
  return existing.replace(/\s*$/, "") + eol + blockLines.join(eol) + eol;
}

/** The patch file without AgentRelay's insert block (or bare row); every other item, comment and line ending stays. */
export function removePatchRow(existing, rowId) {
  const { eol, lines, ours } = patchItems(existing, rowId);
  if (!ours.length) return existing;
  const kept = [...lines.slice(0, ours[0].start), ...lines.slice(ours[0].end)].join(eol);
  return kept.trim() ? kept.replace(/\s*$/, "") + eol : "";
}

/** A patch file's top-level items and the one that declares `rowId`, refusing a file that cannot be edited safely. */
function patchItems(existing, rowId) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n", lines = existing.split(/\r?\n/);
  const topLevel = lines.filter(line => /^\S/.test(line) && !line.startsWith("#") && line !== "---");
  if (topLevel.some(line => !/^-(\s|$)/.test(line)))
    throw new ClientError("The DeepSeek Harness patch file is not a YAML list of patch rows. Repair it before connecting; no files changed.");
  const items = sequenceItems(lines).map(item => {
    const body = lines.slice(item.start, item.end);
    return { ...item, body, rows: itemRows(body) };
  });
  if (items.some(item => item.rows === null && item.body.some(line => /\b(mcp-agentrelay|agentrelay)\b/.test(line))))
    throw new ClientError("An insert block that mentions agentrelay cannot be read safely. Rewrite it as a block list and retry; no files changed.");
  const readable = items.filter(item => item.rows !== null);
  const ours = readable.filter(item => item.rows.some(row => row.id === rowId));
  if (ours.some(item => item.rows.length > 1))
    throw new ClientError(`The ${rowId} row shares an insert block with other rows. Move it into its own block and retry; no files changed.`);
  if (ours.length > 1) throw new ClientError(`The DeepSeek Harness patch file defines ${rowId} more than once. Keep one row and retry; no files changed.`);
  return { eol, lines, readable, ours };
}

/**
 * Build every file change before writing any. Only the AgentRelay entry/block is replaced. With `skillDir` the
 * agentrelay skill is written there too and the rule block becomes the short pointer to it.
 */
export function planConfiguration({ record, launcher, home, node, lang = "en", configFile, ruleFile, skillDir = null, placeholderDir = null, version, root }) {
  const profile = findProfile(loadProfiles(), record.profile);
  const configTarget = configFile ?? profilePath(profile, profile.config.file, home), ruleTarget = ruleFile ?? profilePath(profile, profile.ruleFile, home);
  if (path.resolve(configTarget) === path.resolve(ruleTarget)) throw new ClientError("Config and instruction paths must be different.");
  const previous = read(configTarget), config = connectionConfig({ ...record, launcher, node });
  let next;
  if (profile.config.format === "yaml") next = upsertPatchRow(previous, config, profile.config.rowId);
  else if (record.profile === "codex") {
    const start = previous.indexOf(CONFIG_BEGIN), end = previous.indexOf(CONFIG_END);
    const unmanaged = start >= 0 && end > start ? previous.slice(0, start) + previous.slice(end + CONFIG_END.length) : previous;
    if (/^\s*\[mcp_servers\.agentrelay(?:\.[^\]]+)?\]/m.test(unmanaged))
      throw new ClientError("An unmanaged Codex AgentRelay table exists. Review and remove it before migrating; no files changed.");
    next = upsertConfigBlock(previous, config);
  } else {
    let value;
    try { value = previous ? JSON.parse(previous) : {}; } catch { throw new ClientError("The agent config is not valid JSON. Repair it before connecting."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || (value.mcpServers && (typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers)))) throw new ClientError("The agent config has an unsupported shape.");
    value.mcpServers = { ...value.mcpServers, agentrelay: config };
    next = JSON.stringify(value, null, 2) + "\n";
  }
  return [{ file: configTarget, text: next }, ...planInstructions({ record, launcher, lang, ruleTarget, skillDir, placeholderDir, version, root })];
}

/** Whether `text` starts connection `id`: the id follows `--connection` in a bridge argument list or a header helper. */
const namesConnection = (text, id) => new RegExp(`--connection[^A-Za-z0-9_-]+${id}(?![A-Za-z0-9_-])`).test(text);

/**
 * The file changes that take a connection out of its agent, with the same per-format writers connect uses: the
 * AgentRelay MCP entry when it starts this connection (an entry for another one is left and reported as
 * `keptConfig`), and the rule block. Files that would not change are left out. Needs no Site.
 */
export function planRemoval({ record, configFile, ruleFile }) {
  const profile = findProfile(loadProfiles(), record.profile), previous = read(configFile);
  let next;
  if (profile.config.format === "yaml") next = removePatchRow(previous, profile.config.rowId);
  else if (record.profile === "codex") next = removeConfigBlock(previous);
  else {
    let value;
    try { value = previous ? JSON.parse(previous) : {}; } catch { throw new ClientError(`${configFile} is not valid JSON. Repair it and retry; nothing was removed.`); }
    if (value?.mcpServers?.agentrelay === undefined) next = previous;
    else { delete value.mcpServers.agentrelay; next = JSON.stringify(value, null, 2) + "\n"; }
  }
  const config = next !== previous && namesConnection(previous, record.id) && !namesConnection(next, record.id);
  const rule = read(ruleFile), ruleNext = removeRuleBlock(rule);
  return { changes: [...config ? [{ file: configFile, text: next }] : [], ...ruleNext !== rule ? [{ file: ruleFile, text: ruleNext }] : []],
    config, rule: ruleNext !== rule, keptConfig: next !== previous && !config };
}

/**
 * The instruction side of a connection: the rule block in `ruleTarget` and, with `skillDir`, the agentrelay skill, in
 * which case the rule is the short pointer to it. Without a skill, `placeholderDir` receives the placeholder. Used by
 * connect, the `skill` command and rollback, which leave the MCP config alone. `root` is the client whose templates render.
 */
export function planInstructions({ record, launcher, lang = "en", ruleTarget, skillDir = null, placeholderDir = null, version, root }) {
  const device = record.deviceId ? { bound: true } : undefined, siteUrl = new URL(record.endpoint).origin;
  if (skillDir) return [{ file: ruleTarget, text: upsertRuleBlock(read(ruleTarget), renderSkillRule(lang, siteUrl, device, record.profile)) },
    ...planSkill({ skillDir, launcher, connection: record.id, version, root })];
  // Installed image commands work from any project and use the same connection's credentials.
  const imageCommand = `${clientCommand(launcher)} upload --connection ${record.id}`;
  const downloadCommand = `${clientCommand(launcher)} download --connection ${record.id}`;
  const rule = renderDeviceRule(lang, siteUrl, device)
    .replaceAll("node scripts/agents/upload-attachments.mjs", imageCommand)
    .replaceAll("node scripts/agents/download-attachments.mjs", downloadCommand)
    .replaceAll("from the AgentRelay checkout", "from any directory")
    .replaceAll("It reads the Site URL and credentials from the environment", "It reads this connection's Site URL and credentials from local storage")
    .replaceAll("在 AgentRelay 仓库目录运行", "在任意目录运行")
    .replaceAll("它从环境变量读取站点地址和凭据", "它读取本连接保存的站点地址和凭据");
  return [{ file: ruleTarget, text: upsertRuleBlock(read(ruleTarget), rule) },
    ...placeholderDir ? planSkill({ skillDir: placeholderDir, launcher, connection: record.id, version, root, placeholder: true }) : []];
}

/**
 * Roll back only files this operation wrote or removed; refuse to overwrite an intervening edit during recovery.
 * A change is `{ file, text }` to write, or `{ file, remove: true }` to delete a file that may exist.
 */
export function applyFileChanges(changes, { write = writeFileSync } = {}) {
  const snapshots = changes.map(change => ({ ...change, existed: existsSync(change.file), before: read(change.file) }));
  const written = [];
  try {
    for (const change of snapshots) {
      if (read(change.file) !== change.before || existsSync(change.file) !== change.existed) throw new ClientError("A config changed during setup. Retry after closing its editor.");
      if (change.remove) {
        if (change.existed) unlinkSync(change.file);
        written.push(change);
        continue;
      }
      mkdirSync(path.dirname(change.file), { recursive: true });
      // Write beside the target, then rename: a truncated/failed write must never corrupt an existing config.
      const temporary = `${change.file}.${crypto.randomUUID()}.tmp`;
      try { write(temporary, change.text, { mode: 0o600 }); renameSync(temporary, change.file); }
      finally { rmSync(temporary, { force: true }); }
      written.push(change);
    }
  } catch {
    rollbackFiles(written);
    throw new ClientError("Configuration failed. Changes written by this operation were rolled back.");
  }
  return () => rollbackFiles(written);
}
function rollbackFiles(written) {
  for (const change of [...written].reverse()) {
    if (change.remove ? existsSync(change.file) : read(change.file) !== change.text) throw new ClientError("Recovery found a newer config edit. Restore the previous AgentRelay entry manually.");
    if (!change.existed) { if (!change.remove) unlinkSync(change.file); continue; }
    mkdirSync(path.dirname(change.file), { recursive: true });
    writeFileSync(change.file, change.before);
  }
}
