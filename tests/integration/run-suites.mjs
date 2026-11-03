import { writeFileSync } from "node:fs";
import path from "node:path";
import { runTestNode } from "../support/integration-process.mjs";

const suites = ["verify-agentrelay", "verify-agentrelay-agents", "verify-agentrelay-storage", "verify-agentrelay-projects", "verify-agentrelay-attachments", "verify-agentrelay-bridge", "verify-agentrelay-receipts", "verify-agentrelay-git-context", "verify-agentrelay-inbox-list",
  // Access identity exists only on the cloudflare build target.
  ...(process.env.AGENTRELAY_TEST_TARGET === "cloudflare" ? ["verify-agentrelay-access"] : [])];
const results = [];
try {
  for (const suite of suites) {
    let output = "";
    const result = await runTestNode([
      // Pass options as argv entries so report directories containing spaces stay intact.
      ...(process.env.AGENTRELAY_TEST_REPORT ? ["--report-on-fatalerror", `--report-directory=${path.dirname(process.env.AGENTRELAY_TEST_REPORT)}`] : []),
      `tests/integration/${suite}.mjs`,
    ], {
      label: suite, timeoutMs: 300_000,
      ...(process.env.AGENTRELAY_TEST_REPORT ? { logFile: path.join(path.dirname(process.env.AGENTRELAY_TEST_REPORT), `${suite}.log`) } : {}),
      onOutput: text => { output = (output + text).slice(-200_000); process.stdout.write(text); },
    });
    const passed = Number([...output.matchAll(/"passed"\s*:\s*(\d+)/g)].at(-1)?.[1]);
    if (!Number.isInteger(passed) || passed < 1) throw new Error(`${suite} exited without a nonempty check summary.`);
    results.push({ ...result, passed, testRetries: 0 });
    console.log(`PASS suite ${suite}: ${passed} checks (${result.elapsedMs} ms)`);
  }
} finally {
  if (process.env.AGENTRELAY_TEST_REPORT) writeFileSync(process.env.AGENTRELAY_TEST_REPORT, JSON.stringify({ node: process.version, libuv: process.versions.uv, results, complete: results.length === suites.length, testRetries: 0 }, null, 2));
}
