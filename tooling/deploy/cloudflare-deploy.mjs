// Build, configure, migrate and deploy a standalone Cloudflare deployment from its deployment config:
// 1. build with AGENTRELAY_TARGET=cloudflare; 2. write the deployment's names, IDs and vars into dist/server/wrangler.json;
// 3. apply pending migrations to the remote database through the ledger runner; 4. upload with the pinned Wrangler.
// Migrations run before the upload, as on Sites. They are additive, so the previous Worker keeps working meanwhile.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "../environment/project-root.mjs";
import { STORAGE_LIMIT_BYTES, deploymentWranglerConfig, generateWorkspaceKey, placeholderFindings, starterConfig, validateDeploymentConfig } from "./cloudflare-config.mjs";

const generatedConfig = path.join(projectRoot, "dist", "server", "wrangler.json");
const wrangler = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const preload = pathToFileURL(path.join(projectRoot, "scripts", "sites-env.mjs")).href;
const TUTORIAL = "docs/guides/cloudflare-deployment.md";

/** The config holds account-specific IDs: inside this checkout it must be a file Git ignores, such as `.local/`. */
function assertNotCommittable(file) {
  const relative = path.relative(projectRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: projectRoot, windowsHide: true });
  if (ignored.error) throw new Error(`Cannot ask Git whether ${relative} is ignored (${ignored.error.code ?? ignored.error.message}); keep the config outside the repository instead.`);
  if (ignored.status !== 0) throw new Error(`${relative} could be committed. Keep the deployment config in .local/ or outside the repository.`);
}

function runNode(label, args, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: "inherit", env: { ...process.env, ...env }, windowsHide: true });
  if (result.status !== 0) throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}.`);
}

/** Write a starter config with a new workspace key. Never overwrites: a second key would start an empty workspace. */
export function initDeploymentConfig(file) {
  assertNotCommittable(file);
  mkdirSync(path.dirname(file), { recursive: true });
  try { writeFileSync(file, `${JSON.stringify(starterConfig(), null, 2)}\n`, { flag: "wx" }); }
  catch (error) { throw new Error(error.code === "EEXIST" ? `${file} already exists; edit it instead.` : `Cannot write ${file}: ${error.code ?? error.message}.`); }
  return [`Created ${file} with a new workspace key.`, `Fill in d1.id (see ${TUTORIAL}), then run: npm run deploy:cloudflare -- --dry-run`,
    "The Access settings come after the first deployment, once Access is set up for the Worker's hostname."];
}

/** Read and check the config, so every mistake is reported before anything is built. */
export function loadDeploymentConfig(file) {
  if (!existsSync(file)) throw new Error(`${file} does not exist. Create it with: npm run deploy:cloudflare -- --init`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
  const { config, errors } = validateDeploymentConfig(raw);
  if (errors.length) throw new Error(`${file} needs changes:\n${errors.map(error => `  - ${error}`).join("\n")}`);
  return { raw, config };
}

export function deployCloudflare({ configFile, dryRun = false }, log = console.log) {
  const file = path.resolve(projectRoot, configFile);
  assertNotCommittable(file);
  const { raw, config } = loadDeploymentConfig(file);
  if (!config.workspaceKey) {
    config.workspaceKey = generateWorkspaceKey();
    // Saved before anything is deployed, so a failed first deployment retries with the same workspace.
    if (dryRun) log(`Dry run: a new workspace key would be saved to ${file}.`);
    else {
      writeFileSync(file, `${JSON.stringify({ ...raw, workspaceKey: config.workspaceKey }, null, 2)}\n`);
      log(`Saved a new workspace key to ${file}. Keep this file: the key identifies the workspace's data.`);
    }
  }

  runNode("The cloudflare build", ["scripts/run-framework.mjs", "build"], { AGENTRELAY_TARGET: "cloudflare" });
  const wranglerConfig = deploymentWranglerConfig(JSON.parse(readFileSync(generatedConfig, "utf8")), config);
  const findings = placeholderFindings(wranglerConfig);
  if (findings.length) throw new Error(`The Wrangler config is incomplete:\n${findings.map(item => `  - ${item}`).join("\n")}`);
  writeFileSync(generatedConfig, `${JSON.stringify(wranglerConfig, null, 2)}\n`);
  log([
    `Wrote ${path.relative(projectRoot, generatedConfig)} for Worker ${config.workerName}`,
    `  hostname: ${config.customDomain ?? `${config.workerName}.<your subdomain>.workers.dev`}; preview URLs off`,
    `  D1 ${config.d1.name} (${config.d1.id}), R2 ${config.r2.bucket}`,
    `  plan ${config.plan}: storage measured against ${STORAGE_LIMIT_BYTES[config.plan].toLocaleString("en-US")} bytes`,
    `  vars: ${Object.keys(wranglerConfig.vars).join(", ")}`,
  ].join("\n"));
  const accessMissing = !config.access;
  if (accessMissing) log(`No Access settings yet: the Worker will refuse every visitor with 503 until access.teamDomain and access.aud are set and it is deployed again (${TUTORIAL}).`);

  if (dryRun) log("Dry run: remote migrations skipped; `npm run db:migrate:remote -- --status` lists the pending ones.");
  else runNode("Remote migrations", ["scripts/db/migrate-local.mjs", "--remote"]);
  runNode(dryRun ? "The Wrangler dry run" : "The upload", ["--import", preload, wrangler, "deploy", "--config", generatedConfig, ...(dryRun ? ["--dry-run"] : [])]);
  log(dryRun
    ? "Dry run complete: nothing was uploaded and no remote database was changed. dist/ now holds the deployment build; run npm run build before local previews."
    : "Deployed. dist/ now holds the deployment build; run npm run build before local previews.");
  if (!dryRun && accessMissing) log(`Next: set up Cloudflare Access for the Worker's hostname (${TUTORIAL}, step 5), add the team domain and AUD tag to the config, and deploy again.`);
}
