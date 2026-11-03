// Local sign-in for the `cloudflare` dev server, standing in for Cloudflare Access in front of the Worker. A request
// from this machine to a loopback host gets an Access token for one local person; a token the client sent is always
// dropped first, as Access replaces it. The Worker trusts the key only through the variables `localAccess()` returns,
// which vite.config.ts passes to the dev Worker alone.
import { LOCAL_TOKEN_LIFETIME_SECONDS, accessWorkerVars, createAccessKey, mintAccessToken, startJwksServer } from "../environment/local-access.mjs";

const HEADER = "cf-access-jwt-assertion";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const LOCAL_ACCESS_USER = { sub: "local-access", email: "local@access.test" };

/** Both the request header and its raw copy, which the Cloudflare plugin forwards. */
function setHeader(request, value) {
  delete request.headers[HEADER];
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === HEADER) request.rawHeaders.splice(index, 2);
  }
  if (value === null) return;
  request.headers[HEADER] = value;
  request.rawHeaders.push(HEADER, value);
}

export async function localAccess() {
  const key = createAccessKey(), jwks = await startJwksServer(key.jwk);
  let token = null, renewAt = 0;
  // Renewed halfway through its lifetime, so a long dev session never sends an expired token.
  const current = () => {
    if (Date.now() >= renewAt) { token = mintAccessToken(key.privateKeyPem, LOCAL_ACCESS_USER); renewAt = Date.now() + LOCAL_TOKEN_LIFETIME_SECONDS * 500; }
    return token;
  };
  return {
    // A deployment always sets its workspace key (the deploy command generates one); the dev Worker does too.
    vars: { ...accessWorkerVars(jwks.url), AGENTRELAY_WORKSPACE_OWNER_ID: "workspace-local" },
    plugin: {
      name: "agentrelay-local-access",
      apply: "serve",
      configureServer(server) {
        server.config.logger.info(`Cloudflare Access local sign-in: ${LOCAL_ACCESS_USER.email}`);
        server.middlewares.use((request, _response, next) => {
          const host = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
          setHeader(request, LOCAL_HOSTS.has(host) && LOCAL_ADDRESSES.has(request.socket.remoteAddress ?? "") ? current() : null);
          next();
        });
      },
    },
  };
}
