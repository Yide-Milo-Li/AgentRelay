// Generate a VAPID key pair to set as a Site's runtime values. Optional: without them the Worker makes and stores its own pair.
// Usage: node scripts/notifications/generate-vapid.mjs --subject <https://your-site | mailto:you@example.com> [--out <file outside the repository>]
// Without --out the four runtime values are printed once to stdout. With --out they are written to a new file that only you can
// read, and only the public key is printed. The private key is a secret: it is never logged, and the file is refused inside this checkout.
import { formatEnv, generateVapid, vapidSubjectOf, writeEnvFile } from "../../tooling/notifications/vapid.mjs";

const USAGE = "usage: node scripts/notifications/generate-vapid.mjs --subject <https://your-site | mailto:you@example.com> [--out <file outside the repository>]";
function fail(message) {
  console.error(`generate-vapid: ${message}`);
  process.exit(1);
}

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if ((name !== "--subject" && name !== "--out") || args[index + 1] === undefined || args[index + 1].startsWith("--")) fail(USAGE);
  options[name.slice(2)] = args[++index];
}
let subject;
try { subject = vapidSubjectOf(options.subject); } catch (error) { fail(`${error.message}\n${USAGE}`); }

const values = await generateVapid(subject);
if (options.out) {
  try { const file = writeEnvFile(options.out, values); console.log(`AGENTRELAY_VAPID_PUBLIC_KEY=${values.AGENTRELAY_VAPID_PUBLIC_KEY}\nSaved all four values to ${file}`); }
  catch (error) { fail(error.message); }
} else {
  console.log(formatEnv(values).trimEnd());
  console.error("The private key above is a secret. Store it only in the Site's runtime configuration, never in the repository. Keep one pair for the life of the Site where you can: after a change each browser subscribes again on its next visit, and pushes sent in between are lost.");
}
