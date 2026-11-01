// Upload local images for a handoff and print the ordered attachment IDs for create_handoff.
// Usage: node scripts/agents/upload-attachments.mjs [--url <https://site/api/agent/mcp>] [--retry-key <prefix>] <image> [<image> ...]
// Environment: AGENTRELAY_MCP_URL (or --url), AGENTRELAY_AGENT_TOKEN, and AGENTRELAY_SITES_GATEWAY_TOKEN
// (Codex: AGENTRELAY_SITES_GATEWAY_HEADER). Stdout is one JSON object; diagnostics go to stderr and never contain a credential.
import { resolveSite } from "../../tooling/agents/device-setup.mjs";
import { UploadError, agentTokenFrom, gatewayAuthorization, uploadImages } from "../../tooling/agents/upload-attachments.mjs";

const USAGE = "usage: node scripts/agents/upload-attachments.mjs [--url <https://site/api/agent/mcp>] [--retry-key <prefix>] <image> [<image> ...]";
function fail(message) {
  console.error(`agentrelay upload: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2), files = [];
let url = process.env.AGENTRELAY_MCP_URL, retryKey;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help" || args[i] === "-h") { console.log(USAGE); process.exit(0); }
  else if (args[i] === "--url" || args[i] === "--retry-key") {
    const value = args[++i];
    if (!value) fail(USAGE);
    if (args[i - 1] === "--url") url = value; else retryKey = value;
  } else if (args[i].startsWith("--")) fail(USAGE);
  else files.push(args[i]);
}
if (retryKey !== undefined && (!/^[\x21-\x7e]{1,100}$/.test(retryKey))) fail("--retry-key must be 1–100 printable characters without spaces.");
if (!url) fail("set AGENTRELAY_MCP_URL (or pass --url) to your Site's /api/agent/mcp endpoint.");

try {
  const { siteUrl } = resolveSite({ url });
  const key = retryKey ?? `cli-${crypto.randomUUID()}`;
  const attachments = await uploadImages({ files, siteUrl, agentToken: agentTokenFrom(), authorization: gatewayAuthorization(), retryKey: key });
  process.stdout.write(`${JSON.stringify({ attachmentIds: attachments.map((item) => item.id), attachments, retryKey: key })}\n`);
} catch (error) {
  fail(error instanceof UploadError || error instanceof Error ? error.message : "upload failed");
}
