// Download a handoff's images to local files and print their paths. Use it when an MCP image block does not arrive,
// or when the client saved it to a file the agent cannot open.
// Usage: node scripts/agents/download-attachments.mjs [--url <https://site/api/agent/mcp>] [--out <folder>] <handoffId>
// Environment: AGENTRELAY_MCP_URL (or --url), AGENTRELAY_AGENT_TOKEN, and AGENTRELAY_SITES_GATEWAY_TOKEN
// (Codex: AGENTRELAY_SITES_GATEWAY_HEADER). Stdout is one JSON object; diagnostics go to stderr and never contain a credential.
import { resolveSite } from "../../tooling/agents/device-setup.mjs";
import { agentTokenFrom, gatewayAuthorization } from "../../tooling/agents/upload-attachments.mjs";
import { downloadImages } from "../../tooling/agents/download-attachments.mjs";

const USAGE = "usage: node scripts/agents/download-attachments.mjs [--url <https://site/api/agent/mcp>] [--out <folder>] <handoffId>";
function fail(message) {
  console.error(`agentrelay download: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2), ids = [];
let url = process.env.AGENTRELAY_MCP_URL, outDir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help" || args[i] === "-h") { console.log(USAGE); process.exit(0); }
  else if (args[i] === "--url" || args[i] === "--out") {
    const value = args[++i];
    if (!value) fail(USAGE);
    if (args[i - 1] === "--url") url = value; else outDir = value;
  } else if (args[i].startsWith("--")) fail(USAGE);
  else ids.push(args[i]);
}
if (ids.length !== 1) fail(USAGE);
if (!url) fail("set AGENTRELAY_MCP_URL (or pass --url) to your Site's /api/agent/mcp endpoint.");

try {
  const { siteUrl } = resolveSite({ url });
  const result = await downloadImages({ handoffId: ids[0], siteUrl, agentToken: agentTokenFrom(), authorization: gatewayAuthorization(), outDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : "download failed");
}
