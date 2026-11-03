// Cloudflare Access identity for the `cloudflare` build target. This file sets the build-time constant before any
// module loads; `node --test` runs each test file in its own process, so other files keep the `sites` target.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { readDeploymentTarget } from "../../tooling/environment/deployment-target.mjs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { env } from "../support/cloudflare-workers-stub.mjs";

globalThis.__AGENTRELAY_TARGET__ = "cloudflare";
const support = file => path.join(projectRoot, "tests/support", file);
const options = { stubs: { "cloudflare:workers": support("cloudflare-workers-stub.mjs"),
  "next/headers": support("next-auth-stub.mjs"), "next/navigation": support("next-auth-stub.mjs") }, inProject: true };
const access = await loadTypeScriptModule("src/server/auth/cloudflare-access.ts", options);
const auth = await loadTypeScriptModule("src/server/auth/index.ts", options);
const platform = await loadTypeScriptModule("src/server/auth/platform-user.ts", options);
const sites = await loadTypeScriptModule("src/server/auth/sites-identity.ts", options);

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const NOW = Date.UTC(2026, 10, 1, 12);
const seconds = NOW / 1000;

const encode = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
async function signingPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  return { kid, privateKey: pair.privateKey, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}
const primary = await signingPair("key-1");
const rotated = await signingPair("key-2");
const claims = (extra = {}) => ({ iss: TEAM, aud: [AUD], sub: "access-user-1", email: "person@example.test", type: "app", iat: seconds - 5, nbf: seconds - 5, exp: seconds + 600, ...extra });
async function sign(payload = claims(), { pair = primary, header = {} } = {}) {
  const head = encode({ alg: "RS256", kid: pair.kid, typ: "JWT", ...header }), body = encode(payload);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}
/** A JWKS endpoint double that counts fetches; each test uses its own URL so the module's key cache never leaks between tests. */
function keyServer(keys = [primary.jwk]) {
  const server = { keys, calls: 0, url: `https://keys.example.test/${crypto.randomUUID()}` };
  server.fetch = async url => { assert.equal(url, server.url); server.calls++; return Response.json({ keys: server.keys }); };
  server.config = { teamDomain: TEAM, audiences: [AUD], certsUrl: server.url };
  return server;
}
const verify = (token, server, now = NOW) => access.verifyAccessToken(token, server.config, { fetch: server.fetch, now });
const rejectsWith = (fn, status) => assert.throws(fn, error => error.status === status);

test("the deployment target defaults to sites and accepts only known values", () => {
  assert.equal(readDeploymentTarget(undefined), "sites");
  assert.equal(readDeploymentTarget(" "), "sites");
  assert.equal(readDeploymentTarget("cloudflare"), "cloudflare");
  assert.throws(() => readDeploymentTarget("vercel"), /sites" or "cloudflare/);
});

test("Access settings are validated and a missing or foreign value fails closed with 503", () => {
  assert.deepEqual(access.accessConfigFrom({ AGENTRELAY_ACCESS_TEAM_DOMAIN: `${TEAM}/`, AGENTRELAY_ACCESS_AUD: ` ${AUD} , ${"b".repeat(64)} ` }),
    { teamDomain: TEAM, audiences: [AUD, "b".repeat(64)], certsUrl: `${TEAM}/cdn-cgi/access/certs` });
  const base = { AGENTRELAY_ACCESS_TEAM_DOMAIN: TEAM, AGENTRELAY_ACCESS_AUD: AUD };
  assert.equal(access.accessConfigFrom({ ...base, AGENTRELAY_ACCESS_CERTS_URL: "http://127.0.0.1:9000/certs" }).certsUrl, "http://127.0.0.1:9000/certs");
  assert.equal(access.accessConfigFrom({ ...base, AGENTRELAY_ACCESS_CERTS_URL: "https://keys.example.test/certs" }).certsUrl, "https://keys.example.test/certs");
  for (const teamDomain of [undefined, "", "http://example-team.cloudflareaccess.com", "https://example-team.cloudflareaccess.com/path", "https://cloudflareaccess.com.evil.test", "https://evil.test"])
    rejectsWith(() => access.accessConfigFrom({ ...base, AGENTRELAY_ACCESS_TEAM_DOMAIN: teamDomain }), 503);
  for (const aud of [undefined, "", " , ", "short", "has space in it"])
    rejectsWith(() => access.accessConfigFrom({ ...base, AGENTRELAY_ACCESS_AUD: aud }), 503);
  for (const certs of ["http://keys.example.test/certs", "ftp://127.0.0.1/certs", "not a url"])
    rejectsWith(() => access.accessConfigFrom({ ...base, AGENTRELAY_ACCESS_CERTS_URL: certs }), 503);
});

test("a valid user token names its person and the signing keys are fetched once", async () => {
  const server = keyServer();
  assert.deepEqual(await verify(await sign(), server), { sub: "access-user-1", email: "person@example.test" });
  assert.deepEqual(await verify(await sign(claims({ aud: AUD })), server), { sub: "access-user-1", email: "person@example.test" });
  assert.deepEqual(await verify(await sign(claims({ aud: ["other-app-aud-0000", AUD] })), server), { sub: "access-user-1", email: "person@example.test" });
  // Within the clock-skew allowance.
  assert.ok(await verify(await sign(claims({ exp: seconds - 30, nbf: seconds + 30, iat: seconds + 30 })), server));
  assert.equal(server.calls, 1);
});

test("tokens that are forged, foreign, expired or not user tokens are rejected", async () => {
  const server = keyServer(), valid = await sign();
  const [head, body, signature] = valid.split(".");
  const cases = {
    "tampered payload": `${head}.${encode(claims({ sub: "someone-else" }))}.${signature}`,
    "tampered signature": `${head}.${body}.${signature.slice(0, -4)}AAAA`,
    "alg none": `${encode({ alg: "none", kid: "key-1" })}.${body}.`,
    "alg HS256": await sign(claims(), { header: { alg: "HS256" } }),
    "missing kid": `${encode({ alg: "RS256" })}.${body}.${signature}`,
    "other team": await sign(claims({ iss: "https://other-example-team.cloudflareaccess.com" })),
    "other application": await sign(claims({ aud: ["c".repeat(64)] })),
    "missing aud": await sign(claims({ aud: undefined })),
    expired: await sign(claims({ exp: seconds - 61 })),
    "missing exp": await sign(claims({ exp: undefined })),
    "not yet valid": await sign(claims({ nbf: seconds + 61 })),
    "issued in the future": await sign(claims({ iat: seconds + 61 })),
    "service token": await sign(claims({ sub: "", email: undefined, common_name: "client-id.access" })),
    "missing email": await sign(claims({ email: undefined })),
    "two parts": `${head}.${body}`,
    "not base64url": `${head}.${body}.not*base64`,
    "not json": `${encode("not json")}.${body}.${signature}`,
    oversized: `${head}.${encode({ ...claims(), padding: "x".repeat(20_000) })}.${signature}`,
  };
  for (const [name, token] of Object.entries(cases)) assert.equal(await verify(token, server), null, name);
});

test("an unknown key id refetches the key set at most once a minute, which picks up a rotation", async () => {
  const server = keyServer();
  const token = await sign(claims(), { pair: rotated });
  assert.equal(await verify(token, server), null);
  assert.equal(server.calls, 1);
  server.keys = [primary.jwk, rotated.jwk];
  assert.equal(await verify(token, server, NOW + 30_000), null, "no refetch inside the minute");
  assert.equal(server.calls, 1);
  assert.deepEqual(await verify(token, server, NOW + 61_000), { sub: "access-user-1", email: "person@example.test" });
  assert.equal(server.calls, 2);
});

test("unreachable signing keys answer 503 instead of rejecting the person", async () => {
  const config = { teamDomain: TEAM, audiences: [AUD], certsUrl: `https://keys.example.test/${crypto.randomUUID()}` };
  const token = await sign();
  await assert.rejects(access.verifyAccessToken(token, config, { now: NOW, fetch: async () => new Response("down", { status: 502 }) }), e => e.status === 503);
  await assert.rejects(access.verifyAccessToken(token, config, { now: NOW, fetch: async () => { throw new TypeError("network"); } }), e => e.status === 503);
});

test("the cloudflare target resolves actors from Access only and never from Sites headers", async () => {
  const server = keyServer();
  const realFetch = globalThis.fetch;
  globalThis.fetch = server.fetch;
  try {
    Object.assign(env, { AGENTRELAY_ACCESS_TEAM_DOMAIN: TEAM, AGENTRELAY_ACCESS_AUD: AUD, AGENTRELAY_ACCESS_CERTS_URL: server.url });
    delete env.AGENTRELAY_WORKSPACE_OWNER_ID;
    assert.equal(platform.SIGN_IN_REQUIRED, "Sign in first.");
    const spoofed = new Request("https://app.example.test/api/workspace", { headers: { "oai-authenticated-user-id": "attacker", "oai-authenticated-user-email": "a@example.test" } });
    await assert.rejects(auth.actorFrom(spoofed), e => e.status === 401 && e.message === "Sign in first.");

    // Real tokens are minted for the current time, so this check uses the clock rather than NOW.
    const live = await sign(claims({ iat: Date.now() / 1000 - 5, nbf: Date.now() / 1000 - 5, exp: Date.now() / 1000 + 600 }));
    const signedIn = new Request("https://app.example.test/api/workspace", { headers: { "cf-access-jwt-assertion": live, "oai-authenticated-user-id": "attacker" } });
    assert.deepEqual(await auth.actorFrom(signedIn), { owner: "access-user-1", userId: "access-user-1", name: "person@example.test" });
    env.AGENTRELAY_WORKSPACE_OWNER_ID = "ws_fixed_key";
    assert.deepEqual(await auth.actorFrom(signedIn), { owner: "ws_fixed_key", userId: "access-user-1", name: "person@example.test" });
    assert.deepEqual(await auth.workspaceInfoFrom(signedIn), { shared: true, viewerName: "person@example.test", workspaceLabel: "AgentRelay" });

    delete env.AGENTRELAY_ACCESS_AUD;
    await assert.rejects(auth.actorFrom(signedIn), e => e.status === 503);
  } finally {
    globalThis.fetch = realFetch;
    for (const name of ["AGENTRELAY_ACCESS_TEAM_DOMAIN", "AGENTRELAY_ACCESS_AUD", "AGENTRELAY_ACCESS_CERTS_URL", "AGENTRELAY_WORKSPACE_OWNER_ID"]) delete env[name];
  }
});

test("the Sites reader keeps id-only requests authenticated without a profile", () => {
  assert.deepEqual(sites.sitesUserFrom(new Headers({ "oai-authenticated-user-id": "u1" })), { userId: "u1", email: null, displayName: null, fullName: null });
  assert.deepEqual(sites.sitesUserFrom(new Headers({ "oai-authenticated-user-id": "u1", "oai-authenticated-user-email": "e@example.test",
    "oai-authenticated-user-full-name": "Ada%20L", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" })),
  { userId: "u1", email: "e@example.test", displayName: "Ada L", fullName: "Ada L" });
  assert.equal(sites.sitesUserFrom(new Headers()), null);
});
