import { mkdirSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./project-root.mjs";
export { projectRoot };
import { configureToolEnvironment } from "./tool-environment.mjs";
import { assertSupportedNodeRuntime } from "./node-runtime.mjs";

assertSupportedNodeRuntime();
configureToolEnvironment(projectRoot);

process.chdir(projectRoot);
for (const directory of [
  path.dirname(process.env.WRANGLER_LOG_PATH),
  process.env.WRANGLER_REGISTRY_PATH,
  process.env.MINIFLARE_REGISTRY_PATH,
]) {
  mkdirSync(directory, { recursive: true });
}
