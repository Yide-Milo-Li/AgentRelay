// Stable CLI entrypoint; importing the implementation does not trigger its direct-execution guard.
import { exportSource, packageClient } from "../../tooling/agents/release-candidates.mjs";
const [command, target] = process.argv.slice(2);
if (!target || !["source", "client"].includes(command)) throw new Error("Usage: release-candidates.mjs source|client <new-output-directory>");
console.log(JSON.stringify(command === "source" ? exportSource(target) : packageClient(target), null, 2));
