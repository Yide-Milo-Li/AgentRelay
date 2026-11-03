import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { identityHeaders } from "../support/test-identity.mjs";

/** Compare incoming connection reuse while exercising rejection without any successful database write. */
export async function probeLocalPreview(base) {
  if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Preview probes require a local Worker.");
  const observations = [];
  for (const keepAlive of [true, false]) {
    const agent = new http.Agent({ keepAlive });
    const steps = [
      ["GET", "/api/storage", undefined, 401],
      ["POST", "/api/handoffs", "{}", 401],
      ["GET", "/api/storage", undefined, 401],
      ["POST", "/api/handoffs", "{}", 400, true],
      ["GET", "/api/storage", undefined, 401],
      ["POST", "/api/handoffs", JSON.stringify({ padding: "x".repeat(1_300_001) }), 413, true],
      ["GET", "/api/storage", undefined, 401],
    ];
    try {
      for (let round = 0; round < 2; round++) {
        for (const [method, route, body, expected, authenticated] of steps) {
          const started = performance.now();
          const result = { method, route, keepAlive, round, expected };
          try {
            result.status = await new Promise((resolve, reject) => {
              const request = http.request(new URL(route, base), { method, agent,
                headers: { ...(authenticated ? { ...identityHeaders("preview-probe-synthetic") } : {}),
                  ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, response => {
                if (response.headers["x-preview-boot"]) result.boot = response.headers["x-preview-boot"];
                response.resume(); response.once("end", () => resolve(response.statusCode)); response.once("error", reject);
              });
              const timer = setTimeout(() => request.destroy(new Error("probe-timeout")), 10_000);
              request.once("close", () => clearTimeout(timer)); request.once("error", reject); request.end(body);
            });
          } catch (error) { result.error = error.code ?? error.message; }
          result.elapsedMs = Math.round(performance.now() - started);
          observations.push(result);
        }
        // Cross the internal idle-connection boundary using both incoming connection strategies.
        if (round === 0) await new Promise(resolve => setTimeout(resolve, 5_100));
      }
    } finally { agent.destroy(); }
  }
  return { observations, passed: observations.every(row => row.status === row.expected && !row.error) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await probeLocalPreview(process.env.AGENTRELAY_TEST_URL ?? "http://127.0.0.1:5178");
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.passed, "rejected requests must not poison later requests");
}
