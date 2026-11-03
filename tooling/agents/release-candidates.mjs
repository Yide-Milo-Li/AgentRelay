// Produce reviewable local artifacts only. This module never creates a remote repository, Release or Site.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../environment/project-root.mjs";
import { copyClient, CLIENT_VERSION } from "./client-install.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ROOT_FILES = ["README.md", "README.zh-CN.md", "PRODUCT.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "package.json", "package-lock.json", ".gitignore", ".npmrc", ".gitattributes", ".node-version",
  "components.json", "tsconfig.json", "cloudflare-env.d.ts", "next.config.ts", "vite.config.ts", "eslint.config.mjs", "postcss.config.mjs", "drizzle.config.ts"];
const DIRECTORIES = [".github", "src", "worker", "drizzle", "public", "scripts", "tooling", "tests", "vendor", "examples", "docs/guides", "docs/reference", "docs/images", "docs/architecture", "docs/operations"];
// The maintainer's release procedure describes the private repository; it stays there.
const EXCLUDED = new Set(["docs/operations/open-source-release.md"]);
const BINARY_EXTENSIONS = ["node", "png", "jpg", "jpeg", "webp", "woff", "woff2", "ico", "pdf", "zip"];
const BINARY_FILE = new RegExp(`\\.(?:${BINARY_EXTENSIONS.join("|")})$`, "i");
export function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Release input contains a symlink. Review it before exporting.");
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function newTarget(target) {
  const root = path.resolve(projectRoot), output = path.resolve(target);
  if (!output.startsWith(root + path.sep + "outputs" + path.sep) || existsSync(output)) throw new Error("Choose a new folder under outputs/ for release candidates.");
  mkdirSync(output, { recursive: true }); return output;
}
const gitConfig = (key, root = projectRoot) => spawnSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8", windowsHide: true }).stdout?.trim() ?? "";
/** The private checkout's origin and committer identity, which must not reach a candidate. */
export function privateMarkers(root = projectRoot) {
  return [originPath(root), gitConfig("user.name", root), gitConfig("user.email", root)].filter(marker => marker.length >= 4);
}
/** `owner/repository` of the origin remote, whether it is an https or an ssh address. */
function originPath(root = projectRoot) {
  return repositoryPath(gitConfig("remote.origin.url", root));
}
const repositoryPath = url => url.replace(/\.git$/, "").replace(/^(?:[a-z+]+:\/\/|git@)[^/:]+[/:]/i, "");
/** Turn links to files the candidate does not contain (plans, QA evidence) into plain text, so no exported doc points nowhere. */
export function unlinkMissing(markdown, exists) {
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (link, text, target) =>
    /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target) || exists(decodeURI(target.split("#")[0])) ? link : text);
}
/** Automated gates catch common leaks; the candidate still needs human review before publication. */
export function auditFiles(root, markers = privateMarkers(), { licenseCopyright } = {}) {
  const files = walk(root), findings = [];
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (/(^|\/)(\.git|\.local|\.env[^/]*|\.dev\.vars[^/]*|connections\.json|\.wrangler|outputs|scratch)(\/|$)/.test(relative)) findings.push(`${relative}: private runtime path`);
    if (BINARY_FILE.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/agentrelay_[a-f0-9]{64}|(?:ghp|github_pat)_[A-Za-z0-9_]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push(`${relative}: credential-shaped value`);
    const deployedUrls = text.match(/https:\/\/[a-z0-9.-]+\.chatgpt\.site/gi) ?? [];
    if (/appgprj_[0-9a-f]{8,}/.test(text) || deployedUrls.some(url => !new URL(url).hostname.split(".").includes("example"))) findings.push(`${relative}: private Site identity`);
    // A standalone deployment's Worker host and Access team domain name the maintainer's Cloudflare account, as a Site
    // URL names the Site: only synthetic ones, with an `example` or `test` label, may be exported.
    const cloudflareHosts = [...text.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.(?:workers\.dev|cloudflareaccess\.com)\b/gi)].map(match => match[1].toLowerCase());
    if (cloudflareHosts.some(name => !name.split(/[.-]/).some(label => label === "example" || label === "test"))) findings.push(`${relative}: private Cloudflare identity`);
    // A reviewed copyright notice is public attribution. Exempt only that exact LICENSE line from identity matching;
    // credential and Site checks above still inspect every byte, and every other occurrence remains a finding.
    const identityText = relative === "LICENSE" && licenseCopyright
      ? text.split(/\r?\n/).filter(line => line !== licenseCopyright).join("\n") : text;
    const lower = identityText.toLowerCase();
    if (markers.some(marker => lower.includes(marker.toLowerCase()))) findings.push(`${relative}: private repository or committer identity`);
  }
  if (findings.length) throw new Error(`Candidate audit failed:\n${findings.join("\n")}`);
  return files.map(file => ({ file: path.relative(root, file).replaceAll("\\", "/"), sha256: hash(readFileSync(file)) }));
}
/** Make the inventory describe the same bytes in Git and in Windows or Unix checkouts. */
function canonicalizeSource(output) {
  const attributes = path.join(output, ".gitattributes");
  const existing = existsSync(attributes) ? readFileSync(attributes, "utf8") : "";
  const binaryRules = BINARY_EXTENSIONS.map(extension => `*.${extension} binary`).join("\n");
  writeFileSync(attributes, `# Keep the source inventory stable across Git checkouts.\n* text=auto eol=lf\n${existing}\n${binaryRules}\n`);
  for (const file of walk(output)) {
    if (BINARY_FILE.test(file)) {
      if (path.extname(file) !== path.extname(file).toLowerCase()) throw new Error("Review uppercase binary extensions before export.");
      continue;
    }
    const bytes = readFileSync(file);
    if (bytes.includes(0) || !isUtf8(bytes)) throw new Error(`Review unknown binary or non-UTF-8 release input: ${path.relative(output, file)}`);
    const text = bytes.toString("utf8");
    if (/\r(?!\n)/.test(text)) throw new Error(`Review a bare carriage return before export: ${path.relative(output, file)}`);
    writeFileSync(file, text.replaceAll("\r\n", "\n"));
  }
}
/** sourceRoot permits isolated source fixtures; destination containment and privacy gates remain mandatory. */
export function exportSource(target, { sourceRoot = projectRoot } = {}) {
  const output = newTarget(target), source = path.resolve(sourceRoot);
  const files = [...ROOT_FILES.filter(file => existsSync(path.join(source, file))),
    ...DIRECTORIES.flatMap(dir => existsSync(path.join(source, dir)) ? walk(path.join(source, dir)).map(file => path.relative(source, file)) : []), "design/DESIGN.md"]
    .filter(file => !EXCLUDED.has(file.replaceAll("\\", "/")));
  for (const file of files) {
    if (lstatSync(path.join(source, file)).isSymbolicLink()) throw new Error("Review release symlinks first.");
    mkdirSync(path.dirname(path.join(output, file)), { recursive: true }); cpSync(path.join(source, file), path.join(output, file));
  }
  const manifest = JSON.parse(readFileSync(path.join(source, ".openai/hosting.json"), "utf8"));
  delete manifest.project_id;
  mkdirSync(path.join(output, ".openai")); writeFileSync(path.join(output, ".openai/hosting.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The private checkout's device preamble and repository retention policy do not belong in the public template.
  const agents = readFileSync(path.join(source, "AGENTS.md"), "utf8").replace(/<!--[\s\S]*?agentrelay:device-rule:end -->\s*/, "")
    .replace(/### Private repository and future open-source release[\s\S]*?\n---/, "### Template deployment identity\n\nEach owner deploys their own copy: a new private Site, or a standalone Cloudflare Worker set up with `npm run deploy:cloudflare -- --init`. Keep the returned Site identity, or the deployment config in the ignored `.local/` directory, to target the same deployment on every upgrade. Never commit credentials, personal runtime data or another owner's Site or Cloudflare configuration.\n\n---")
    .replace(/^- Keep untracked personal plans[^\n]*\n/m, "- Keep personal notes and drafts in the ignored `.local/` directory and never commit them.\n")
    .replace("and re-render with the `archify` skill:", "and re-render with the `archify` skill (without it, update the JSON and say so in the pull request):");
  writeFileSync(path.join(output, "AGENTS.md"), agents);
  // The diagram records where it was rendered; a new repository re-renders it against its own URL and first commit.
  const diagram = JSON.parse(readFileSync(path.join(output, "docs/architecture/agentrelay-system-overview.architecture.json"), "utf8"));
  // A renamed private repository can leave the diagram pinned to its earlier URL; sanitize both provenances.
  const origins = new Set([originPath(source), repositoryPath(diagram.meta.repository.url)].filter(Boolean));
  for (const file of walk(path.join(output, "docs/architecture"))) {
    if (/\.(?:html|json)$/.test(file)) {
      let text = readFileSync(file, "utf8");
      for (const origin of origins) text = text.replaceAll(origin, "OWNER/REPOSITORY");
      writeFileSync(file, text);
    }
  }
  const ignore = path.join(output, ".gitignore");
  writeFileSync(ignore, readFileSync(ignore, "utf8").replace(/^\/?AGENTS\.md\r?\n/gm, ""));
  // The repository notes live in the development guide; older layouts kept them in the README.
  const notes = {
    "README.md": "> Note: `AGENTS.md` is tracked contributor guidance in this template. Current architecture, security invariants and operational procedures are maintained in this `README.md`; repository organization and file placement rules are maintained in `AGENTS.md`.",
    "docs/guides/development.md": "> Note: `AGENTS.md` is tracked contributor guidance in this template. The [README](../../README.md) is the entry point. Architecture, security invariants and operational procedures are maintained in `docs/`: this guide, the [security invariants](../reference/security-invariants.md) and the other [reference documents](../reference/). Repository organization and file placement rules are maintained in `AGENTS.md`.",
  };
  for (const [name, note] of Object.entries(notes)) {
    const file = path.join(output, name);
    if (!existsSync(file)) continue;
    writeFileSync(file, readFileSync(file, "utf8")
      .replace(/^> Note: `AGENTS\.md` is a local workspace instruction file.*$/m, note)
      .replace(/^- \*\*Sites Project ID\*\*:.*$/m, "- **Sites Project ID**: This template has no Site identity. Register your own private Site on first deployment, retain its returned project_id locally, and target that same Site for every upgrade.")
      .replace(/^- \*\*Future Open-Source Release\*\*:.*$/m, "- **Template source**: This source export has no private repository history. Keep your deployment identity and runtime data out of contributions."));
  }
  for (const file of walk(output).filter(file => file.endsWith(".md")))
    writeFileSync(file, unlinkMissing(readFileSync(file, "utf8"), target => existsSync(path.join(path.dirname(file), target))));
  canonicalizeSource(output);
  const licenseCopyright = readFileSync(path.join(source, "LICENSE"), "utf8").match(/^Copyright \(c\) \d{4}(?:-\d{4})? [^\r\n]+$/m)?.[0];
  const inventory = auditFiles(output, privateMarkers(source), { licenseCopyright });
  writeFileSync(path.join(output, "SOURCE-MANIFEST.json"), JSON.stringify({ version: CLIENT_VERSION, contentSha256: hash(JSON.stringify(inventory)), files: inventory }, null, 2) + "\n");
  return { directory: output, files: inventory.length, contentSha256: hash(JSON.stringify(inventory)), history: "No .git directory exported. Initialize a new repository after reviewing the files." };
}
export function packageClient(target) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This candidate packager currently verifies Windows x64 only.");
  const output = newTarget(target), folder = path.join(output, "agentrelay-client");
  copyClient(projectRoot, folder);
  writeFileSync(path.join(folder, "README.md"), `# AgentRelay client ${CLIENT_VERSION}\n\nRequires Node.js >=22.13 on Windows x64. No Git or frontend dependencies required.\n\nRun \`node scripts/agents/agentrelay.mjs install\` from this folder, then use the printed launcher with the connect command from your own Site.\n\nDefault storage: Windows Credential Manager. Each Agent has a separate credential; the Site gateway is shared. Configuration contains only paths and connection ids.\n\nRollback: \`node <printed-launcher> rollback\`. Existing versions are retained. Reconnect/restart your Agent afterwards.\n\nThe OS store is not an isolation boundary between programs running as the same system user. A permanent credential remains usable until revoked; revoke lost-device credentials in your Site.\n\nThis is a local candidate, not a published Release.\n`);
  const inventory = auditFiles(folder);
  writeFileSync(path.join(folder, "PROVENANCE.json"), JSON.stringify({ version: CLIENT_VERSION, platform: "win32-x64", node: ">=22.13.0", keyring: "2.1.2", contentSha256: hash(JSON.stringify(inventory)), files: inventory }, null, 2) + "\n");
  const archive = path.join(output, `agentrelay-client-${CLIENT_VERSION}-windows-x64.zip`);
  const zipped = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:AGENTRELAY_PACKAGE_SOURCE, $env:AGENTRELAY_PACKAGE_ZIP)"], { env: { ...process.env, AGENTRELAY_PACKAGE_SOURCE: folder, AGENTRELAY_PACKAGE_ZIP: archive }, windowsHide: true, encoding: "utf8" });
  if (zipped.status !== 0) throw new Error("Client archive creation failed.");
  const sha256 = hash(readFileSync(archive)); writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  return { archive, sha256, files: inventory.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target] = process.argv.slice(2);
  if (!target || !["source", "client"].includes(command)) throw new Error("Usage: release-candidates.mjs source|client <new-output-directory>");
  console.log(JSON.stringify(command === "source" ? exportSource(target) : packageClient(target), null, 2));
}
