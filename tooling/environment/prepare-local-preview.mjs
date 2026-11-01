import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./project-root.mjs";

/** Generate an ignored local entrypoint; the deployable build and its bindings remain the source of truth. */
export function prepareLocalPreview(configPath, directory) {
  const original = JSON.parse(readFileSync(configPath, "utf8")), base = path.dirname(configPath);
  mkdirSync(directory, { recursive: true });
  // keepNames adds __name calls inside functions serialized into inline browser scripts.
  const config = { ...original, no_bundle: false, keep_names: false, main: path.join(directory, "entry.mjs") };
  const importPath = file => JSON.stringify(file.replaceAll("\\", "/"));
  const main = importPath(path.resolve(base, original.main));
  const drain = importPath(path.join(projectRoot, "tooling/environment/preview-request-drain.mjs"));
  writeFileSync(config.main, `import worker from ${main};\nimport { previewFetch } from ${drain};\nexport * from ${main};\nexport default { ...worker, fetch(request, env, context) { return previewFetch(worker, request, env, context); } };\n`);
  if (original.assets?.directory) config.assets = { ...original.assets, directory: path.resolve(base, original.assets.directory) };
  if (original.build?.watch_dir) config.build = { ...original.build, watch_dir: Array.isArray(original.build.watch_dir)
    ? original.build.watch_dir.map(file => path.resolve(base, file)) : path.resolve(base, original.build.watch_dir) };
  if (original.d1_databases) config.d1_databases = original.d1_databases.map(binding => ({ ...binding,
    ...(binding.migrations_dir ? { migrations_dir: path.resolve(base, binding.migrations_dir) } : {}) }));
  const file = path.join(directory, "wrangler.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
