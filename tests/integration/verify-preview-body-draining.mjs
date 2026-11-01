import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { localTestEnvironment, startLocalPreview } from "../support/local-preview.mjs";
import { sanitizeRunLogs } from "../support/integration-process.mjs";
import { probeLocalPreview } from "./probe-local-preview.mjs";

const directory = path.join(projectRoot, "outputs/verification", `body-draining-${Date.now()}`), results = [];
mkdirSync(directory, { recursive: true });
try {
  for (const [bundle, drainBody] of [[false, false], [true, false], [true, true]]) {
    const env = localTestEnvironment(path.join(directory, drainBody ? "drained" : bundle ? "middleware" : "unbundled"));
    env.AGENTRELAY_TEST_CONFIG = path.join(env.SITES_RUNTIME_ROOT, "wrangler.json");
    writeFileSync(env.AGENTRELAY_TEST_CONFIG, JSON.stringify({ name: "early-response-fixture",
      main: path.join(projectRoot, "tests/fixtures/early-response-worker.mjs"), compatibility_date: "2026-05-15", no_bundle: true }));
    const transport = drainBody ? "direct" : "wrangler";
    const preview = await startLocalPreview(env, { label: "fixture", bundle, drainBody, transport });
    try {
      const probes = await probeLocalPreview(preview.url);
      const boots = [...new Set(probes.observations.map(row => row.boot).filter(Boolean))];
      results.push({ transport, bundle, drainBody, boots, ...probes });
      console.log(JSON.stringify({ bundle, drainBody, passed: probes.passed, boots: boots.length }));
      assert.equal(boots.length, 1, "the fixture must stay on one instance during a probe sequence");
      // The negative control may stop reproducing on a future runtime; never require a known bug to persist.
      if (drainBody) assert.ok(probes.passed, "body draining must preserve rejection responses and subsequent reads");
    } finally { preview.stop(); await preview.done; }
  }
} finally {
  sanitizeRunLogs(directory);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ results, testRetries: 0 }, null, 2));
  console.log(`Body-draining evidence: ${directory}`);
}
