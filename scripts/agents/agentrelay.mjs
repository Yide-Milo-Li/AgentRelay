// Stable source/Release entrypoint. In a checkout it installs the client outside the checkout and hands over to it.
import { fileURLToPath } from "node:url";
import { runEntry } from "../../tooling/agents/client-bootstrap.mjs";
await runEntry(process.argv.slice(2), fileURLToPath(new URL("../../", import.meta.url)));
