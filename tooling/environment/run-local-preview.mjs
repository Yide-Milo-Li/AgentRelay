import path from "node:path";
import { parseArgs } from "node:util";
import { projectRoot } from "./sites-env.mjs";
import { startDirectLocalPreview } from "./direct-local-preview.mjs";

/** Own the preview lifecycle; an optional host hook lets test infrastructure share its existing bindings. */
export async function runLocalPreview({ onReady } = {}) {
  const { values } = parseArgs({ options: {
    config: { type: "string", default: path.join(projectRoot, "dist/server/wrangler.json") },
    "persist-to": { type: "string", default: process.env.AGENTRELAY_TEST_STATE ?? path.join(projectRoot, ".wrangler/state") },
    ip: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" },
    var: { type: "string", multiple: true, default: [] }, "no-drain": { type: "boolean", default: false },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535.");
  const vars = Object.fromEntries(values.var.map(value => {
    const separator = value.indexOf(":");
    if (separator < 1) throw new Error("--var requires NAME:value.");
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
  const directory = path.join(process.env.SITES_RUNTIME_ROOT ?? path.join(projectRoot, ".sites-runtime"), "local-preview", crypto.randomUUID());
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let preview, cleanupHost;
  try {
    preview = await startDirectLocalPreview({ configPath: values.config, directory, stateDir: values["persist-to"],
      host: values.ip, port, vars, drainBody: !values["no-drain"] });
    cleanupHost = await onReady?.(preview);
    console.log(`Local Worker ready on ${preview.url} (Miniflare direct; no request retries)`);
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await cleanupHost?.(); }
    finally { await preview?.dispose(); }
  }
}
