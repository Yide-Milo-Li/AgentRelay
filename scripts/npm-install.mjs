// Preserve the legacy CLI and named library exports without spawning a child process.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../tooling/installers/npm-install.mjs";
export * from "../tooling/installers/npm-install.mjs";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
