// Deploy AgentRelay to your own Cloudflare account, behind Cloudflare Access. See docs/guides/cloudflare-deployment.md.
// Usage: npm run deploy:cloudflare -- [--config <file>] [--dry-run | --init]
// --init writes a starter config with a new workspace key; --dry-run builds and checks everything without uploading or
// changing the remote database. The config defaults to .local/cloudflare-deployment.json.
import { DEFAULT_CONFIG_FILE } from "../../tooling/deploy/cloudflare-config.mjs";
import { deployCloudflare, initDeploymentConfig } from "../../tooling/deploy/cloudflare-deploy.mjs";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import path from "node:path";

const USAGE = "usage: npm run deploy:cloudflare -- [--config <file>] [--dry-run | --init]";
function fail(message) {
  console.error(`deploy:cloudflare: ${message}`);
  process.exit(1);
}

const options = { configFile: DEFAULT_CONFIG_FILE, dryRun: false, init: false };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === "--dry-run") options.dryRun = true;
  else if (name === "--init") options.init = true;
  else if (name === "--config" && args[index + 1] && !args[index + 1].startsWith("--")) options.configFile = args[++index];
  else fail(USAGE);
}
if (options.dryRun && options.init) fail(`Choose --init or --dry-run.\n${USAGE}`);

try {
  if (options.init) console.log(initDeploymentConfig(path.resolve(projectRoot, options.configFile)).join("\n"));
  else deployCloudflare(options);
} catch (error) {
  fail(error.message);
}
