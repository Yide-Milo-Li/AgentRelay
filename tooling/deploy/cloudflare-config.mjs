// The deployment config of a standalone Cloudflare deployment and the Wrangler configuration derived from it. Everything
// here is pure: reading files, building and running Wrangler happen in cloudflare-deploy.mjs.
import { randomBytes } from "node:crypto";

/** Where the config lives unless --config says otherwise. `.local/` is ignored, so the IDs in it are never committed. */
export const DEFAULT_CONFIG_FILE = ".local/cloudflare-deployment.json";

/** The D1 database size limit of each Workers plan, which Settings › Storage measures against. */
export const STORAGE_LIMIT_BYTES = { free: 500_000_000, paid: 10_000_000_000 };

/** The database id `vite.config.ts` puts into every build; a deployable config must never keep it. */
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

const KEYS = ["accountId", "workerName", "plan", "customDomain", "d1", "r2", "access", "workspaceKey", "webPush"];
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// The same rules the Worker applies to its Access settings (src/server/auth/cloudflare-access.ts).
const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9_-]{8,256}$/;
const WORKSPACE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,199}$/;

/** A fixed workspace key that belongs to no single login (decision O10): everyone the Access policy admits shares it. */
export const generateWorkspaceKey = () => `workspace-${randomBytes(16).toString("hex")}`;

/** A config to fill in. Empty values are reported by name until they are set. */
export const starterConfig = (workspaceKey = generateWorkspaceKey()) => ({
  workerName: "agentrelay",
  plan: "free",
  d1: { name: "agentrelay", id: "" },
  r2: { bucket: "agentrelay-images" },
  access: { teamDomain: "", aud: [] },
  workspaceKey,
});

const text = value => (typeof value === "string" ? value.trim() : value);

/**
 * Check a parsed config and return it normalized, with every problem named by its field so all of them can be fixed at
 * once. `workspaceKey` may be missing; the deploy command generates one and saves it before the first deployment.
 * @returns {{ config: object | null, errors: string[] }}
 */
export function validateDeploymentConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { config: null, errors: ["The config must be a JSON object."] };
  const errors = [];
  const field = (name, raw, pattern, hint, { optional = false, normalize = value => value } = {}) => {
    const result = typeof text(raw) === "string" ? normalize(text(raw)) : text(raw);
    if (result === undefined || result === null || result === "") {
      if (!optional) errors.push(`${name} is required: ${hint}.`);
      return undefined;
    }
    if (typeof result !== "string" || !pattern.test(result)) errors.push(`${name} is not valid: ${hint}.`);
    return result;
  };
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) errors.push(`${key} is not a known setting.`);
  const d1 = value.d1 ?? {}, r2 = value.r2 ?? {}, access = value.access ?? {};
  // The AUD tag exists only once Access is enabled on the deployed Worker, so the first deployment goes out without it.
  const accessGiven = Boolean(text(access.teamDomain)) || (Array.isArray(access.aud) ? access.aud.length > 0 : Boolean(access.aud));
  const config = {
    accountId: field("accountId", value.accountId, ACCOUNT_ID, "the 32-character account ID from the dashboard", { optional: true }),
    workerName: field("workerName", value.workerName, WORKER_NAME, "lowercase letters, digits and dashes, at most 63 characters"),
    plan: value.plan,
    customDomain: field("customDomain", value.customDomain, HOSTNAME, "a hostname such as relay.example.com", { optional: true, normalize: host => host.toLowerCase() }),
    d1: {
      name: field("d1.name", d1.name, DATABASE_NAME, "the D1 database name"),
      id: field("d1.id", d1.id, DATABASE_ID, "the D1 database ID, a lowercase UUID shown by `wrangler d1 info <name>`"),
    },
    r2: { bucket: field("r2.bucket", r2.bucket, BUCKET, "the R2 bucket name: 3 to 63 lowercase letters, digits and dashes") },
    access: accessGiven ? {
      teamDomain: field("access.teamDomain", access.teamDomain, TEAM_DOMAIN, "https://<team>.cloudflareaccess.com", { normalize: url => url.replace(/\/$/, "") }),
      aud: Array.isArray(access.aud) ? access.aud.map(text) : access.aud,
    } : null,
    workspaceKey: field("workspaceKey", value.workspaceKey, WORKSPACE_KEY, "8 to 200 letters, digits or ._:@-; leave it out to generate one", { optional: true }),
    webPush: value.webPush ?? true,
  };
  if (!["free", "paid"].includes(config.plan)) errors.push('plan must be "free" or "paid".');
  if (config.customDomain?.endsWith(".workers.dev")) errors.push("customDomain must be your own domain; leave it out to use workers.dev.");
  if (config.access && (!Array.isArray(config.access.aud) || !config.access.aud.length)) errors.push("access.aud is required with access.teamDomain: the AUD tag of each Access application in front of the Worker.");
  else if (config.access && !config.access.aud.every(tag => typeof tag === "string" && AUDIENCE.test(tag))) errors.push("access.aud must list AUD tags as shown on each Access application.");
  if (config.d1.id === PLACEHOLDER_DATABASE_ID) errors.push("d1.id is the build's placeholder; use your database's ID.");
  if (typeof config.webPush !== "boolean") errors.push("webPush must be true or false.");
  return errors.length ? { config: null, errors } : { config, errors };
}

/**
 * The Worker's runtime values. Only what the deployer configured: the Access certificate override is for tests alone.
 * Without Access settings the Worker refuses every browser and native MCP request with 503 until they are deployed.
 */
export function workerVars(config) {
  return {
    AGENTRELAY_WORKSPACE_OWNER_ID: config.workspaceKey,
    AGENTRELAY_STORAGE_LIMIT_BYTES: String(STORAGE_LIMIT_BYTES[config.plan]),
    ...(config.access ? { AGENTRELAY_ACCESS_TEAM_DOMAIN: config.access.teamDomain, AGENTRELAY_ACCESS_AUD: config.access.aud.join(",") } : {}),
    // The Worker makes its own push keys; the only setting is the documented off switch.
    ...(config.webPush ? {} : { AGENTRELAY_WEB_PUSH_ENABLED: "0" }),
  };
}

const onlyBinding = (list = [], binding, kind) => {
  if (list.length !== 1 || list[0].binding !== binding) throw new Error(`The build must declare exactly one ${kind} binding named ${binding}.`);
  return list[0];
};

/**
 * The generated `dist/server/wrangler.json` with this deployment's names, IDs, vars and hostname. Preview URLs stay off;
 * with a custom domain the Worker is served only there, so Access protects one hostname.
 */
export function deploymentWranglerConfig(generated, config) {
  if (!config.workspaceKey) throw new Error("A workspace key is required before the Wrangler config is written.");
  const database = onlyBinding(generated.d1_databases, "DB", "D1");
  const bucket = onlyBinding(generated.r2_buckets, "BUCKET", "R2");
  const result = {
    ...generated,
    name: config.workerName,
    vars: workerVars(config),
    d1_databases: [{ ...database, database_name: config.d1.name, database_id: config.d1.id }],
    r2_buckets: [{ ...bucket, bucket_name: config.r2.bucket }],
    preview_urls: false,
    workers_dev: !config.customDomain,
    routes: config.customDomain ? [{ pattern: config.customDomain, custom_domain: true }] : [],
  };
  if (config.accountId) result.account_id = config.accountId;
  else delete result.account_id;
  return result;
}

/** Anything left from the Sites build that would deploy against the wrong resources. Empty for a complete config. */
export function placeholderFindings(wrangler) {
  const findings = [];
  for (const database of wrangler.d1_databases ?? []) {
    if (database.database_id === PLACEHOLDER_DATABASE_ID || !DATABASE_ID.test(database.database_id ?? "")) findings.push(`D1 binding ${database.binding} has no real database ID.`);
    if (/^site-creator-/.test(database.database_name ?? "")) findings.push(`D1 binding ${database.binding} still names the Sites placeholder database.`);
  }
  for (const bucket of wrangler.r2_buckets ?? []) if (/^site-creator-/.test(bucket.bucket_name ?? "")) findings.push(`R2 binding ${bucket.binding} still names the Sites placeholder bucket.`);
  for (const name of ["AGENTRELAY_WORKSPACE_OWNER_ID", "AGENTRELAY_STORAGE_LIMIT_BYTES"]) if (!wrangler.vars?.[name]) findings.push(`${name} is not set.`);
  if (Boolean(wrangler.vars?.AGENTRELAY_ACCESS_TEAM_DOMAIN) !== Boolean(wrangler.vars?.AGENTRELAY_ACCESS_AUD)) findings.push("The Access team domain and AUD tags must be set together.");
  if (wrangler.vars?.AGENTRELAY_ACCESS_CERTS_URL) findings.push("AGENTRELAY_ACCESS_CERTS_URL is a test override and must not be deployed.");
  if (wrangler.preview_urls !== false) findings.push("Preview URLs must be off.");
  return findings;
}
