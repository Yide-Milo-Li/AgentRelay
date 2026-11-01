import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { prepareLocalPreview } from "./prepare-local-preview.mjs";

/** Serve the built Worker in one workerd instance, without Wrangler's idle-racing HTTP proxy hop. */
export async function startDirectLocalPreview({ configPath, directory, stateDir, host = "127.0.0.1", port = 0, vars = {}, drainBody = true }) {
  const prepared = drainBody ? prepareLocalPreview(path.resolve(configPath), directory) : path.resolve(configPath);
  const config = JSON.parse(readFileSync(prepared, "utf8"));
  const { workerOptions, main, define, externalWorkers } = unstable_getMiniflareWorkerOptions(prepared);
  const bundle = await build({
    entryPoints: [main], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], define, keepNames: false,
  });
  // The v5 converter needs explicit modules. The complete import graph is already bundled above.
  delete workerOptions.modulesRules;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host, port, cf: false, logRequests: true, resourceTmpPath: path.join(directory, "tmp"),
    // Wrangler CLI fixtures use the same v3 D1/R2 store, including shared/private preview pairs.
    resourcePersistencePath: path.join(path.resolve(stateDir), "v3"),
    workers: [{ ...workerOptions, name: config.name, bindings: { ...workerOptions.bindings, ...vars },
      modules: [{ type: "ESModule", path: main, contents: bundle.outputFiles[0].text }] }, ...externalWorkers],
  }));
  try {
    const url = await runtime.ready;
    return { url, dispose: () => runtime.dispose(),
      // Test fixtures must use this runtime's bindings instead of opening a second workerd on its SQLite files.
      getD1Database: () => runtime.getD1Database("DB", config.name),
      getR2Bucket: () => runtime.getR2Bucket("BUCKET", config.name),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
