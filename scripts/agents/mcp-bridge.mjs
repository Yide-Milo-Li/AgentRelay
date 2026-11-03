// Local stdio MCP server that relays to an AgentRelay Site. Point an agent that only runs local MCP servers (or cannot
// send custom headers) at this script; see docs/guides/local-bridge.md.
// Environment: AGENTRELAY_MCP_URL (or --url), AGENTRELAY_AGENT_TOKEN, and on ChatGPT Sites AGENTRELAY_SITES_GATEWAY_TOKEN.
// Stdout carries protocol messages only; every diagnostic goes to stderr and never contains a credential.
import { createInterface } from "node:readline";
import { requireSecrets, resolveSite } from "../../tooling/agents/device-setup.mjs";
import { createBridge } from "../../tooling/agents/mcp-bridge.mjs";

const SECRETS = { label: "the bridge", secrets: ["AGENTRELAY_AGENT_TOKEN"] };

function fail(message) {
  console.error(`agentrelay bridge: ${message}`);
  process.exit(1);
}

// --core-schemas and --initialize-only adjust the Site's answers for agents that need it (DeepSeek Harness):
// reduced tool parameter schemas, and a refused server/discover so the agent's SDK uses initialize.
const FLAGS = ["--core-schemas", "--initialize-only"];
const coreSchemas = process.argv.includes("--core-schemas"), initializeOnly = process.argv.includes("--initialize-only");
const args = process.argv.slice(2).filter((arg) => !FLAGS.includes(arg));
let url = process.env.AGENTRELAY_MCP_URL;
if (args.length === 2 && args[0] === "--url") url = args[1];
else if (args.length) fail("usage: node scripts/agents/mcp-bridge.mjs [--url <https://site/api/agent/mcp>] [--core-schemas] [--initialize-only]");
if (!url) fail("set AGENTRELAY_MCP_URL (or pass --url) to your Site's /api/agent/mcp endpoint.");

let endpoint;
try {
  ({ endpoint } = resolveSite({ url }));
  requireSecrets(SECRETS);
} catch (error) {
  fail(error.message);
}

const bridge = createBridge({
  endpoint,
  agentToken: process.env.AGENTRELAY_AGENT_TOKEN,
  gatewayToken: process.env.AGENTRELAY_SITES_GATEWAY_TOKEN?.trim() || null,
  coreSchemas,
  initializeOnly,
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => { void bridge.handle(line); });
// Let the event loop drain instead of calling process.exit(): on Windows, exiting while stdin is still closing
// aborts Node with a libuv assertion (exit code 0xC0000409).
lines.on("close", () => { void bridge.idle().then(() => { process.exitCode = 0; }); });
