// Compatibility command: all new setup uses the shared credential client.
import { main } from "../../tooling/agents/client.mjs";
const args = process.argv.slice(2);
if (args.some(arg => ["--skip-verify", "--skip-register"].includes(arg))) {
  console.error("AgentRelay: legacy skip flags are no longer supported. Use the command from your Site; setup verifies identity before changing files.");
  process.exitCode = 1;
} else {
  const mapped = args.flatMap(arg => arg === "--persist-env" ? ["--storage", "env"] : [arg]);
  console.error("AgentRelay: connect-device.mjs now forwards to the local credential client. Existing credentials are retained until you revoke them.");
  await main(["connect", ...(args.includes("--profile") ? [] : ["--profile", "claude-code"]), ...mapped]);
}
