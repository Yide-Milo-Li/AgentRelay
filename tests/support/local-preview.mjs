import { mkdirSync } from "node:fs";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { startTestNode } from "./integration-process.mjs";
import { testRequest } from "./integration-http.mjs";
import { prepareLocalPreview } from "../../tooling/environment/prepare-local-preview.mjs";

export function localTestEnvironment(directory, state) {
  const stateId = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16);
  // SQLite uses both persistent and temporary filenames; keep both roots short on Windows.
  const temp = path.join(projectRoot, ".sites-runtime", "test-tmp", stateId);
  const localState = state ?? path.join(projectRoot, ".sites-runtime", "test-state", stateId);
  mkdirSync(directory, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp, SITES_RUNTIME_ROOT: directory,
    WRANGLER_LOG_PATH: path.join(directory, "wrangler-logs"), WRANGLER_WRITE_LOGS: "true",
    WRANGLER_REGISTRY_PATH: path.join(directory, "dev-registry"), MINIFLARE_REGISTRY_PATH: path.join(directory, "registry"),
    CLOUDFLARE_CF_FETCH_ENABLED: "false", WRANGLER_SEND_METRICS: "false",
    AGENTRELAY_TEST_STATE: localState, AGENTRELAY_TEST_CONFIG: path.join(projectRoot, "dist/server/wrangler.json") };
  delete env.AGENTRELAY_WORKSPACE_OWNER_ID;
  delete env.AGENTRELAY_AGENT_TOKEN;
  delete env.AGENTRELAY_TEST_URL;
  delete env.AGENTRELAY_TEST_PRIVATE_URL;
  delete env.AGENTRELAY_TEST_WORKSPACE_OWNER;
  // Test sign-in material goes only to the processes that sign in, never to a preview by inheritance.
  delete env.AGENTRELAY_TEST_TARGET;
  delete env.AGENTRELAY_TEST_ACCESS_KEY;
  return env;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Start a disposable built Worker. Readiness polls are separate from strict acceptance requests. `readyStatus` is what
 * an unauthenticated `/api/storage` answers once the Worker is up: 401, or 503 for a deliberately misconfigured one.
 */
export async function startLocalPreview(env, { label = "preview", workspace, vars = {}, timeoutMs = 1_800_000, signal, bundle = true, drainBody = true, transport = "direct", readyStatus = 401 } = {}) {
  if (!["direct", "wrangler"].includes(transport)) throw new Error(`Unknown preview transport: ${transport}`);
  if (transport === "direct" && !bundle) throw new Error("Use the Wrangler transport for unbundled diagnostic controls.");
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const config = transport === "wrangler" && drainBody ? prepareLocalPreview(env.AGENTRELAY_TEST_CONFIG, path.join(env.SITES_RUNTIME_ROOT, "entry")) : env.AGENTRELAY_TEST_CONFIG;
  const previewEnv = { ...env };
  delete previewEnv.AGENTRELAY_TEST_FIXTURE_URL;
  delete previewEnv.AGENTRELAY_TEST_FIXTURE_TOKEN;
  const bindingFixtures = transport === "direct";
  if (bindingFixtures) previewEnv.AGENTRELAY_TEST_FIXTURE_TOKEN = randomBytes(32).toString("hex");
  let fixtureUrl;
  const managed = startTestNode(transport === "wrangler" ? ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev",
    "--config", config, "--local", "--persist-to", env.AGENTRELAY_TEST_STATE,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    // Vinext emits no_bundle=true; bundling enables Wrangler's local unused-body drain middleware.
    ...(bundle ? ["--bundle"] : []),
    ...(workspace ? ["--var", `AGENTRELAY_WORKSPACE_OWNER_ID:${workspace}`] : []),
    // Extra Worker variables, for example synthetic push settings; a value may contain colons.
    ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])] : ["tests/support/preview-with-fixtures.mjs",
    "--config", config, "--persist-to", env.AGENTRELAY_TEST_STATE, "--ip", "127.0.0.1", "--port", String(port),
    ...(!drainBody ? ["--no-drain"] : []),
    ...(workspace ? ["--var", `AGENTRELAY_WORKSPACE_OWNER_ID:${workspace}`] : []),
    ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])],
  { env: previewEnv, label, timeoutMs, signal, logFile: path.join(env.SITES_RUNTIME_ROOT, `${label}.log`), onOutput: text => {
    const address = /Local storage fixtures ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (address) fixtureUrl = address[1];
  } });
  let exit;
  managed.exit.then(result => { exit = result; });
  const started = performance.now();
  try {
    while (performance.now() - started < 45_000) {
      if (signal?.aborted) throw new Error("Preview startup interrupted.");
      if (exit) throw new Error(`Preview exited before readiness: ${JSON.stringify(exit)}`);
      let status = null;
      try {
        status = (await testRequest(`${url}/api/storage`, {}, { timeoutMs: 1_500, label: "readiness" })).status;
      } catch (error) {
        // A newly starting listener may not accept requests yet (no status). The test client also throws on any 5xx,
        // but a deliberately misconfigured Worker that answers its expected 503 is up.
        status = error.details?.status ?? null;
      }
      if (status === readyStatus && (!bindingFixtures || fixtureUrl)) return { ...managed, url, transport,
        env: { ...previewEnv, AGENTRELAY_TEST_URL: url, ...(fixtureUrl ? { AGENTRELAY_TEST_FIXTURE_URL: fixtureUrl } : {}) },
        get exited() { return exit; }, get tail() { return managed.tail; } };
      await delay(250);
    }
    throw new Error("Preview did not become ready within 45 seconds.");
  } catch (error) { managed.stop(); throw new Error(`${error.message}\n${managed.tail}`); }
}
