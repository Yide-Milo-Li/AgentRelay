// The `cloudflare` dev server's local sign-in: which requests get a token, and that the Worker's own verifier accepts it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { projectRoot } from "../../tooling/environment/project-root.mjs";
import { loadTypeScriptModule } from "../support/load-typescript-module.mjs";
import { LOCAL_ACCESS_USER, localAccess } from "../../tooling/vite/local-access-plugin.mjs";

globalThis.__AGENTRELAY_TARGET__ = "cloudflare";
const support = file => path.join(projectRoot, "tests/support", file);
const access = await loadTypeScriptModule("src/server/auth/cloudflare-access.ts", {
  stubs: { "cloudflare:workers": support("cloudflare-workers-stub.mjs"), "next/headers": support("next-auth-stub.mjs"), "next/navigation": support("next-auth-stub.mjs") }, inProject: true,
});

const local = await localAccess();
let middleware;
local.plugin.configureServer({ config: { logger: { info: () => {} } }, middlewares: { use: handler => { middleware = handler; } } });
// Run one request through the middleware, the way Vite's connect stack does, and return the token the Worker would see.
function signIn({ host = "localhost:5173", remoteAddress = "127.0.0.1", sent } = {}) {
  const headers = { host, ...(sent ? { "cf-access-jwt-assertion": sent } : {}) };
  const request = { headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress } };
  let called = false;
  middleware(request, {}, () => { called = true; });
  assert.ok(called, "the request continues to the Worker");
  const raw = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "cf-access-jwt-assertion");
  assert.ok(raw.length <= 1, "the raw headers hold at most one token");
  return request.headers["cf-access-jwt-assertion"] ?? null;
}

test("a request from this machine gets a token the Worker's verifier accepts for the local person", async () => {
  const config = access.accessConfigFrom({ AGENTRELAY_ACCESS_TEAM_DOMAIN: local.vars.AGENTRELAY_ACCESS_TEAM_DOMAIN, AGENTRELAY_ACCESS_AUD: local.vars.AGENTRELAY_ACCESS_AUD, AGENTRELAY_ACCESS_CERTS_URL: local.vars.AGENTRELAY_ACCESS_CERTS_URL });
  for (const host of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173"]) {
    const token = signIn({ host, remoteAddress: host.startsWith("[") ? "::1" : "127.0.0.1" });
    assert.deepEqual(await access.verifyAccessToken(token, config), LOCAL_ACCESS_USER, host);
  }
});

test("a token the client sent is always replaced or dropped, never forwarded", () => {
  const forged = "header.payload.signature";
  assert.notEqual(signIn({ sent: forged }), forged);
  assert.equal(signIn({ host: "relay.example.com", sent: forged }), null);
  assert.equal(signIn({ remoteAddress: "192.168.1.20", sent: forged }), null);
});

test("only the dev server uses it", () => {
  assert.equal(local.plugin.apply, "serve");
  assert.match(local.vars.AGENTRELAY_ACCESS_CERTS_URL, /^http:\/\/127\.0\.0\.1:\d+\/cdn-cgi\/access\/certs$/);
});
