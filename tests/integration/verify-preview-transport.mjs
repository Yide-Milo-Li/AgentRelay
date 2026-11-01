import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { sanitizeRunLogs } from "../support/integration-process.mjs";
import { localTestEnvironment, startLocalPreview } from "../support/local-preview.mjs";

const { values } = parseArgs({ options: { rounds: { type: "string", default: "32" }, parallel: { type: "string", default: "8" } } });
const rounds = Number(values.rounds), parallel = Number(values.parallel);
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 200);
assert.ok(Number.isInteger(parallel) && parallel >= 1 && parallel <= 32);
const directory = path.join(projectRoot, "outputs/verification", `preview-transport-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const report = { node: process.version, libuv: process.versions.uv, rounds, parallel, cadenceMs: 5_000, testRetries: 0, results: [], complete: false };
const previews = [];
const save = () => writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2));

/** A fresh incoming socket for each attempt isolates the ProxyWorker's own outbound connection pool. */
function request(url, { method = "GET", body, id } = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const outgoing = http.request(url, { method, agent: false, headers: { Connection: "close",
      ...(body ? { "Content-Type": "application/octet-stream", "Content-Length": body.length, "X-Probe-Id": id } : {}) } }, response => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.once("end", () => {
        let data;
        if (response.headers["content-type"]?.includes("json")) {
          try { data = JSON.parse(text); }
          catch { resolve({ status: response.statusCode, error: "invalid-json" }); return; }
        }
        resolve({ status: response.statusCode, data, reusedSocket: outgoing.reusedSocket, elapsedMs: Math.round(performance.now() - started) });
      });
      response.once("error", error => resolve({ error: error.code ?? error.message }));
    });
    const deadline = setTimeout(() => outgoing.destroy(new Error("request-deadline")), 15_000);
    outgoing.once("close", () => clearTimeout(deadline));
    outgoing.once("error", error => resolve({ error: error.code ?? error.message }));
    outgoing.end(body);
  });
}

try {
  for (const transport of ["wrangler", "direct"]) {
    const env = localTestEnvironment(path.join(directory, transport));
    env.AGENTRELAY_TEST_CONFIG = path.join(env.SITES_RUNTIME_ROOT, "wrangler.json");
    writeFileSync(env.AGENTRELAY_TEST_CONFIG, JSON.stringify({ name: "preview-transport-fixture", no_bundle: true,
      main: path.join(projectRoot, "tests/fixtures/preview-transport-worker.mjs"), compatibility_date: "2026-05-15" }));
    previews.push({ transport, process: await startLocalPreview(env, { transport, timeoutMs: 1_200_000 }) });
  }
  console.log(`Preview transport evidence: ${directory}`);
  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    // Align send times, rather than waiting five seconds after a response has already arrived.
    await delay(Math.max(0, started + round * report.cadenceMs - performance.now()));
    for (const { transport, process } of previews) {
      const observations = await Promise.all(Array.from({ length: parallel }, async (_, index) => {
        const id = `${round}-${index}`, body = Buffer.from(`exact\r\n synthetic payload 中文 🚀\n${id}\n`);
        return { id, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length,
          ...await request(process.url, { method: "POST", id, body }) };
      }));
      report.results.push({ transport, round, observations });
      console.log(JSON.stringify({ transport, round, statuses: observations.map(result => result.status ?? result.error) }));
    }
    save();
  }
  report.summary = [];
  for (const { transport, process } of previews) {
    const observations = report.results.filter(row => row.transport === transport).flatMap(row => row.observations);
    const applicationError = await request(`${process.url}/application-error`);
    const snapshot = await request(`${process.url}/observations`);
    const failures = observations.filter(row => row.status !== 201 || row.error);
    report.summary.push({ transport, requests: observations.length, failed: failures.length, handlerCalls: snapshot.data?.calls });
    // The upstream control may improve in a later release. The application's preview must always pass.
    if (transport === "direct") {
      assert.equal(failures.length, 0, "direct preview must deliver every write on its only attempt");
      assert.equal(applicationError.status, 500, "application failures must remain visible to the caller");
      assert.equal(applicationError.data.error, "synthetic application failure");
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.data.intentionalErrors, 1, "an application error must not trigger a retry");
      assert.equal(Object.keys(snapshot.data.calls).length, rounds * parallel);
      const boots = new Set(observations.map(row => row.data.boot));
      assert.deepEqual([...boots], [snapshot.data.boot], "one Worker instance must serve the entire sequence");
      for (const row of observations) {
        assert.equal(row.reusedSocket, false);
        assert.equal(row.data.id, row.id);
        assert.equal(row.data.sha256, row.sha256);
        assert.equal(row.data.bytes, row.bytes);
        assert.equal(snapshot.data.calls[row.id], 1, "each write must execute exactly once");
      }
    }
  }
  report.complete = true;
} finally {
  for (const { process } of previews) process.stop();
  await Promise.all(previews.map(({ process }) => process.done));
  sanitizeRunLogs(directory); save();
  console.log(JSON.stringify({ directory, complete: report.complete, summary: report.summary?.map(({ transport, requests, failed }) => ({ transport, requests, failed })), testRetries: 0 }));
}
