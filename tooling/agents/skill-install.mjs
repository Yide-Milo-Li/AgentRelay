// The agentrelay Agent Skill: rendered from the template in tooling/agents/skill/ into an agent's skill folder. Only a
// folder whose SKILL.md carries the managed-by marker in its frontmatter is ever replaced, so a skill the user wrote is
// never overwritten.
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../environment/project-root.mjs";
import { ClientError } from "./credential-store.mjs";

export const SKILL_NAME = "agentrelay";
export const SKILL_MARKER = "managed-by: agentrelay-client";
export const SKILL_FILES = ["SKILL.md", "references/handoff-content.md", "references/handoff-receipt.md"];
const templateDir = root => path.join(root, "tooling", "agents", "skill", SKILL_NAME);
const placeholderTemplate = root => path.join(root, "tooling", "agents", "skill", `${SKILL_NAME}-placeholder`, "SKILL.md");

/** Whether client `root` ships the skill template; versions before 0.3.0 do not. */
export const hasSkillTemplate = root => existsSync(path.join(templateDir(root), "SKILL.md"));

/**
 * The command agents run to reach the installed client. The path is quoted plainly: it reads correctly in Bash,
 * PowerShell and cmd, where a JSON-escaped Windows path would show every backslash twice.
 */
export const clientCommand = launcher => `node "${launcher}"`;

/** Windows paths are case-insensitive: two spellings of one folder must count as the same folder. */
export function samePath(left, right, platform = process.platform) {
  const a = path.resolve(left), b = path.resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const fill = (text, values) => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), text);
const checkConnection = connection => {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(connection)) throw new ClientError("Cannot render the skill for an invalid connection id.");
};

/** The skill's files with the client command, connection id and client version filled in. */
export function renderSkill({ launcher, connection, version, root = projectRoot }) {
  checkConnection(connection);
  return SKILL_FILES.map(file => ({ file, text: fill(readFileSync(path.join(templateDir(root), file), "utf8"), { client: clientCommand(launcher), connection, version }) }));
}

/**
 * The placeholder that stands in for the skill where an agent gets no skill but would otherwise find another agent's
 * copy under the same name (DeepSeek Harness reads Codex's folder after its own).
 */
export function renderPlaceholder({ connection, version, root = projectRoot }) {
  checkConnection(connection);
  return [{ file: "SKILL.md", text: fill(readFileSync(placeholderTemplate(root), "utf8"), { connection, version }) }];
}

const read = file => { try { return readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
/** The frontmatter of a SKILL.md, or "" when the file has none: the marker and owner only count there. */
const frontmatter = text => text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
const field = (text, key) => frontmatter(text).match(new RegExp(`^ {2}${key}: "?([^"\\r\\n]+)"?\\r?$`, "m"))?.[1] ?? null;
const isManaged = text => /^ {2}managed-by: agentrelay-client\r?$/m.test(frontmatter(text));

/**
 * What sits in `dir`: null when there is no SKILL.md or it is not AgentRelay's, otherwise the connection it was rendered
 * for, the client version, and whether it is the placeholder.
 */
export function inspectSkill(dir) {
  const text = read(path.join(dir, "SKILL.md"));
  if (text === null || !isManaged(text)) return null;
  return { owner: field(text, "connection"), version: field(text, "client-version"), placeholder: field(text, "role") === "placeholder" };
}

/**
 * The file changes that install the skill (or, with `placeholder`, the placeholder) into `skillDir`, for
 * applyFileChanges. A folder is ours when its SKILL.md is managed, or when none of the skill's files exist yet;
 * anything else stops setup before any write. A placeholder replacing a skill drops the skill's references.
 */
export function planSkill({ skillDir, launcher, connection, version, root, placeholder = false }) {
  if (read(path.join(skillDir, "SKILL.md")) !== null ? !inspectSkill(skillDir) : SKILL_FILES.some(file => existsSync(path.join(skillDir, file))))
    throw new ClientError(`${skillDir} holds a skill AgentRelay did not install. Rename it, or connect with --no-skill; no files changed.`);
  const files = placeholder ? renderPlaceholder({ connection, version, root }) : renderSkill({ launcher, connection, version, root });
  const writes = files.map(({ file, text }) => ({ file: path.join(skillDir, file), text }));
  const leftovers = SKILL_FILES.filter(file => !files.some(item => item.file === file)).map(file => path.join(skillDir, file)).filter(file => existsSync(file));
  return [...writes, ...leftovers.map(file => ({ file, remove: true }))];
}

/**
 * The file changes that remove AgentRelay's skill from `skillDirs`: from every managed folder when `connection` is null
 * (the agent's own folder, which follows its active connection), or only from folders rendered for `connection`. A
 * skill the user wrote is never touched.
 */
export function planSkillRemoval({ skillDirs, connection = null }) {
  const dirs = skillDirs.filter(Boolean).map(dir => path.resolve(dir)).filter((dir, index, all) => all.findIndex(other => samePath(other, dir)) === index);
  return dirs.filter(dir => { const found = inspectSkill(dir); return found && (connection === null || found.owner === connection); })
    .flatMap(dir => SKILL_FILES.map(file => path.join(dir, file)).filter(file => existsSync(file)).map(file => ({ file, remove: true })));
}

/**
 * One batch must touch each file once: a removal is dropped when the batch also writes that file, or already removes
 * it (two spellings of one Windows path, or one folder reached as both the agent's and the connection's).
 */
export const withoutConflicts = changes => changes.filter((change, index) => !change.remove
  || (!changes.some(other => !other.remove && samePath(other.file, change.file))
    && changes.findIndex(other => other.remove && samePath(other.file, change.file)) === index));

/** The folders a batch removed SKILL.md from, for pruneSkillDirs. */
export const removedSkillDirs = changes => changes.filter(change => change.remove && path.basename(change.file) === "SKILL.md").map(change => path.dirname(change.file))
  .filter((dir, index, all) => all.findIndex(other => samePath(other, dir)) === index);

/** After a removal: drop the skill folders it emptied, so no bare `agentrelay` folder is left in the agent's skill list. */
export function pruneSkillDirs(dirs) {
  for (const dir of dirs) for (const folder of [path.join(dir, "references"), dir]) {
    try { rmdirSync(folder); } catch { /* Not empty, or already gone: leave it. */ }
  }
}

/**
 * Re-render installed skills with client `version`'s template, for the connections `isActive` accepts (after an update
 * or rollback). Each folder's files are written to temporary names first and renamed after, so a failure leaves that
 * folder as it was; it is reported in `failed` and the rest continue. A folder the user deleted or took over (marker
 * removed), or that another connection's setup has since claimed, is left alone.
 * @returns {{ refreshed: string[], failed: string[] }}
 */
export function refreshSkills({ records, launcher, version, root }) {
  const refreshed = [], failed = [];
  if (!hasSkillTemplate(root)) return { refreshed, failed };
  for (const record of records) {
    const found = record.skillDir ? inspectSkill(record.skillDir) : null;
    if (!found || found.owner !== record.id) continue;
    const staged = [];
    try {
      const files = found.placeholder ? renderPlaceholder({ connection: record.id, version, root }) : renderSkill({ launcher, connection: record.id, version, root });
      for (const { file, text } of files) {
        const target = path.join(record.skillDir, file), temporary = `${target}.${crypto.randomUUID()}.tmp`;
        mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(temporary, text); staged.push([temporary, target]);
      }
      for (const [temporary, target] of staged) renameSync(temporary, target);
      refreshed.push(record.skillDir);
    } catch { failed.push(record.skillDir); }
    finally { for (const [temporary] of staged) rmSync(temporary, { force: true }); }
  }
  return { refreshed, failed };
}
