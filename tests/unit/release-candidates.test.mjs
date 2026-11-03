import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditFiles, exportSource, unlinkMissing, walk } from "../../tooling/agents/release-candidates.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

// Synthetic markers stand in for the checkout's origin and committer identity.
const MARKERS = ["private-owner/private-repo", "Private Person", "private@example.com"];

function audit(files, options) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentrelay-candidate-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
    return auditFiles(root, MARKERS, options);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("synthetic and placeholder Cloudflare hosts pass the audit; a real Worker host or Access team does not", () => {
  const inventory = audit({ "guide.md": "Open https://agentrelay.<subdomain>.workers.dev, https://agentrelay.example.workers.dev or https://<team>.cloudflareaccess.com;"
    + " tests use https://example-team.cloudflareaccess.com and https://agentrelay-test.cloudflareaccess.com." });
  assert.deepEqual(inventory.map(entry => entry.file), ["guide.md"]);
  assert.throws(() => audit({ "worker.md": `https://agentrelay.someone${".workers.dev"}` }), /worker.md: private Cloudflare identity/);
  assert.throws(() => audit({ "access.json": `{"iss":"https://real-team${".cloudflareaccess.com"}"}` }), /access.json: private Cloudflare identity/);
});

test("documentation placeholders for a Site address pass the candidate audit", () => {
  const inventory = audit({ "guide.md": "Use https://<your-site>.chatgpt.site or https://my-site.example.chatgpt.site/ here." });
  assert.deepEqual(inventory.map(entry => entry.file), ["guide.md"]);
});

test("a real Site address, the private origin and the committer identity fail the candidate audit", () => {
  assert.throws(() => audit({ "site.md": `https://relay-42${".chatgpt.site"}` }), /site\.md: private Site identity/);
  assert.throws(() => audit({ "diagram.json": '{"url":"https://GitHub.com/Private-Owner/private-repo.git"}' }), /diagram\.json: private repository or committer identity/);
  assert.throws(() => audit({ "diagram.html": '{"label":"private-owner/private-repo"}' }), /diagram\.html: private repository or committer identity/);
  assert.throws(() => audit({ "design.md": "Revoked by private person" }), /design\.md: private repository or committer identity/);
  assert.throws(() => audit({ "notes.md": "Contact private@example.com" }), /notes\.md: private repository or committer identity/);
});

test("a reviewed LICENSE copyright notice does not exempt other identity or credential occurrences", () => {
  const licenseCopyright = "Copyright (c) 2026 Private Person", options = { licenseCopyright };
  assert.equal(audit({ LICENSE: `${licenseCopyright}\nMIT License\n` }, options).length, 1);
  assert.throws(() => audit({ LICENSE: `${licenseCopyright}\nprivate@example.com` }, options), /private repository or committer identity/);
  assert.throws(() => audit({ LICENSE: licenseCopyright, "guide.md": "Private Person" }, options), /guide\.md: private repository or committer identity/);
  const credentialNotice = `Copyright (c) 2026 agentrelay_${"a".repeat(64)}`;
  assert.throws(() => audit({ LICENSE: credentialNotice }, { licenseCopyright: credentialNotice }), /credential-shaped value/);
  const siteNotice = `Copyright (c) 2026 https://relay-42${".chatgpt.site"}`;
  assert.throws(() => audit({ LICENSE: siteNotice }, { licenseCopyright: siteNotice }), /private Site identity/);
});

test("links to files the candidate leaves out become plain text; other links stay", () => {
  const exported = new Set(["docs/guides/setup.md"]);
  const markdown = "See the [plan](docs/plans/x.md#scope), the [guide](docs/guides/setup.md#a), [the web](https://example.com), [a section](#top) and ![logo](missing.png).";
  assert.equal(unlinkMissing(markdown, target => exported.has(target)),
    "See the plan, the [guide](docs/guides/setup.md#a), [the web](https://example.com), [a section](#top) and ![logo](missing.png).");
  assert.equal(unlinkMissing("[notes](QA%20notes.md)", target => target === "QA notes.md"), "[notes](QA%20notes.md)");
});

test("source candidates retain community files and CI without private plans or deployment identity", () => {
  mkdirSync(path.join(projectRoot, "outputs"), { recursive: true });
  const root = mkdtempSync(path.join(projectRoot, "outputs/release-test-"));
  try {
    // Use a complete synthetic checkout: CI must not depend on the maintainer's untracked AGENTS.md or Git identity.
    const input = path.join(root, "input");
    const fixtureFiles = {
      "README.md": "# Source fixture\r\n\r\n> Note: `AGENTS.md` is a local workspace instruction file ignored by git.\r\n\r\n[Private plan](docs/plans/private.md)\r\n",
      "LICENSE": "MIT License\n\nCopyright (c) 2026 Fixture Maintainer\n",
      "SECURITY.md": "# Security policy fixture\n",
      "CONTRIBUTING.md": "# Contribution fixture\n",
      "AGENTS.md": "# Contributor rules\n\nRead README.md.\n",
      ".gitignore": "AGENTS.md\noutputs/\n.local/\n",
      ".openai/hosting.json": JSON.stringify({ project_id: "synthetic-private-site", d1: "DB", r2: "BUCKET", capabilities: ["mcp"] }),
      ".github/workflows/ci.yml": "name: Fixture CI\n",
      ".github/pull_request_template.md": "# Pull request fixture\n",
      ".github/ISSUE_TEMPLATE/bug_report.md": "# Bug fixture\n",
      ".github/ISSUE_TEMPLATE/feature_request.md": "# Feature fixture\n",
      "design/DESIGN.md": "# Design fixture\n",
      "docs/guides/development.md": "# Development fixture\n\n> Note: `AGENTS.md` is a local workspace instruction file ignored by git.\n\n- **Sites Project ID**: Fixture Maintainer private Site.\n- **Future Open-Source Release**: Fixture Maintainer private procedure.\n",
      "docs/architecture/agentrelay-system-overview.architecture.json": JSON.stringify({ meta: { repository: { url: "https://github.com/example/private-source.git" } } }),
      "docs/architecture/agentrelay-system-overview.html": "<p>example/private-source</p>",
      "docs/operations/open-source-release.md": "Fixture Maintainer private release procedure\n",
      "docs/plans/private.md": "Fixture Maintainer private plan\n",
      ".local/private.md": "Fixture Maintainer private note\n",
      "public/synthetic.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 13, 10, 0xff]),
    };
    for (const [file, text] of Object.entries(fixtureFiles)) {
      mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
      writeFileSync(path.join(input, file), text);
    }
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Fixture Maintainer"], ["config", "user.email", "fixture@example.invalid"], ["remote", "add", "origin", "https://github.com/example/renamed-source.git"]]) {
      const result = spawnSync("git", args, { cwd: input, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const output = path.join(root, "source");
    exportSource(output, { sourceRoot: input });
    for (const file of ["LICENSE", "SECURITY.md", "CONTRIBUTING.md", ".github/workflows/ci.yml", ".github/pull_request_template.md", ".github/ISSUE_TEMPLATE/bug_report.md", ".github/ISSUE_TEMPLATE/feature_request.md"])
      assert.ok(existsSync(path.join(output, file)), `${file} is missing from the source candidate`);
    assert.equal(existsSync(path.join(output, "docs/plans")), false);
    assert.equal(existsSync(path.join(output, ".local")), false);
    assert.equal(existsSync(path.join(output, ".git")), false);
    assert.match(readFileSync(path.join(output, "README.md"), "utf8"), /`AGENTS\.md` is tracked contributor guidance/);
    // The repository notes moved from the README to the development guide; both are rewritten for the template.
    const guide = readFileSync(path.join(output, "docs/guides/development.md"), "utf8");
    assert.match(guide, /`AGENTS\.md` is tracked contributor guidance/);
    assert.match(guide, /^- \*\*Sites Project ID\*\*: This template has no Site identity\./m);
    assert.match(guide, /^- \*\*Template source\*\*:/m);
    assert.doesNotMatch(readFileSync(path.join(output, ".gitignore"), "utf8"), /^\/?AGENTS\.md$/m);
    const diagram = JSON.parse(readFileSync(path.join(output, "docs/architecture/agentrelay-system-overview.architecture.json"), "utf8"));
    assert.match(diagram.meta.repository.url, /OWNER\/REPOSITORY/, "diagram provenance stays anonymous after a private remote rename");
    assert.doesNotMatch(readFileSync(path.join(output, "docs/architecture/agentrelay-system-overview.html"), "utf8"), /example\/private-source/);
    assert.equal(JSON.parse(readFileSync(path.join(output, ".openai/hosting.json"), "utf8")).project_id, undefined);
    assert.equal(walk(output).some(file => file.endsWith("open-source-release.md")), false);

    // Inventory hashes must describe committed and freshly cloned bytes on both Git line-ending settings.
    const git = (cwd, args) => {
      const result = spawnSync("git", args, { cwd, encoding: "buffer", windowsHide: true });
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    };
    git(output, ["init", "-q", "-b", "main"]);
    git(output, ["config", "core.autocrlf", "true"]);
    git(output, ["config", "user.name", "Fixture Maintainer"]);
    git(output, ["config", "user.email", "fixture@example.invalid"]);
    git(output, ["add", "-A"]);
    git(output, ["-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic source"]);
    const clone = path.join(root, "clone");
    git(root, ["-c", "core.autocrlf=true", "clone", "--quiet", "--no-hardlinks", output, clone]);
    const manifest = JSON.parse(readFileSync(path.join(output, "SOURCE-MANIFEST.json"), "utf8"));
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    for (const entry of manifest.files) {
      assert.equal(digest(readFileSync(path.join(output, entry.file))), entry.sha256, `${entry.file}: exported bytes`);
      assert.equal(digest(git(output, ["show", `HEAD:${entry.file}`])), entry.sha256, `${entry.file}: committed bytes`);
      assert.equal(digest(readFileSync(path.join(clone, entry.file))), entry.sha256, `${entry.file}: cloned bytes`);
    }
    assert.deepEqual(readFileSync(path.join(clone, "public/synthetic.png")), fixtureFiles["public/synthetic.png"]);
    writeFileSync(path.join(input, "public/unreviewed.dat"), Buffer.from([0xff, 0, 13, 10]));
    assert.throws(() => exportSource(path.join(root, "unreviewed"), { sourceRoot: input }), /unknown binary or non-UTF-8/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
