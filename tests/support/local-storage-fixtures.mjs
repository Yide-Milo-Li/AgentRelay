import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execTestFile } from "./integration-process.mjs";

function fixtureAccess(env) {
  const address = env.AGENTRELAY_TEST_FIXTURE_URL, token = env.AGENTRELAY_TEST_FIXTURE_TOKEN;
  if (!address && !token) return null;
  if (!address || !token) throw new Error("Incomplete local storage fixture configuration.");
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Storage fixtures require an authenticated loopback endpoint.");
  return { url, token };
}

async function bindingRequest(access, operation, body) {
  const response = await fetch(new URL(operation, access.url), { method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok && !(operation === "/r2" && response.status === 404)) {
    const data = await response.json().catch(() => ({}));
    const code = /^[A-Z_]+$/.test(data.error?.code ?? "") ? data.error.code : "FIXTURE_FAILED";
    throw new Error(`Local storage fixture failed: ${response.status} ${code}`);
  }
  return response;
}

const wranglerArgs = env => ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local",
  "--config", env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json", "--persist-to", env.AGENTRELAY_TEST_STATE ?? ".wrangler/state"];

/** Each fixture statement executes once. Separate statements must be explicit; semicolons inside values are preserved. */
export async function executeLocalSql(command, { env = process.env } = {}) {
  const statements = Array.isArray(command) ? command : [command];
  const access = fixtureAccess(env);
  if (access) return (await bindingRequest(access, "/sql", { statements })).json();
  // Preserve standalone suites against manually started previews. Never fall back after a binding request failed.
  const sql = statements.map(statement => `${statement.trimEnd().replace(/;$/, "")};`).join("\n");
  const output = await execTestFile(process.execPath, [...wranglerArgs(env), "--command", sql, "--json"], { env, encoding: "utf8" });
  return JSON.parse(output);
}

/** Read original local bytes through the same R2 binding as the application, or use the existing standalone CLI path. */
export async function readLocalR2Object(key, { env = process.env } = {}) {
  const access = fixtureAccess(env);
  if (access) {
    const response = await bindingRequest(access, "/r2", { key });
    return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentrelay-r2-")), output = path.join(directory, "object.bin");
  try {
    await execTestFile(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "r2", "object", "get", `site-creator-r2/${key}`,
      "--file", output, "--local", "--config", env.AGENTRELAY_TEST_CONFIG ?? "dist/server/wrangler.json", "--persist-to", env.AGENTRELAY_TEST_STATE ?? ".wrangler/state"], { env });
    return new Uint8Array(await readFile(output));
  } catch (error) {
    if (/does not exist/i.test(String(error.stderr))) return null;
    throw error;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
