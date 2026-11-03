// Apply every pending drizzle/ migration to the local D1 database used by `npm run start`, or with --remote to the
// deployed database that dist/server/wrangler.json names (written by `npm run deploy:cloudflare`). Both keep the same
// ledger; never mix in `wrangler d1 migrations apply`, which keeps a different one.
// Usage: npm run db:migrate:local [-- --status] [-- --state-dir <path>]
//        npm run db:migrate:remote [-- --status]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { LEDGER_TABLE, LEGACY_PROBES, planMigrations, withLedgerRow } from "../../tooling/database/migration-plan.mjs";
import { PLACEHOLDER_DATABASE_ID } from "../../tooling/deploy/cloudflare-config.mjs";

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const remote = args.includes("--remote");
const stateFlag = args.indexOf("--state-dir");
const stateDir = stateFlag >= 0 ? path.resolve(args[stateFlag + 1] ?? "") : path.join(projectRoot, ".wrangler", "state");
const config = path.join(projectRoot, "dist", "server", "wrangler.json");
if (remote && stateFlag >= 0) fail("--state-dir applies to the local database only.");
if (stateFlag >= 0 && !args[stateFlag + 1]) fail("--state-dir needs a path.");
if (!existsSync(config)) fail("dist/server/wrangler.json is missing. Run `npm run build` first.");
// A plain build names the Sites placeholder database; only the deploy command writes the real one.
if (remote && JSON.parse(readFileSync(config, "utf8")).d1_databases?.[0]?.database_id === PLACEHOLDER_DATABASE_ID) {
  fail("dist/server/wrangler.json names no deployed database. Run `npm run deploy:cloudflare -- --dry-run` first.");
}
const location = remote ? ["--remote", "--yes"] : ["--local", "--persist-to", stateDir];

const wranglerBin = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const preload = pathToFileURL(path.join(projectRoot, "scripts", "sites-env.mjs")).href;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Run one wrangler D1 statement or file against the database and return its result rows. A remote file is imported in
 * one step that Cloudflare rolls back on failure, so a migration and its ledger row still land together.
 */
function d1(target, { rows = true } = {}) {
  const output = execFileSync(process.execPath, [
    "--import", preload, wranglerBin, "d1", "execute", "DB", ...location, "--config", config, "--json", ...target,
  ], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: remote ? 300_000 : 60_000 });
  if (!rows) return [];
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  return parsed.flatMap((entry) => entry.results ?? []);
}

const journal = JSON.parse(readFileSync(path.join(projectRoot, "drizzle", "meta", "_journal.json"), "utf8"));
const tags = journal.entries.map((entry) => entry.tag);

const ledgerExists = d1(["--command", `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${LEDGER_TABLE}'`])[0].n > 0;
const ledgerTags = ledgerExists ? d1(["--command", `SELECT tag FROM ${LEDGER_TABLE}`]).map((row) => row.tag) : null;
const legacyPresent = {};
if (!ledgerExists) {
  for (const tag of tags) if (tag in LEGACY_PROBES) legacyPresent[tag] = d1(["--command", LEGACY_PROBES[tag]])[0].present > 0;
}
const { baseline, apply } = planMigrations(tags, ledgerTags, legacyPresent);

if (statusOnly) {
  console.log(`Already recorded: ${(ledgerTags ?? []).length}; found in the schema: ${baseline.length}; pending: ${apply.length}`);
  for (const tag of apply) console.log(`  pending  ${tag}`);
  process.exit(0);
}

d1(["--command", `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (tag text PRIMARY KEY NOT NULL, applied_at integer NOT NULL)`]);
for (const tag of baseline) {
  d1(["--command", `INSERT INTO ${LEDGER_TABLE} (tag, applied_at) VALUES ('${tag}', ${Date.now()})`]);
  console.log(`recorded ${tag} (already in the schema)`);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "agentrelay-migrate-"));
try {
  for (const tag of apply) {
    const file = path.join(scratch, `${tag}.sql`);
    writeFileSync(file, withLedgerRow(readFileSync(path.join(projectRoot, "drizzle", `${tag}.sql`), "utf8"), tag, Date.now()));
    d1(["--file", file], { rows: false });
    console.log(`applied  ${tag}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(apply.length ? `Done: applied ${apply.length} migration(s).` : "Database is up to date.");
