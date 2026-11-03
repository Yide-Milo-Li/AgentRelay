// The Site's gateway token (Sites calls it siwc_bypass_bearer_token): one credential shared by every connection to a
// Site, stored per Site origin. It only gets requests past the Sites sign-in gate; it carries no identity and grants
// nothing inside AgentRelay without an Agent Token. It is never printed: it goes to the OS store, an isolated
// environment variable, or the clipboard tool's stdin. A deployment whose agent path has no such gate (a standalone
// Cloudflare deployment lets /api/agent/* bypass Access) needs none, and its connections store no gateway reference.
import { spawnSync } from "node:child_process";
import { ClientError, credentialRefs, envName } from "./credential-store.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ENDPOINT_SUFFIX = "/api/agent/mcp";
// What AgentRelay answers a request that carries no Agent Token. Seeing it proves the request got past the gate.
const NO_AGENT_TOKEN = "A valid personal Agent Token is required.";

/** The Site origin from a Site URL or its Agent MCP endpoint, as the connect command prints it. */
export function siteOrigin(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ClientError("Pass the Site's URL with --url, for example https://<your-site>.chatgpt.site or https://agentrelay.<subdomain>.workers.dev."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new ClientError("Use the Site URL without credentials, query parameters or fragments.");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) throw new ClientError("Use the Site's HTTPS URL.");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== ENDPOINT_SUFFIX) throw new ClientError(`Use the Site URL, or its ${ENDPOINT_SUFFIX} endpoint.`);
  return parsed.origin;
}

/** Where the gateway token of `origin` lives: the OS store entry, or the isolated variable for `--storage env`. */
export function gatewayRef(origin) {
  const ref = credentialRefs(origin, "gateway").gateway;
  return { ref, variable: envName(ref) };
}

/** A gateway token as entered or piped: one line of printable text. */
export function validGateway(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > 4096 || /[\x00-\x1f\x7f\s]/.test(token)) throw new ClientError("Enter this Site's gateway token: one line, without spaces.");
  return token;
}

/** Ask the Site's connection diagnostic without an Agent Token: whether AgentRelay itself answered, and the status. */
async function reachesAgentRelay(origin, headers, fetchImpl) {
  let response, body;
  try {
    response = await fetchImpl(new URL("/api/agent/connection", origin), { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    body = await response.json().catch(() => null);
  } catch { throw new ClientError(`Could not reach ${origin}. Check the URL and the network.`); }
  return { reached: response.status === 401 && body?.error === NO_AGENT_TOKEN, status: response.status };
}

/**
 * Whether `origin` needs a gateway token: false only when a request without one reaches AgentRelay's own answer to a
 * missing Agent Token. A sign-in gate answers differently, so anything else keeps the gateway flow.
 */
export async function needsGateway(origin, fetchImpl = fetch) {
  return !(await reachesAgentRelay(origin, {}, fetchImpl)).reached;
}

/**
 * Ask the Site whether it lets a request with this gateway token through, without an Agent Token. Only AgentRelay's
 * own answer to a missing Agent Token counts as accepted; anything else means the gate (or something else) stopped it.
 */
export async function checkGateway(origin, token, fetchImpl = fetch) {
  const { reached, status } = await reachesAgentRelay(origin, { "OAI-Sites-Authorization": `Bearer ${token}` }, fetchImpl);
  if (reached) return;
  throw new ClientError(`The Site did not accept this gateway token (HTTP ${status}). Check that it is the current token of ${origin}; nothing was saved.`);
}

/** Read the saved gateway token of `origin`, or null. */
export function savedGateway(origin, { storage = "os", vault, env = process.env } = {}) {
  const { ref, variable } = gatewayRef(origin);
  return (storage === "env" ? env[variable] : vault.get(ref)) || null;
}

/** Clipboard tools by platform, each reading the text from stdin. */
const CLIPBOARD = {
  win32: [["clip.exe", []]],
  darwin: [["pbcopy", []]],
  other: [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]],
};

/**
 * Put `text` on the system clipboard through the first tool that works. The text reaches the tool on stdin only: never
 * argv, stdout, stderr or a file. Without a working tool this fails rather than falling back to printing.
 */
export function copyToClipboard(text, { platform = process.platform, run = spawnSync } = {}) {
  for (const [command, args] of CLIPBOARD[platform] ?? CLIPBOARD.other) {
    const result = run(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, timeout: 10_000 });
    if (!result.error && result.status === 0) return command;
  }
  throw new ClientError("No clipboard tool worked on this device (clip.exe, pbcopy, wl-copy, xclip or xsel). Nothing was copied, and the token was not printed.");
}
