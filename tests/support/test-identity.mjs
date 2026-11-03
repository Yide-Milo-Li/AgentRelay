// Test-only identity, as the platform in front of the Worker delivers it: Sites identity headers for the `sites`
// build target, or a Cloudflare Access application token signed with a per-run test key for the `cloudflare` target.
// The runner serves the matching public key on loopback and points the Worker at it (AGENTRELAY_ACCESS_CERTS_URL);
// the key, its JWKS and the tokens come from the same local Access stand-in the `cloudflare` dev server uses.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { LOCAL_ACCESS_AUD, LOCAL_ACCESS_TEAM, LOCAL_TOKEN_LIFETIME_SECONDS, accessWorkerVars, createAccessKey, mintAccessToken, startJwksServer } from "../../tooling/environment/local-access.mjs";

export { accessWorkerVars, mintAccessToken };
export const TEST_ACCESS_TEAM = LOCAL_ACCESS_TEAM;
export const TEST_ACCESS_AUD = LOCAL_ACCESS_AUD;

/** Environment for test processes that sign in against a `cloudflare` preview. */
export const accessTestEnv = privateKeyPem => ({ AGENTRELAY_TEST_TARGET: "cloudflare", AGENTRELAY_TEST_ACCESS_KEY: privateKeyPem });

/** The target `dist/` was built for. A `cloudflare` build never contains the Sites identity headers; its build guard enforces it. */
export function builtTarget(serverDirectory = path.join(projectRoot, "dist/server")) {
  const scripts = readdirSync(serverDirectory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.m?js$/.test(entry.name));
  return scripts.some(entry => readFileSync(path.join(entry.parentPath, entry.name), "utf8").includes("oai-authenticated-user")) ? "sites" : "cloudflare";
}

/**
 * Sign-in for disposable previews of the current build. A `sites` build needs nothing. A `cloudflare` build gets a
 * per-run key with its loopback JWKS: `vars` go to every preview, `env` to every process that signs in.
 */
export async function prepareTestSignIn(target = builtTarget()) {
  if (target !== "cloudflare") return { target, vars: {}, env: {}, close: async () => {} };
  const key = createAccessKey(), jwks = await startJwksServer(key.jwk);
  return { target, vars: accessWorkerVars(jwks.url), env: accessTestEnv(key.privateKeyPem), close: jwks.close };
}

const tokens = new Map();

/**
 * Identity headers for `user`. Access always reports an email, so a test that names none gets a stable synthetic one.
 * It is derived from a hash, not the id itself: the email is the display name, and suites check that no id leaks.
 */
export function identityHeaders(user, email, env = process.env) {
  if (env.AGENTRELAY_TEST_TARGET !== "cloudflare") {
    return { "oai-authenticated-user-id": user, ...(email ? { "oai-authenticated-user-email": email } : {}) };
  }
  if (!env.AGENTRELAY_TEST_ACCESS_KEY) throw new Error("The cloudflare target needs AGENTRELAY_TEST_ACCESS_KEY; run it through the local verification runner.");
  const address = email ?? `user-${createHash("sha256").update(user).digest("hex").slice(0, 16)}@access.test`, key = `${user}\n${address}`;
  const cached = tokens.get(key);
  // Reuse a token until it is halfway through its lifetime; signing every request would only slow the suites down.
  if (cached && cached.until > Date.now()) return { "cf-access-jwt-assertion": cached.token };
  const token = mintAccessToken(env.AGENTRELAY_TEST_ACCESS_KEY, { sub: user, email: address });
  tokens.set(key, { token, until: Date.now() + LOCAL_TOKEN_LIFETIME_SECONDS * 500 });
  return { "cf-access-jwt-assertion": token };
}
