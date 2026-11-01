import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { projectRoot } from "./environment/project-root.mjs";
import { readExecutionProfile } from "./environment/execution-profile.mjs";
import { assertSupportedNodeRuntime } from "./environment/node-runtime.mjs";

assertSupportedNodeRuntime();
const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = pathToFileURL(path.join(projectRoot, managedLinux
  ? "node_modules/vite/bin/vite.js"
  : "node_modules/vinext/dist/cli.js"));
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
