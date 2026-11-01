import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { execTestFileSync, runTestNode, startTestNode, sanitizeRunLogs } from "../support/integration-process.mjs";
import { localTestEnvironment, startLocalPreview } from "../support/local-preview.mjs";
import { probeLocalPreview } from "./probe-local-preview.mjs";

const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--acceptance", "--probes-only", "--workspace"].includes(flag)) throw new Error(`Unknown verification option: ${flag}`);
const acceptance = flags.has("--acceptance"), probesOnly = flags.has("--probes-only");
assert.ok(!(acceptance && probesOnly), "Choose acceptance or probes-only.");
const directory = path.join(projectRoot, "outputs/verification", `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
console.log(`Verification evidence: ${directory}`);
const require = createRequire(import.meta.url);
// Package metadata can be intentionally absent from a package's public export map.
const packageFile = (name, resolver = require) => {
  const file = resolver.resolve.paths(name).map(directory => path.join(directory, name, "package.json")).find(existsSync);
  assert.ok(file, `Cannot locate installed package ${name}`);
  return file;
};
const packageInfo = (name, resolver = require) => JSON.parse(readFileSync(packageFile(name, resolver), "utf8"));
const pluginRequire = createRequire(packageFile("@cloudflare/vite-plugin"));
const report = { revision: execTestFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version, libuv: process.versions.uv, platform: process.platform, lockfileSha256: createHash("sha256").update(readFileSync(path.join(projectRoot, "package-lock.json"))).digest("hex"),
  versions: Object.fromEntries(["wrangler", "miniflare", "workerd", "esbuild", "@cloudflare/vite-plugin"].map(name => [name, packageInfo(name).version])),
  viteRuntime: Object.fromEntries(["wrangler", "miniflare", "workerd"].map(name => [name, packageInfo(name, pluginRequire).version])),
  testRetries: 0, rounds: [], completed: false };
const changed = execTestFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
report.sourceHashes = Object.fromEntries(changed.map(file => [file, createHash("sha256").update(readFileSync(path.join(projectRoot, file))).digest("hex")]));
report.proxyWorkerSha256 = createHash("sha256").update(readFileSync(path.join(projectRoot, "node_modules/wrangler/wrangler-dist/ProxyWorker.js"))).digest("hex");
report.previews = [];
report.migrations = [];
const config = path.join(projectRoot, "dist/server/wrangler.json");
assert.ok(existsSync(config), "Run npm run build before local verification.");
const configValue = JSON.parse(readFileSync(config, "utf8"));
report.worker = { compatibilityDate: configValue.compatibility_date, compatibilityFlags: configValue.compatibility_flags,
  sourceNoBundle: configValue.no_bundle, previewBundling: true,
  d1Bindings: (configValue.d1_databases ?? []).map(item => item.binding), r2Bindings: (configValue.r2_buckets ?? []).map(item => item.binding) };
const save = () => writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2));
let preview, active, shared;
const controller = new AbortController();
const abort = () => { controller.abort(); active?.stop(); shared?.stop(); preview?.stop(); };
process.once("SIGINT", abort); process.once("SIGTERM", abort);

async function migrate(env, label) {
  const result = await runTestNode(["scripts/db/migrate-local.mjs", "--state-dir", env.AGENTRELAY_TEST_STATE], {
    env, label, signal: controller.signal, logFile: path.join(env.SITES_RUNTIME_ROOT, "migrations.log"), timeoutMs: 240_000,
  });
  report.migrations.push(result);
  return result;
}

function recordPreview(process, label) {
  const entry = { label, pid: process.child.pid, transport: process.transport, startedAt: new Date().toISOString() };
  report.previews.push(entry);
  process.done.then(result => { entry.exit = result; });
}

/** A preview exit must interrupt its active suite immediately, not wait for HTTP deadlines. */
async function runAgainstPreview(args, env, label, timeoutMs) {
  controller.signal.throwIfAborted();
  active = startTestNode(args, { env, label, timeoutMs, signal: controller.signal, logFile: path.join(env.SITES_RUNTIME_ROOT, `${label}.log`), onOutput: text => process.stdout.write(text) });
  try {
    const result = await Promise.race([active.done, preview.exit.then(result => { throw new Error(`Preview exited during ${label}: ${JSON.stringify(result)}\n${preview.tail}`); }),
      ...(shared ? [shared.exit.then(result => { throw new Error(`Shared preview exited during ${label}: ${JSON.stringify(result)}\n${shared.tail}`); })] : [])]);
    if (result.code !== 0 || result.timedOut || result.error) throw new Error(`Verification process failed: ${JSON.stringify(result)}\n${active.tail}`);
    return result;
  } finally { active.stop(); active = undefined; }
}

try {
  for (let round = 1; round <= (acceptance ? 3 : 1); round++) {
    // Round two deliberately reuses round one's Worker and state. Round three is a fresh cold start.
    if (round !== 2) {
      preview?.stop(); if (preview) await preview.done;
      const env = localTestEnvironment(path.join(directory, `worker-${round}`));
      await migrate(env, `migrations-${round}`);
      preview = await startLocalPreview(env, { label: `preview-${round}`, timeoutMs: 3_600_000, signal: controller.signal });
      recordPreview(preview, `preview-${round}`);
    }
    const result = { round, previewPid: preview.child.pid, coldStart: round !== 2 };
    report.rounds.push(result); save();
    const probes = await probeLocalPreview(preview.url);
    writeFileSync(path.join(directory, `probes-${round}.json`), JSON.stringify(probes, null, 2));
    result.probesPassed = probes.passed; save();
    assert.ok(probes.passed, `Round ${round}: rejection/idle probes failed; inspect probes-${round}.json`);
    if (!probesOnly) {
      const suiteDirectory = path.join(directory, `round-${round}`);
      mkdirSync(suiteDirectory, { recursive: true });
      const env = { ...preview.env, AGENTRELAY_TEST_REPORT: path.join(suiteDirectory, "suites.json") };
      // Invoke the actual package command so the report proves the documented command completed.
      const npm = process.env.npm_execpath;
      const args = npm ? [npm, "run", "test:integration"] : ["tests/integration/run-suites.mjs"];
      result.command = npm ? "npm run test:integration" : "node tests/integration/run-suites.mjs";
      result.process = await runAgainstPreview(args, env, `integration-${round}`, 1_800_000);
      result.suites = JSON.parse(readFileSync(env.AGENTRELAY_TEST_REPORT, "utf8"));
      assert.equal(result.suites.complete, true);
    }
    save();
  }
  if (acceptance || flags.has("--workspace")) {
    const env = localTestEnvironment(path.join(directory, "shared"), preview.env.AGENTRELAY_TEST_STATE);
    const workspace = `shared-qa-${crypto.randomUUID().slice(0, 8)}`;
    shared = await startLocalPreview(env, { label: "shared-preview", workspace, signal: controller.signal });
    recordPreview(shared, "shared-preview");
    report.workspace = await runAgainstPreview(["tests/integration/verify-agentrelay-workspace.mjs"], {
      ...shared.env, AGENTRELAY_TEST_WORKSPACE_OWNER: workspace, AGENTRELAY_TEST_PRIVATE_URL: preview.url,
    }, "shared-workspace", 300_000);
  }
  report.completed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  abort();
  await Promise.all([preview?.done, shared?.done].filter(Boolean));
  sanitizeRunLogs(directory);
  process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  save();
  console.log(JSON.stringify({ completed: report.completed, directory, testRetries: 0 }));
}
