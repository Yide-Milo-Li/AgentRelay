// Test-only loader: transpiles a TypeScript module and the local modules it imports (including the `@/` alias)
// into a temporary directory, so unit tests exercise the production rules without a bundler or a new dependency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { projectRoot } from "../../tooling/environment/project-root.mjs";

const LOCAL_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(@\/[^"']+|\.{1,2}\/[^"']+)\2/g;

function resolveLocal(from, specifier) {
  const base = specifier.startsWith("@/") ? path.join(projectRoot, "src", specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
  // Plain JavaScript modules (shared with Node tooling) are imported in place, without transpiling.
  if (/\.m?js$/.test(base) && fs.existsSync(base)) return base;
  const found = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve ${specifier} from ${from}`);
  return found;
}

const workspaces = new Map();

/**
 * `entry` is a repository-relative path such as `src/shared/formatting/device-identity.ts`.
 * `stubs` maps a bare specifier (for example `cloudflare:workers`) to an absolute module path that replaces it.
 * Modules that import packages must be emitted inside the project so Node can resolve `node_modules`; pass `inProject`.
 */
export async function loadTypeScriptModule(entry, { stubs = {}, inProject = false } = {}) {
  // Loads with the same options share emitted modules, so a class imported twice is one class (instanceof keeps working).
  const key = `${inProject}|${JSON.stringify(stubs)}`;
  if (!workspaces.has(key)) {
    const parent = inProject ? path.join(projectRoot, "outputs", "unit-modules") : os.tmpdir();
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, "agentrelay-ts-"));
    process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
    workspaces.set(key, { output: directory, emitted: new Map() });
  }
  const { output, emitted } = workspaces.get(key);
  function emit(file) {
    if (emitted.has(file)) return emitted.get(file);
    const target = path.join(output, path.relative(projectRoot, file).replace(/\.tsx?$/, ".mjs"));
    emitted.set(file, target);
    const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    let transformed = outputText;
    for (const [specifier, target] of Object.entries(stubs)) {
      transformed = transformed.replaceAll(`"${specifier}"`, JSON.stringify(pathToFileURL(target).href)).replaceAll(`'${specifier}'`, JSON.stringify(pathToFileURL(target).href));
    }
    const code = transformed.replace(LOCAL_IMPORT, (_match, lead, quote, specifier) => {
      const target = resolveLocal(file, specifier);
      return `${lead}${quote}${pathToFileURL(/\.m?js$/.test(target) ? target : emit(target)).href}${quote}`;
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
    return target;
  }
  return import(pathToFileURL(emit(path.join(projectRoot, entry))).href);
}
