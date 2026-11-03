// A local stand-in for Cloudflare Access, for the `cloudflare` build target on this machine only: a signing key made
// per process, its public key served on loopback the way a team domain serves `/cdn-cgi/access/certs`, and Access
// application tokens signed with it. The Worker trusts it only through AGENTRELAY_ACCESS_CERTS_URL, a variable that
// only whoever runs the Worker can set. Used by the dev server's local sign-in and by the integration tests.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";

export const LOCAL_ACCESS_TEAM = "https://agentrelay-test.cloudflareaccess.com";
export const LOCAL_ACCESS_AUD = "0123456789abcdef".repeat(4);
const KEY_ID = "agentrelay-test-key";
export const LOCAL_TOKEN_LIFETIME_SECONDS = 3600;

export function createAccessKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    jwk: { ...publicKey.export({ format: "jwk" }), kid: KEY_ID, alg: "RS256", use: "sig" },
  };
}

/** Serve `{ keys: [jwk] }` on loopback, the way a team domain serves `/cdn-cgi/access/certs`. */
export async function startJwksServer(jwk) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  // Unref'd so a dev server or test runner can exit without closing it.
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}/cdn-cgi/access/certs`, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Worker variables for a `cloudflare` Worker that trusts the local key. */
export const accessWorkerVars = certsUrl => ({
  AGENTRELAY_ACCESS_TEAM_DOMAIN: LOCAL_ACCESS_TEAM, AGENTRELAY_ACCESS_AUD: LOCAL_ACCESS_AUD, AGENTRELAY_ACCESS_CERTS_URL: certsUrl,
});

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Sign an Access application token. `claims` overrides the defaults; `header` overrides alg, kid or typ. */
export function mintAccessToken(privateKeyPem, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: "RS256", kid: KEY_ID, typ: "JWT", ...header });
  const body = encode({ iss: LOCAL_ACCESS_TEAM, aud: [LOCAL_ACCESS_AUD], type: "app", iat: now, nbf: now, exp: now + LOCAL_TOKEN_LIFETIME_SECONDS, ...claims });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), createPrivateKey(privateKeyPem)).toString("base64url");
  return `${head}.${body}.${signature}`;
}
