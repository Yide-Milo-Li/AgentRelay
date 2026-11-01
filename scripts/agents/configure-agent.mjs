// Register the AgentRelay MCP connection with an agent, driven by its profile in
// src/shared/agent-profiles/profiles.json. Only environment-variable references enter configs or command arguments.
// Usage: node scripts/agents/configure-agent.mjs [--profile <id>] [--url <endpoint>] [--print] [--list]
import { findProfile, loadProfiles, renderProfileConfig, requireSecrets, resolveSite } from "../../tooling/agents/device-setup.mjs";

const usage = "Usage: node scripts/agents/configure-agent.mjs [--profile <id>] [--url <endpoint>] [--print] [--list]";
const profiles = loadProfiles();
const args = process.argv.slice(2);
let profileId = profiles[0].id, url, print = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--print") print = true;
  else if (args[index] === "--list") { for (const profile of profiles) console.log(`${profile.id}\t${profile.label}`); process.exit(0); }
  else if (args[index] === "--profile" && args[index + 1]) profileId = args[++index];
  else if (args[index] === "--url" && args[index + 1]) url = args[++index];
  else throw new Error(usage);
}
const profile = findProfile(profiles, profileId);
const { endpoint, siteUrl } = resolveSite({ url });
const config = renderProfileConfig(profile, siteUrl);

if (print) console.log(typeof config === "string" ? config : JSON.stringify(config, null, 2));
else {
  requireSecrets(profile);
  const { main } = await import("../../tooling/agents/client.mjs");
  await main(["connect", "--profile", profile.id, "--url", endpoint, "--from-env"]);
}
