import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import {
  PLACEHOLDER_DATABASE_ID, deploymentWranglerConfig, generateWorkspaceKey, placeholderFindings, starterConfig, validateDeploymentConfig, workerVars,
} from "../../tooling/deploy/cloudflare-config.mjs";

const AUD = "a".repeat(64);
const complete = (overrides = {}) => ({
  workerName: "agentrelay", plan: "free", d1: { name: "agentrelay", id: "3f2b6c1e-8a4d-4e2f-9b1c-7d6e5f4a3b2c" },
  r2: { bucket: "agentrelay-images" }, access: { teamDomain: "https://example-team.cloudflareaccess.com/", aud: [AUD] },
  workspaceKey: "workspace-0123456789abcdef0123456789abcdef", ...overrides,
});
// The binding part of what `npm run build` writes to dist/server/wrangler.json.
const generated = () => ({
  name: "agentrelay", main: "index.js", assets: { directory: "../client" }, vars: {},
  d1_databases: [{ binding: "DB", database_name: "site-creator-d1", database_id: PLACEHOLDER_DATABASE_ID, migrations_dir: "../../migrations" }],
  r2_buckets: [{ binding: "BUCKET", bucket_name: "site-creator-r2" }],
});
const configured = overrides => validateDeploymentConfig(complete(overrides)).config;
const withoutKey = () => { const value = complete(); delete value.workspaceKey; return value; };

test("a starter config names exactly what is left to fill in", () => {
  const starter = starterConfig();
  assert.match(starter.workspaceKey, /^workspace-[0-9a-f]{32}$/);
  assert.deepEqual(validateDeploymentConfig(starter).errors, [
    "d1.id is required: the D1 database ID, a lowercase UUID shown by `wrangler d1 info <name>`.",
  ]);
});

test("Access may wait for the second deployment, but never half of it", () => {
  const first = validateDeploymentConfig(complete({ access: { teamDomain: "", aud: [] } }));
  assert.deepEqual(first.errors, []);
  assert.equal(first.config.access, null);
  assert.deepEqual(Object.keys(workerVars(first.config)), ["AGENTRELAY_WORKSPACE_OWNER_ID", "AGENTRELAY_STORAGE_LIMIT_BYTES"]);
  assert.deepEqual(placeholderFindings(deploymentWranglerConfig(generated(), first.config)), []);
  assert.deepEqual(validateDeploymentConfig(complete({ access: { teamDomain: "https://example-team.cloudflareaccess.com", aud: [] } })).errors,
    ["access.aud is required with access.teamDomain: the AUD tag of each Access application in front of the Worker."]);
  assert.deepEqual(validateDeploymentConfig(complete({ access: { aud: [AUD] } })).errors, ["access.teamDomain is required: https://<team>.cloudflareaccess.com."]);
  assert.deepEqual(placeholderFindings({ ...deploymentWranglerConfig(generated(), first.config), vars: { ...workerVars(first.config), AGENTRELAY_ACCESS_AUD: AUD } }),
    ["The Access team domain and AUD tags must be set together."]);
});

test("a complete config is normalized; the workspace key may be left for the deploy command", () => {
  const config = configured({ customDomain: " Relay.Example.COM " });
  assert.equal(config.access.teamDomain, "https://example-team.cloudflareaccess.com");
  assert.equal(config.customDomain, "relay.example.com");
  assert.equal(config.webPush, true);
  assert.deepEqual(validateDeploymentConfig(withoutKey()).errors, []);
});

test("mistakes are all reported at once, by field", () => {
  const { errors } = validateDeploymentConfig(complete({
    plan: "pro", workerName: "Agent_Relay", customDomain: "agentrelay.example.workers.dev", d1: { name: "agentrelay", id: PLACEHOLDER_DATABASE_ID },
    access: { teamDomain: "https://evil.example.com", aud: ["short"] }, webPush: "no", vars: {},
  }));
  assert.deepEqual(errors, [
    "vars is not a known setting.",
    "workerName is not valid: lowercase letters, digits and dashes, at most 63 characters.",
    "access.teamDomain is not valid: https://<team>.cloudflareaccess.com.",
    'plan must be "free" or "paid".',
    "customDomain must be your own domain; leave it out to use workers.dev.",
    "access.aud must list AUD tags as shown on each Access application.",
    "d1.id is the build's placeholder; use your database's ID.",
    "webPush must be true or false.",
  ]);
  assert.deepEqual(validateDeploymentConfig([]).errors, ["The config must be a JSON object."]);
});

test("the Worker gets the workspace key, the plan's storage limit and the Access settings, never the test override", () => {
  assert.deepEqual(workerVars(configured({ access: { teamDomain: "https://example-team.cloudflareaccess.com", aud: [AUD, "b".repeat(64)] } })), {
    AGENTRELAY_WORKSPACE_OWNER_ID: "workspace-0123456789abcdef0123456789abcdef", AGENTRELAY_STORAGE_LIMIT_BYTES: "500000000",
    AGENTRELAY_ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com", AGENTRELAY_ACCESS_AUD: `${AUD},${"b".repeat(64)}`,
  });
  assert.equal(workerVars(configured({ plan: "paid" })).AGENTRELAY_STORAGE_LIMIT_BYTES, "10000000000");
  assert.equal(workerVars(configured({ webPush: false })).AGENTRELAY_WEB_PUSH_ENABLED, "0");
});

test("the Wrangler config keeps the build and replaces every placeholder", () => {
  const before = generated();
  assert.deepEqual(placeholderFindings(before), [
    "D1 binding DB has no real database ID.", "D1 binding DB still names the Sites placeholder database.", "R2 binding BUCKET still names the Sites placeholder bucket.",
    "AGENTRELAY_WORKSPACE_OWNER_ID is not set.", "AGENTRELAY_STORAGE_LIMIT_BYTES is not set.", "Preview URLs must be off.",
  ]);
  const result = deploymentWranglerConfig(before, configured({ accountId: "0123456789abcdef0123456789abcdef" }));
  assert.deepEqual(placeholderFindings(result), []);
  assert.equal(result.main, "index.js");
  assert.deepEqual(result.assets, { directory: "../client" });
  assert.deepEqual(result.d1_databases, [{ binding: "DB", database_name: "agentrelay", database_id: "3f2b6c1e-8a4d-4e2f-9b1c-7d6e5f4a3b2c", migrations_dir: "../../migrations" }]);
  assert.deepEqual(result.r2_buckets, [{ binding: "BUCKET", bucket_name: "agentrelay-images" }]);
  assert.equal(result.account_id, "0123456789abcdef0123456789abcdef");
  assert.equal(result.preview_urls, false);
  assert.equal(result.workers_dev, true);
  assert.deepEqual(result.routes, []);
  assert.equal(before.d1_databases[0].database_id, PLACEHOLDER_DATABASE_ID, "the generated config is not mutated");
});

test("a custom domain turns workers.dev off, so Access protects one hostname", () => {
  const result = deploymentWranglerConfig(generated(), configured({ customDomain: "relay.example.com" }));
  assert.equal(result.workers_dev, false);
  assert.deepEqual(result.routes, [{ pattern: "relay.example.com", custom_domain: true }]);
  assert.equal("account_id" in result, false);
});

test("an unexpected build or a missing key stops the rewrite", () => {
  assert.throws(() => deploymentWranglerConfig(generated(), validateDeploymentConfig(withoutKey()).config), /workspace key is required/);
  assert.throws(() => deploymentWranglerConfig({ ...generated(), r2_buckets: [] }, configured()), /exactly one R2 binding named BUCKET/);
  assert.throws(() => deploymentWranglerConfig({ ...generated(), d1_databases: [{ binding: "OTHER" }] }, configured()), /exactly one D1 binding named DB/);
  assert.ok(placeholderFindings({ ...deploymentWranglerConfig(generated(), configured()), vars: { AGENTRELAY_ACCESS_CERTS_URL: "http://127.0.0.1" } })
    .includes("AGENTRELAY_ACCESS_CERTS_URL is a test override and must not be deployed."));
});

test("workspace keys are random", () => {
  assert.notEqual(generateWorkspaceKey(), generateWorkspaceKey());
});

const run = (...args) => spawnSync(process.execPath, ["scripts/deploy/cloudflare.mjs", ...args], { cwd: projectRoot, encoding: "utf8" });
// TEMP may point inside the checkout, where a config that Git does not ignore is refused, so fall back to the home directory.
const scratch = () => {
  const inside = candidate => !path.relative(projectRoot, candidate).startsWith("..");
  return mkdtempSync(path.join(inside(os.tmpdir()) ? os.homedir() : os.tmpdir(), "cf-deploy-"));
};

test("--init writes a starter config once, and a deployment stops on it before building", () => {
  const directory = scratch(), file = path.join(directory, "deployment.json");
  try {
    const created = run("--init", "--config", file);
    assert.equal(created.status, 0, created.stderr);
    assert.match(readFileSync(file, "utf8"), /"workspaceKey": "workspace-[0-9a-f]{32}"/);
    const again = run("--init", "--config", file);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists; edit it instead/);
    const dry = run("--dry-run", "--config", file);
    assert.equal(dry.status, 1);
    assert.match(dry.stderr, /needs changes:\n {2}- d1\.id is required/);
    assert.doesNotMatch(dry.stdout, /Build complete/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the command refuses a config Git could commit, a missing config and unknown options", () => {
  const tracked = run("--dry-run", "--config", "tooling/deploy/deployment.json");
  assert.equal(tracked.status, 1);
  assert.match(tracked.stderr, /could be committed/);
  const directory = scratch();
  try {
    const missing = run("--dry-run", "--config", path.join(directory, "absent.json"));
    assert.match(missing.stderr, /does not exist\. Create it with: npm run deploy:cloudflare -- --init/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.match(run("--deploy").stderr, /usage: npm run deploy:cloudflare/);
  assert.match(run("--init", "--dry-run").stderr, /Choose --init or --dry-run/);
});
