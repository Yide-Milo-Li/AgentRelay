import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

// Check the source that will be committed: this private repository may retain
// Site identity, while binding names must stay compatible with the Worker.
const staged = spawnSync("git", ["show", ":.openai/hosting.json"], { cwd: projectRoot, encoding: "utf8" });

test("tracked hosting manifest preserves bindings and optional private Site identity", { skip: staged.status !== 0 && "not a Git checkout" }, () => {
  const manifest = JSON.parse(staged.stdout);
  if (manifest.project_id !== undefined) {
    assert.equal(typeof manifest.project_id, "string");
    assert.ok(manifest.project_id.trim().length > 0, "A registered Site must retain its non-empty ID.");
  }
  assert.equal(manifest.d1, "DB");
  assert.equal(manifest.r2, "BUCKET", "Image attachments need the R2 binding named BUCKET.");
  assert.deepEqual(manifest.capabilities, ["mcp"]);
});

test("tracked documentation never carries a Site identity", () => {
  const files = spawnSync("git", ["ls-files", "README.md", "README.zh-CN.md", "PRODUCT.md", "docs"], { cwd: projectRoot, encoding: "utf8" });
  if (files.status !== 0) return;
  for (const file of files.stdout.split("\n").filter((name) => name.endsWith(".md"))) {
    const staged = spawnSync("git", ["show", `:${file}`], { cwd: projectRoot, encoding: "utf8" });
    assert.ok(!/appgprj_[0-9a-f]{8,}/.test(staged.stdout), `${file} contains a project_id`);
  }
});
