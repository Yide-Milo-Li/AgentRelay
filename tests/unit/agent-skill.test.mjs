import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { connect, refreshRules, retireSkills, setupSkill, setupSummary, skillStatus } from "../../tooling/agents/client.mjs";
import { applyFileChanges, connectionConfig, helperCommand } from "../../tooling/agents/client-config.mjs";
import { readManifest, saveManifest } from "../../tooling/agents/credential-store.mjs";
import { namesConnection } from "../../tooling/agents/active-connection.mjs";
import { CLIENT_FILES, CLIENT_VERSION } from "../../tooling/agents/client-install.mjs";
import { SKILL_FILES, SKILL_MARKER, inspectSkill, planSkill, planSkillRemoval, refreshSkills, renderSkill, samePath, withoutConflicts } from "../../tooling/agents/skill-install.mjs";
import { renderDeviceRule, renderSkillRule } from "../../src/shared/formatting/device-rule.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const template = fs.readFileSync(path.join(projectRoot, "tooling/agents/skill/agentrelay/SKILL.md"), "utf8");
const frontmatter = yaml.load(template.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)[1]);
const launcher = path.join(os.tmpdir(), "Some One", ".agentrelay", "client", "agentrelay.mjs");
const endpoint = "https://example.test/api/agent/mcp";
const secrets = { agentToken: `agentrelay_${"a".repeat(64)}`, gatewayToken: "synthetic-gateway" };
const tools = ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff"];
const reply = (id, deviceId) => async url => new Response(JSON.stringify(String(url).endsWith("/api/agent/connection")
  ? { connection: { id, deviceId, createdByName: "Tester" }, workspace: { shared: false } } : { result: { tools: tools.map(name => ({ name })) } }), { headers: { "Content-Type": "application/json" } });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrelay-skill-")), data = new Map();
  const settings = { home: path.join(root, "state"), userHome: path.join(root, "user"), launcher: path.join(root, "agentrelay.mjs"),
    store: { get: ref => data.get(ref) ?? null, set: (ref, value) => data.set(ref, value), remove: ref => data.delete(ref) } };
  return { root, settings, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const read = file => fs.readFileSync(file, "utf8");

test("the skill's frontmatter passes the strictest loader and leads with its triggers", () => {
  // DeepSeek Harness drops a skill whose name is not kebab-case or whose description is missing, with no message to the model.
  assert.match(frontmatter.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(frontmatter.name, path.basename(path.dirname(path.join(projectRoot, "tooling/agents/skill/agentrelay/SKILL.md"))));
  assert.ok(frontmatter.description.length <= 1000, "Claude Code truncates at 1,536 and Codex shortens long descriptions");
  // DeepSeek Harness caps catalog descriptions at 500 characters by default.
  const head = frontmatter.description.slice(0, 500);
  for (const word of ["hand off", "another device", "incoming", "交接", "接收交接", "完成交接"]) assert.ok(head.includes(word), word);
  assert.equal(typeof frontmatter.metadata, "object"); assert.equal(frontmatter.metadata["managed-by"], "agentrelay-client");
  assert.ok(template.split("\n").length < 200, "the body stays short enough to load whole");
  for (const [, link] of template.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(SKILL_FILES.includes(link), link);
});

test("rendering fills every placeholder with the launcher command and connection", () => {
  const files = renderSkill({ launcher, connection: "conn-1", version: "9.9.9" });
  assert.deepEqual(files.map(item => item.file), SKILL_FILES);
  for (const { text } of files) assert.equal(/\{(client|connection|version)\}/.test(text), false);
  const skill = files[0].text;
  // Plain quotes: a JSON-escaped Windows path would print every backslash twice.
  assert.ok(skill.includes(`node "${launcher}" context`));
  // The body names no connection: every agent's copy reads the same, and the agent passes its own profile.
  assert.ok(skill.includes("upload --agent <profile>") && skill.includes("download --agent <profile>") && !/--connection/.test(skill));
  const body = text => text.replace(/^---[\s\S]*?\r?\n---\r?\n/, "");
  assert.equal(body(renderSkill({ launcher, connection: "conn-2", version: "9.9.9" })[0].text), body(skill), "two connections' skills differ only in metadata");
  assert.ok(skill.includes('client-version: "9.9.9"') && skill.includes(SKILL_MARKER) && skill.includes('  connection: "conn-1"'));
  assert.throws(() => renderSkill({ launcher, connection: "a b", version: "1.0.0" }), /invalid connection id/);
  // The installed client carries the template, so an update can re-render it.
  for (const file of SKILL_FILES) assert.ok(CLIENT_FILES.includes(`tooling/agents/skill/agentrelay/${file}`), file);
  assert.ok(CLIENT_FILES.includes("tooling/agents/skill/agentrelay-placeholder/SKILL.md") && CLIENT_FILES.includes("tooling/agents/active-connection.mjs"));
});

test("the skill and the full rule describe the same protocol", () => {
  // A protocol element added to one copy and not the other fails here.
  const rule = renderDeviceRule("en", "https://example.test", { bound: true });
  for (const element of ["create_handoff", "list_handoffs", "get_handoff", "claim_handoff", "complete_handoff", "requestKey", "project",
    "branch", "baseCommit", "replyTo", "attachmentIds", "attachmentId", "self", "version", "untrusted", "uncommitted", "push"]) {
    assert.ok(rule.includes(element), `rule mentions ${element}`);
    assert.ok(template.includes(element), `skill mentions ${element}`);
  }
  assert.ok(template.includes("result") && rule.includes("result receipt"));
});

test("the short rule points to the skill and keeps the device line and the untrusted-data rule", () => {
  for (const lang of ["en", "zh"]) {
    const short = renderSkillRule(lang, "https://example.test", { bound: true }), full = renderDeviceRule(lang, "https://example.test", { bound: true });
    assert.ok(short.includes("`agentrelay` skill") && short.includes("`self`") && short.includes("https://example.test"));
    assert.ok(short.length * 2 < full.length, `${lang}: ${short.length} vs ${full.length}`);
  }
  assert.match(renderSkillRule("en", "https://example.test", { bound: true }), /untrusted data/);
  assert.match(renderSkillRule("en", "https://example.test", { bound: true }, "antigravity"), /--agent antigravity/);
  assert.match(renderSkillRule("zh", "https://example.test", { bound: true }, "antigravity"), /--agent antigravity/);
  assert.match(renderSkillRule("zh", "https://example.test", { bound: true }), /待核对/);
});

test("only a folder the client installed, or an empty one, is planned for writing", () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, "agentrelay"), plan = () => planSkill({ skillDir: dir, launcher, connection: "c", version: "1.0.0" });
    assert.deepEqual(plan().map(change => path.relative(dir, change.file).replaceAll("\\", "/")), SKILL_FILES);
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    assert.equal(plan().length, SKILL_FILES.length, "an empty folder left by a rollback is reused");
    fs.writeFileSync(path.join(dir, "references", "handoff-content.md"), "mine");
    assert.throws(plan, /did not install/);
    fs.rmSync(path.join(dir, "references", "handoff-content.md"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: agentrelay\ndescription: my own\n---\n");
    assert.throws(plan, /did not install.*--no-skill/);
    // The marker only counts in the frontmatter: a skill of the user's that merely mentions it is still theirs.
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: agentrelay\ndescription: mine\n---\nSee "${SKILL_MARKER}" in AgentRelay's docs.\n`);
    assert.throws(plan, /did not install/);
    fs.writeFileSync(path.join(dir, "SKILL.md"), renderSkill({ launcher, connection: "old", version: "0.0.1" })[0].text);
    assert.equal(plan().length, SKILL_FILES.length);
    assert.deepEqual(inspectSkill(dir), { owner: "old", version: "0.0.1", placeholder: false });
  } finally { f.close(); }
});

test("connect installs the skill for a device-bound connection and writes the short rule", async () => {
  const f = fixture();
  try {
    const result = await connect({ profile: "claude-code", url: endpoint, connection: "c1", device: "desk", transport: "bridge" }, secrets, { ...f.settings, fetchImpl: reply("c1", "desk") });
    const dir = path.join(f.settings.userHome, ".claude", "skills", "agentrelay");
    assert.equal(result.skillDir, dir); assert.equal(readManifest(f.settings.home).connections.c1.skillDir, dir);
    for (const file of SKILL_FILES) assert.ok(result.files.includes(path.join(dir, file)), file);
    assert.ok(read(path.join(dir, "SKILL.md")).includes(`node "${f.settings.launcher}" upload --agent <profile>`));
    assert.equal(readManifest(f.settings.home).active["claude-code"], "c1");
    const rule = read(path.join(f.settings.userHome, ".claude", "CLAUDE.md"));
    assert.ok(rule.includes("`agentrelay` skill") && !rule.includes("upload --connection") && rule.includes("`--agent claude-code`"), "the rule names this agent's profile");
    // DSH_HOME moves the DeepSeek Harness skill with the rest of its files.
    const moved = path.join(f.root, "dsh-home"), previous = process.env.DSH_HOME;
    process.env.DSH_HOME = moved;
    try {
      const dsh = await connect({ profile: "deepseek-harness", url: endpoint, connection: "c2", device: "desk" }, { ...secrets, agentToken: `agentrelay_${"b".repeat(64)}` }, { ...f.settings, fetchImpl: reply("c2", "desk") });
      assert.equal(dsh.skillDir, path.join(moved, "skills", "agentrelay"));
    } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; }
  } finally { f.close(); }
});

test("--no-skill and unbound connections keep the full rule and install no skill", async () => {
  const f = fixture();
  try {
    const optOut = await connect({ profile: "codex", url: endpoint, connection: "c1", device: "desk", transport: "bridge", "no-skill": true }, secrets, { ...f.settings, fetchImpl: reply("c1", "desk") });
    assert.equal(optOut.skillDir, null); assert.equal(fs.existsSync(path.join(f.settings.userHome, ".agents")), false);
    assert.match(read(path.join(f.settings.userHome, ".codex", "AGENTS.md")), /upload --connection c1/);
    const unbound = await connect({ profile: "antigravity", url: endpoint, connection: "c2" }, { ...secrets, agentToken: `agentrelay_${"c".repeat(64)}` }, { ...f.settings, fetchImpl: reply("c2", null) });
    assert.equal(unbound.skillDir, null); assert.equal(fs.existsSync(path.join(f.settings.userHome, ".gemini", "config", "skills")), false);
  } finally { f.close(); }
});

test("a skill this connection installed is removed once the connection no longer gets one", async () => {
  const f = fixture();
  try {
    const dir = path.join(f.settings.userHome, ".claude", "skills", "agentrelay"), rule = path.join(f.settings.userHome, ".claude", "CLAUDE.md");
    const run = (deviceId, extra = {}) => connect({ profile: "claude-code", url: endpoint, connection: "c1", transport: "bridge", ...extra }, secrets, { ...f.settings, fetchImpl: reply("c1", deviceId) });
    await run("desk");
    assert.ok(fs.existsSync(path.join(dir, "SKILL.md")));
    // Unbound in the Site since: the skill would send and claim as `self`, which no longer resolves.
    const unbound = await run(null);
    assert.deepEqual(unbound.removedSkills, [dir]); assert.equal(unbound.skillDir, null);
    assert.equal(fs.existsSync(dir), false, "the emptied folder is removed too");
    assert.equal(readManifest(f.settings.home).connections.c1.skillDir, null);
    assert.match(read(rule), /upload --connection c1/);
    assert.ok(!unbound.files.some(file => file.startsWith(dir)));
    await run("desk");
    const optedOut = await run("desk", { "no-skill": true });
    assert.deepEqual(optedOut.removedSkills, [dir]); assert.equal(fs.existsSync(dir), false);
    // Nothing to remove the second time.
    assert.deepEqual((await run("desk", { "no-skill": true })).removedSkills, []);
  } finally { f.close(); }
});

test("an agent keeps one AgentRelay skill, its active connection's, and never touches the user's own", async () => {
  const f = fixture();
  try {
    const dir = path.join(f.settings.userHome, ".claude", "skills", "agentrelay"), moved = path.join(f.root, "moved-skill");
    const run = (id, deviceId, extra = {}, settings = {}) => connect({ profile: "claude-code", url: endpoint, connection: id, transport: "bridge", ...extra },
      { ...secrets, agentToken: `agentrelay_${id.at(-1).repeat(64)}` }, { ...f.settings, fetchImpl: reply(id, deviceId), ...settings });
    await run("c1", "desk");
    // c2 replaces c1 for this agent and is unbound: c1's skill goes although c2 never installed it.
    const replaced = await run("c2", null);
    assert.deepEqual(replaced.removedSkills, [dir]); assert.equal(fs.existsSync(dir), false);
    assert.equal(readManifest(f.settings.home).active["claude-code"], "c2");
    // A bound connection takes over the folder another connection's setup left.
    await run("c1", "desk");
    const takeover = await run("c3", "desk");
    assert.match(read(path.join(dir, "SKILL.md")), /connection: "c3"/); assert.deepEqual(takeover.removedSkills, []);
    // Moving the skill elsewhere removes the copy in the agent's folder; a later unbound connection removes the moved one.
    const relocated = await run("c3", "desk", {}, { skillDir: moved });
    assert.deepEqual(relocated.removedSkills, [dir]); assert.match(read(path.join(moved, "SKILL.md")), /connection: "c3"/);
    fs.mkdirSync(dir, { recursive: true });
    const own = "---\nname: agentrelay\ndescription: mine\n---\n";
    fs.writeFileSync(path.join(dir, "SKILL.md"), own);
    assert.deepEqual((await run("c4", null)).removedSkills, [moved]);
    assert.equal(read(path.join(dir, "SKILL.md")), own);
  } finally { f.close(); }
});

test("paths that differ only in letter case are one folder on Windows", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, "Skills", "agentrelay"), variant = path.join(f.root, "SKILLS", "AgentRelay");
    const run = skillDir => connect({ profile: "claude-code", url: endpoint, connection: "c1", device: "desk", transport: "bridge" }, secrets,
      { ...f.settings, fetchImpl: reply("c1", "desk"), skillDir });
    await run(dir);
    const again = await run(variant);
    assert.deepEqual(again.removedSkills, []); assert.ok(fs.existsSync(path.join(dir, "SKILL.md")), "the skill is not written and then removed");
  } finally { f.close(); }
});

test("a batch never removes a file it writes or removes twice", () => {
  assert.equal(samePath("C:/A/b", "c:/a/B", "win32"), true); assert.equal(samePath("/a/b", "/a/B", "linux"), false);
  const file = path.resolve("x", "SKILL.md");
  const kept = withoutConflicts([{ file, remove: true }, { file, text: "new" }, { file: path.resolve("y"), remove: true }, { file: path.resolve("y"), remove: true }]);
  assert.deepEqual(kept, [{ file, text: "new" }, { file: path.resolve("y"), remove: true }]);
});

test("DeepSeek Harness without the skill gets a placeholder that shadows Codex's copy", async () => {
  const f = fixture(), previous = process.env.DSH_HOME, dshHome = path.join(f.root, "dsh-home");
  process.env.DSH_HOME = dshHome;
  try {
    const dshDir = path.join(dshHome, "skills", "agentrelay"), codexDir = path.join(f.settings.userHome, ".agents", "skills", "agentrelay");
    await connect({ profile: "codex", url: endpoint, connection: "cx", device: "desk", transport: "bridge" }, { ...secrets, agentToken: `agentrelay_${"e".repeat(64)}` }, { ...f.settings, fetchImpl: reply("cx", "desk") });
    const run = deviceId => connect({ profile: "deepseek-harness", url: endpoint, connection: "ds" }, secrets, { ...f.settings, fetchImpl: reply("ds", deviceId) });
    const unbound = await run(null);
    assert.equal(unbound.placeholderDir, dshDir); assert.deepEqual(inspectSkill(dshDir), { owner: "ds", version: CLIENT_VERSION, placeholder: true });
    assert.equal(fs.existsSync(path.join(dshDir, "references")), false);
    assert.match(read(path.join(dshDir, "SKILL.md")), /^name: agentrelay$/m);
    assert.ok(setupSummary(unbound).includes("Placeholder:"));
    // Binding replaces the placeholder with the skill; unbinding puts the placeholder back and drops the references.
    await run("desk");
    assert.equal(inspectSkill(dshDir).placeholder, false); assert.ok(fs.existsSync(path.join(dshDir, "references", "handoff-content.md")));
    await run(null);
    assert.equal(inspectSkill(dshDir).placeholder, true); assert.equal(fs.existsSync(path.join(dshDir, "references", "handoff-content.md")), false);
    assert.equal(inspectSkill(codexDir).owner, "cx", "Codex's skill is left alone");
  } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; f.close(); }
});

test("a failed write restores the skill files removed before it", () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, "skill"), other = path.join(f.root, "rule.md");
    applyFileChanges(planSkill({ skillDir: dir, launcher, connection: "c", version: "1.0.0" }));
    const original = read(path.join(dir, "SKILL.md")), removal = planSkillRemoval({ skillDirs: [dir, dir], connection: "c" });
    assert.equal(removal.length, SKILL_FILES.length, "a folder named twice is removed once");
    assert.deepEqual(planSkillRemoval({ skillDirs: [dir], connection: "someone-else" }), []);
    assert.throws(() => applyFileChanges([...removal, { file: other, text: "new" }], { write: () => { throw new Error("disk full"); } }), /rolled back/);
    assert.equal(read(path.join(dir, "SKILL.md")), original);
    assert.ok(fs.existsSync(path.join(dir, "references", "handoff-receipt.md")));
  } finally { f.close(); }
});

test("a skill the user wrote stops connect before any write", async () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, "custom-skill"); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: agentrelay\ndescription: mine\n---\n");
    await assert.rejects(connect({ profile: "claude-code", url: endpoint, connection: "c1", device: "desk", transport: "bridge" }, secrets,
      { ...f.settings, fetchImpl: reply("c1", "desk"), skillDir: dir }), /restored|did not install/);
    assert.equal(read(path.join(dir, "SKILL.md")), "---\nname: agentrelay\ndescription: mine\n---\n");
    assert.equal(fs.existsSync(path.join(f.settings.userHome, ".claude.json")), false);
    assert.equal(Object.keys(readManifest(f.settings.home).connections).length, 0);
  } finally { f.close(); }
});

test("a failed skill write rolls back the config and rule written before it", () => {
  const f = fixture();
  try {
    const config = path.join(f.root, "config.json"), rule = path.join(f.root, "CLAUDE.md"), dir = path.join(f.root, "skill");
    fs.writeFileSync(config, "{}\n"); fs.writeFileSync(rule, "Mine\n");
    const changes = [{ file: config, text: "{\"new\":1}\n" }, { file: rule, text: "Mine\nnew\n" },
      ...planSkill({ skillDir: dir, launcher, connection: "c", version: "1.0.0" })];
    const last = changes.at(-1).file;
    assert.throws(() => applyFileChanges(changes, { write: (file, text) => { if (file.startsWith(last + ".")) throw new Error("disk full"); fs.writeFileSync(file, text); } }), /rolled back/);
    assert.equal(read(config), "{}\n"); assert.equal(read(rule), "Mine\n"); assert.equal(fs.existsSync(path.join(dir, "SKILL.md")), false);
  } finally { f.close(); }
});

test("an update re-renders installed skills folder by folder and leaves deleted, adopted or claimed ones alone", () => {
  const f = fixture();
  try {
    const dirs = ["kept", "deleted", "adopted", "claimed", "placeholder"].map(name => path.join(f.root, name));
    const records = dirs.map((skillDir, i) => ({ id: `c${i}`, skillDir }));
    // The fourth folder has since been taken over by another connection's setup; the last holds a placeholder.
    for (const [i, dir] of dirs.entries()) applyFileChanges(withoutConflicts(planSkill({ skillDir: dir, launcher, connection: i === 3 ? "other" : `c${i}`, version: "0.0.1", placeholder: i === 4 })));
    fs.rmSync(dirs[1], { recursive: true });
    fs.writeFileSync(path.join(dirs[2], "SKILL.md"), read(path.join(dirs[2], "SKILL.md")).replace(SKILL_MARKER, "owner: me"));
    fs.rmSync(path.join(dirs[0], "references"), { recursive: true });
    const launcherPath = path.join(f.settings.home, "client", "agentrelay.mjs");
    assert.deepEqual(refreshSkills({ records: [...records, { id: "legacy" }], launcher: launcherPath, version: "9.9.9", root: projectRoot }), { refreshed: [dirs[0], dirs[4]], failed: [] });
    assert.match(read(path.join(dirs[0], "SKILL.md")), /client-version: "9\.9\.9"/);
    assert.ok(read(path.join(dirs[0], "SKILL.md")).includes(`node "${launcherPath}"`));
    assert.ok(fs.existsSync(path.join(dirs[0], "references", "handoff-receipt.md")));
    assert.deepEqual(inspectSkill(dirs[4]), { owner: "c4", version: "9.9.9", placeholder: true });
    assert.equal(fs.existsSync(dirs[1]), false); assert.match(read(path.join(dirs[2], "SKILL.md")), /client-version: "0\.0\.1"/);
    assert.match(read(path.join(dirs[3], "SKILL.md")), /client-version: "0\.0\.1"/);
    // A client version that ships no template changes nothing.
    assert.deepEqual(refreshSkills({ records, launcher: launcherPath, version: "0.1.0", root: path.join(f.root, "old-version") }), { refreshed: [], failed: [] });
    // A folder that cannot be written is reported, and the others still refresh.
    fs.rmSync(dirs[4], { recursive: true }); fs.writeFileSync(path.join(f.root, "blocked"), "");
    const blocked = { id: "c9", skillDir: path.join(f.root, "blocked-skill") };
    applyFileChanges(planSkill({ skillDir: blocked.skillDir, launcher, connection: "c9", version: "0.0.1" }));
    fs.rmSync(path.join(blocked.skillDir, "references"), { recursive: true }); fs.writeFileSync(path.join(blocked.skillDir, "references"), "a file where a folder belongs");
    assert.deepEqual(refreshSkills({ records: [blocked, records[0]], launcher: launcherPath, version: "9.9.10", root: projectRoot }), { refreshed: [dirs[0]], failed: [blocked.skillDir] });
    assert.match(read(path.join(blocked.skillDir, "SKILL.md")), /client-version: "0\.0\.1"/, "a failed folder keeps its previous files");
  } finally { f.close(); }
});

// The `skill` command reaches the installed client's stable launcher, which the fixtures above replace with a path.
function installedFixture() {
  const f = fixture(), launcherPath = path.join(f.settings.home, "client", "agentrelay.mjs");
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true }); fs.writeFileSync(launcherPath, "");
  const settings = { ...f.settings, launcher: launcherPath };
  const link = (id, deviceId, extra = {}) => connect({ profile: "claude-code", url: endpoint, connection: id, transport: "bridge", ...extra }, secrets, { ...settings, fetchImpl: reply(id, deviceId) });
  // Pass `install: true` to let setupSkill install this checkout's client, as it does outside tests.
  const skill = (id, deviceId, extra = {}, { install = false } = {}) => setupSkill({ connection: id, ...extra },
    { home: settings.home, userHome: settings.userHome, store: settings.store, fetchImpl: reply(id, deviceId), ...install ? {} : { launcher: launcherPath } });
  const dir = path.join(settings.userHome, ".claude", "skills", "agentrelay"), rule = path.join(settings.userHome, ".claude", "CLAUDE.md");
  return { ...f, settings, link, skill, dir, rule };
}

test("the skill command installs the skill for a saved connection without asking for its token", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk", { "no-skill": true });
    assert.equal(fs.existsSync(f.dir), false);
    // A connection saved before the skill existed has no rule file, language or skill choice on record.
    const manifest = readManifest(f.settings.home);
    for (const key of ["ruleFile", "lang", "noSkill", "skillDir"]) delete manifest.connections.c1[key];
    saveManifest(manifest, f.settings.home);
    fs.writeFileSync(path.join(f.settings.userHome, ".claude.json"), "{\"kept\":true}\n");
    const result = await f.skill("c1", "desk");
    assert.equal(result.skillDir, f.dir); assert.equal(result.skillReason, null);
    assert.match(read(path.join(f.dir, "SKILL.md")), /connection: "c1"/);
    assert.ok(read(f.rule).includes("`agentrelay` skill"));
    assert.equal(read(path.join(f.settings.userHome, ".claude.json")), "{\"kept\":true}\n", "the MCP config is not touched");
    const saved = readManifest(f.settings.home).connections.c1;
    assert.equal(saved.skillDir, f.dir); assert.equal(saved.ruleFile, f.rule); assert.equal(saved.noSkill, false); assert.equal(saved.lang, "en");
  } finally { f.close(); }
});

test("the skill command follows the Site: unbound removes the skill, bound again restores it, --remove opts out", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk", { lang: "zh" });
    const unbound = await f.skill("c1", null);
    assert.equal(unbound.skillReason, "unbound"); assert.deepEqual(unbound.removedSkills, [f.dir]);
    assert.equal(fs.existsSync(f.dir), false);
    assert.equal(readManifest(f.settings.home).connections.c1.deviceId, null);
    assert.match(read(f.rule), /跨设备提示词交接/, "the saved language is kept");
    assert.ok(!read(f.rule).includes("self"), "an unbound rule never says self");
    assert.equal((await f.skill("c1", "desk")).skillDir, f.dir);
    const removed = await f.skill("c1", "desk", { remove: true });
    assert.equal(removed.skillReason, "opted-out"); assert.equal(fs.existsSync(f.dir), false);
    assert.equal(readManifest(f.settings.home).connections.c1.noSkill, true);
    await assert.rejects(f.skill("missing", "desk"), /Unknown local connection/);
  } finally { f.close(); }
});

test("the skill command installs this checkout's client first, so the skill never calls an older one", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk");
    // The device last installed an older client; the checkout is newer.
    fs.mkdirSync(path.join(f.settings.home, "client", "versions", "0.2.1"), { recursive: true });
    fs.writeFileSync(path.join(f.settings.home, "client", "current.json"), JSON.stringify({ version: "0.2.1", previous: null }));
    const result = await f.skill("c1", "desk", {}, { install: true });
    assert.deepEqual(result.client, { version: CLIENT_VERSION, replaced: "0.2.1" });
    assert.equal(JSON.parse(read(path.join(f.settings.home, "client", "current.json"))).version, CLIENT_VERSION);
    assert.equal(inspectSkill(f.dir).version, CLIENT_VERSION);
    assert.ok(setupSummary(result).includes(`Client:        updated from 0.2.1 to ${CLIENT_VERSION}`));
  } finally { f.close(); }
});

test("an agent config names a connection only through --connection, never through a path that contains its id", () => {
  // Temporary and install folders can contain any short id, as "agentrelay-skill-xc1q" contains c1.
  const launcher = "/tmp/agentrelay-skill-xc1q/client/agentrelay.mjs", node = "/opt/c1/node";
  const configs = [
    JSON.stringify(connectionConfig({ profile: "claude-code", endpoint: "https://example.test/api/agent/mcp", id: "c2", launcher, node })),
    JSON.stringify(connectionConfig({ profile: "claude-code", endpoint: "https://example.test/api/agent/mcp", id: "c2", launcher, node, transport: "direct", platform: "win32" })),
    connectionConfig({ profile: "codex", endpoint: "https://example.test/api/agent/mcp", id: "c2", launcher, node }),
    connectionConfig({ profile: "codex", endpoint: "https://example.test/api/agent/mcp", id: "c2", launcher, node, transport: "direct", platform: "linux" }),
    connectionConfig({ profile: "deepseek-harness", endpoint: "https://example.test/api/agent/mcp", id: "c2", launcher, node }),
    helperCommand(node, launcher, "c2", "win32"),
  ];
  for (const text of configs) {
    assert.ok(namesConnection(text, "c2"), text);
    assert.equal(namesConnection(text, "c1"), false, text);
  }
  assert.equal(namesConnection(JSON.stringify({ args: ["--connection", "c20"] }), "c2"), false);
});

test("the skill command acts only on the agent's active connection", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk"); await f.link("c2", "desk");
    await assert.rejects(f.skill("c1", "desk"), /uses connection c2, not c1/);
    // A manifest saved before the active connection was recorded: the agent's config names the one it starts.
    const manifest = readManifest(f.settings.home); delete manifest.active; saveManifest(manifest, f.settings.home);
    await assert.rejects(f.skill("c1", "desk"), /uses connection c2/);
    assert.equal((await f.skill("c2", "desk")).skillDir, f.dir);
  } finally { f.close(); }
});

test("an older record without a rule file uses the default only when connect wrote its rule there, in its language", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk", { "no-skill": true, lang: "zh" });
    const forget = () => { const manifest = readManifest(f.settings.home); for (const key of ["ruleFile", "lang"]) delete manifest.connections.c1[key]; saveManifest(manifest, f.settings.home); };
    forget();
    assert.equal((await f.skill("c1", "desk")).skillDir, f.dir);
    assert.match(read(f.rule), /跨设备提示词交接/, "the language is read from the existing rule");
    forget(); fs.writeFileSync(f.rule, "My own instructions\n");
    await assert.rejects(f.skill("c1", "desk"), /Pass --rule-file/);
    assert.equal((await f.skill("c1", "desk", { "rule-file": "~/.claude/OTHER.md" })).ruleFile, path.join(f.settings.userHome, ".claude", "OTHER.md"), "~ means the home folder");
  } finally { f.close(); }
});

test("rolling back to a client without the skill removes it and writes the full rule", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk");
    assert.deepEqual(retireSkills({ home: f.settings.home, userHome: f.settings.userHome }), { retired: [f.dir], failed: [] });
    assert.equal(fs.existsSync(f.dir), false); assert.match(read(f.rule), /upload --connection c1/);
    assert.equal(readManifest(f.settings.home).connections.c1.skillDir, null);
  } finally { f.close(); }
});

test("verify reports whether the skill matches what the Site says", async () => {
  const f = installedFixture();
  try {
    await f.link("c1", "desk");
    const launcherPath = f.settings.launcher, manifest = () => readManifest(f.settings.home);
    const status = (deviceId, id = "c1", installedVersion = CLIENT_VERSION) => skillStatus({ manifest: manifest(), record: manifest().connections[id], deviceId, launcher: launcherPath, installedVersion, userHome: f.settings.userHome });
    assert.deepEqual(status("desk"), { state: "installed", dir: f.dir, version: CLIENT_VERSION });
    const stale = status(null);
    assert.equal(stale.state, "stale"); assert.equal(stale.fix, `node "${launcherPath}" skill --connection c1`);
    const outdated = status("desk", "c1", "9.9.9");
    assert.equal(outdated.state, "outdated"); assert.ok(outdated.fix);
    await f.skill("c1", "desk", { remove: true });
    assert.deepEqual(status("desk"), { state: "opted-out" });
    assert.deepEqual(status(null), { state: "not-bound" });
    const saved = manifest(); saved.connections.c1.noSkill = false; saveManifest(saved, f.settings.home);
    assert.equal(status("desk").state, "missing"); assert.ok(status("desk").fix);
    // Another connection of the same agent: no fix that would take the folder from the active one.
    await f.link("c2", "desk");
    assert.deepEqual(status("desk", "c1"), { state: "inactive", activeConnection: "c2" });
  } finally { f.close(); }
});

test("the setup summary names the files, how to invoke the skill and what to do next, with no credential", async () => {
  const f = installedFixture();
  try {
    const bound = setupSummary(await f.link("c1", "desk"));
    for (const text of ["Configured Claude Code for connection c1 (device desk).", f.dir, f.rule, "short rule", "run /agentrelay", "restart or reconnect Claude Code"])
      assert.ok(bound.includes(text), text);
    assert.ok(!bound.includes(secrets.agentToken) && !bound.includes(secrets.gatewayToken));
    const unbound = setupSummary(await f.link("c1", null));
    assert.ok(unbound.includes("not bound to a device") && unbound.includes("skill --connection c1") && unbound.includes(`Removed:       the earlier skill in ${f.dir}`));
    const codex = await connect({ profile: "codex", url: endpoint, connection: "c2", device: "desk", transport: "bridge" }, { ...secrets, agentToken: `agentrelay_${"d".repeat(64)}` },
      { ...f.settings, fetchImpl: reply("c2", "desk") });
    assert.ok(setupSummary(codex).includes("run $agentrelay"));
    assert.ok(setupSummary(await f.skill("c1", "desk"), { title: "Updated the instructions of" }).startsWith("Updated the instructions of Claude Code"));
  } finally { f.close(); }
});

test("an update rewrites the rule next to each re-rendered skill, so it names the agent profile the skill asks for", async () => {
  const f = fixture();
  try {
    await connect({ profile: "codex", url: endpoint, connection: "c1", device: "desk", transport: "bridge" }, secrets, { ...f.settings, fetchImpl: reply("c1", "desk") });
    const ruleFile = path.join(f.settings.userHome, ".codex", "AGENTS.md"), skillDir = path.join(f.settings.userHome, ".agents", "skills", "agentrelay");
    // A rule written by an earlier client: the same block without the profile line.
    fs.writeFileSync(ruleFile, read(ruleFile).replace(/^Your AgentRelay agent profile:.*\r?\n/m, ""));
    assert.ok(!read(ruleFile).includes("--agent codex"));
    const result = refreshRules({ skillDirs: [skillDir], version: CLIENT_VERSION, root: projectRoot, launcher: f.settings.launcher, home: f.settings.home, userHome: f.settings.userHome });
    assert.deepEqual(result, { updated: [ruleFile], failed: [] });
    assert.ok(read(ruleFile).includes("`--agent codex`"));
    // A folder that was not re-rendered leaves its rule alone.
    assert.deepEqual(refreshRules({ skillDirs: [], version: CLIENT_VERSION, root: projectRoot, launcher: f.settings.launcher, home: f.settings.home, userHome: f.settings.userHome }), { updated: [], failed: [] });
  } finally { f.close(); }
});
