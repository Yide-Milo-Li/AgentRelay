import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import { projectRoot } from "../environment/project-root.mjs";

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const runtime = file => file.startsWith("src/") || file.startsWith("worker/");
const pure = file => /^src\/shared\/(contracts|i18n|errors|formatting|images)\//.test(file);
const feature = file => /^src\/features\/([^/]+)\//.exec(file)?.[1];
const serverArea = file => /^src\/server\/([^/]+)\//.exec(file)?.[1];
const codeFile = file => /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file);

/** Resolve aliases and relative paths before applying rules, so spelling cannot bypass ownership. */
function resolveLocal(file, specifier, sources) {
  const base = specifier.startsWith("@/") ? `src/${specifier.slice(2)}`
    : specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : null;
  if (!base) return null;
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".mjs", ".js", ".json", ".css"].map(ext => base + ext),
    ...[".ts", ".tsx", ".mts", ".mjs", ".js"].map(ext => `${base}/index${ext}`)];
  if (base.endsWith(".mjs")) candidates.push(base.slice(0, -4) + ".mts");
  if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
  return candidates.find(candidate => sources.has(candidate)) ?? { missing: base };
}

function boundaryError(from, to) {
  if (runtime(from) && !runtime(to)) return "runtime code cannot import tooling, scripts, tests, or root implementation files";
  if (!runtime(from)) return null;
  if (pure(from) && !pure(to)) return "pure shared modules cannot depend on UI, browser helpers, server, or platform adapters";
  const common = from.startsWith("src/components/") || from.startsWith("src/shared/");
  if (common && !to.startsWith("src/shared/") && !to.startsWith("src/components/")) return "shared code and common UI cannot depend on features, server, or runtime platform adapters";
  const ownFeature = feature(from), targetFeature = feature(to);
  if (ownFeature) {
    if (targetFeature && targetFeature !== ownFeature) return "features cannot import another feature";
    if (!targetFeature && !to.startsWith("src/shared/") && !to.startsWith("src/components/")) return "features can only use their own internals, common UI, and shared code";
  }
  if (targetFeature && targetFeature !== ownFeature && to !== `src/features/${targetFeature}/index.ts`) return "cross-module feature imports must use its public index";
  const area = serverArea(from), targetArea = serverArea(to);
  if (area) {
    if (to.startsWith("src/shared/")) return pure(to) ? null : "server code may only import pure shared modules";
    const allowed = {
      core: ["core"], http: ["http", "core"], db: ["db"],
      devices: ["devices", "core", "db"], attachments: ["attachments", "core", "db"],
      projects: ["projects", "core", "db"],
      handoffs: ["handoffs", "core", "db", "devices", "attachments", "projects"], "agent-tokens": ["agent-tokens", "core", "db", "devices"],
      auth: ["auth", "core", "agent-tokens"], mcp: ["mcp", "http", "core", "handoffs", "attachments"],
      // The one place that may compose the services that refer to a device; no service may import it.
      "device-lifecycle": ["device-lifecycle", "core", "db", "devices", "handoffs", "agent-tokens"],
      // The one place that combines agent connections with notifications, for expiry reminders; no service may import it.
      "connection-reminders": ["connection-reminders", "core", "agent-tokens", "handoffs"],
    };
    if (!targetArea || !allowed[area]?.includes(targetArea)) return "server dependency direction is not allowed";
    if (["handoffs", "agent-tokens", "devices", "attachments", "projects", "device-lifecycle", "connection-reminders"].includes(targetArea) && area !== targetArea && to !== `src/server/${targetArea}/index.ts`) return "call another service through its public index";
  }
  if (from.startsWith("src/platform/") && !to.startsWith("src/platform/") && !pure(to)) return "platform adapters cannot import feature, service, UI, or development implementations";
  if (from.startsWith("worker/") && !to.startsWith("src/platform/")) return "Worker bootstrap may only compose platform adapters";
  if (from.startsWith("src/app/") && (to.startsWith("src/server/db/") || to.startsWith("worker/"))) return "route composition must use server operations rather than storage or Worker bootstrap";
  return null;
}

/** Analyze a supplied source map so tests exercise real resolution and AST traversal without disk fixtures. */
export function analyzeSources(sources) {
  const errors = [];
  const graph = new Map();
  const clients = new Set();
  for (const [file, text] of sources) {
    if (!codeFile(file)) continue;
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (ast.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client")) clients.add(file);
    const imports = [];
    const report = message => errors.push(`${file}: ${message}`);
    function visit(node) {
      let argument;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) argument = node.moduleSpecifier;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) argument = node.argument.literal;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        argument = node.arguments[0];
        if ((!argument || !ts.isStringLiteralLike(argument)) && runtime(file)) report("computed runtime imports require an explicit reviewed adapter");
      }
      if (argument && ts.isStringLiteralLike(argument)) imports.push(argument.text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    graph.set(file, []);
    for (const specifier of imports) {
      if (runtime(file) && (specifier.startsWith("node:") || builtins.has(specifier))) {
        // Existing request context relies on Workers nodejs_compat. Keep this exception exact.
        if (!(file === "src/platform/connectors/connector-context.ts" && specifier === "node:async_hooks")) report(`Node builtin is forbidden in runtime code: ${specifier}`);
      }
      if (pure(file) && /^(react(?:\/|$)|next(?:\/|$)|drizzle-orm(?:\/|$)|cloudflare:)/.test(specifier)) report(`pure shared module imports an environment-specific dependency: ${specifier}`);
      const target = resolveLocal(file, specifier, sources);
      if (!target) continue;
      if (target.missing) {
        // Assets have their own bundler validation; missing code imports are architecture failures.
        if (!/\.(css|svg|png|woff2?)$/.test(target.missing)) report(`unresolved local import: ${specifier}`);
        continue;
      }
      graph.get(file).push(target);
      const failure = boundaryError(file, target);
      if (failure) report(`${failure}: ${target}`);
    }
  }

  // Follow every import edge, including re-exports and type imports, from each client boundary.
  for (const client of clients) {
    const seen = new Set();
    function visit(file) {
      if (seen.has(file)) return;
      seen.add(file);
      if (file.startsWith("src/server/") || file.startsWith("src/platform/") || !runtime(file)) errors.push(`${client}: client import graph reaches a trusted or development module: ${file}`);
      for (const target of graph.get(file) ?? []) visit(target);
    }
    visit(client);
  }
  const visited = new Set(), active = new Set();
  function checkCycle(file, trail) {
    if (active.has(file)) { errors.push(`dependency cycle: ${[...trail, file].join(" -> ")}`); return; }
    if (visited.has(file)) return;
    visited.add(file); active.add(file);
    for (const target of graph.get(file) ?? []) if (runtime(target)) checkCycle(target, [...trail, file]);
    active.delete(file);
  }
  for (const file of graph.keys()) if (runtime(file)) checkCycle(file, []);
  return [...new Set(errors)];
}

export function checkRepository() {
  const sources = new Map();
  function collect(directory) {
    if (!fs.existsSync(path.join(projectRoot, directory))) return;
    for (const entry of fs.readdirSync(path.join(projectRoot, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(file);
      // Data files imported by runtime code (for example agent profiles) must resolve; they are not parsed.
      else if (codeFile(file) || directory.startsWith("src") && file.endsWith(".json")) sources.set(file, fs.readFileSync(path.join(projectRoot, file), "utf8"));
    }
  }
  for (const directory of ["src", "worker", "tooling", "scripts", "tests"]) collect(directory);
  const failures = analyzeSources(sources);
  for (const legacy of ["app", "components", "db", "hooks", "lib"]) if (fs.existsSync(path.join(projectRoot, legacy))) failures.push(`obsolete root source directory remains: ${legacy}`);
  if (failures.length) throw new Error(failures.join("\n"));
  return { files: sources.size, result: "passed" };
}
