import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

function files(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file, base) : [{
      name: path.relative(base, file).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function generate(directory) {
  const cli = path.join(projectRoot, "node_modules/drizzle-kit/bin.cjs");
  const result = spawnSync(process.execPath, [cli, "generate", "--config", "drizzle.config.ts"], {
    cwd: directory, encoding: "utf8", timeout: 60_000, windowsHide: true,
  });
  assert.equal(result.error?.code, undefined, "migration generation must finish");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("patched migration loader preserves existing history and generates an additive migration", () => {
  const tempRoot = path.join(projectRoot, ".sites-runtime", "tmp");
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, "drizzle-upgrade-"));
  try {
    mkdirSync(path.join(root, "src/server/db"), { recursive: true });
    cpSync(path.join(projectRoot, "drizzle"), path.join(root, "drizzle"), { recursive: true });
    cpSync(path.join(projectRoot, "drizzle.config.ts"), path.join(root, "drizzle.config.ts"));
    cpSync(path.join(projectRoot, "src/server/db/schema.ts"), path.join(root, "src/server/db/schema.ts"));

    const before = files(path.join(root, "drizzle"));
    generate(root);
    assert.deepEqual(files(path.join(root, "drizzle")), before, "unchanged schema must leave every migration byte intact");

    appendFileSync(path.join(root, "src/server/db/schema.ts"), '\nexport const dependencyUpgradeProbe = sqliteTable("dependency_upgrade_probe", { id: text("id").primaryKey() });\n');
    generate(root);
    const after = files(path.join(root, "drizzle"));
    const previous = new Map(before.map(file => [file.name, file.sha256]));
    const current = new Map(after.map(file => [file.name, file.sha256]));
    for (const file of before.filter(file => file.name !== "meta/_journal.json")) {
      assert.equal(current.get(file.name), file.sha256, `${file.name} must remain present and unchanged`);
    }
    const addedSql = after.filter(file => file.name.endsWith(".sql") && !previous.has(file.name));
    assert.equal(addedSql.length, 1);
    const sql = readFileSync(path.join(root, "drizzle", addedSql[0].name), "utf8");
    assert.match(sql, /CREATE TABLE [`"\[]dependency_upgrade_probe/i);
    assert.doesNotMatch(sql, /\b(?:DROP|ALTER)\s+TABLE\b/i);
  } finally {
    // The only recursive deletion is the unique fixture created under this checkout.
    const relative = path.relative(tempRoot, root);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) rmSync(root, { recursive: true, force: true });
  }
});
