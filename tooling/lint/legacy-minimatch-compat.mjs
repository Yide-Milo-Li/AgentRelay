import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const legacyPlugins = ["eslint-plugin-import", "eslint-plugin-jsx-a11y", "eslint-plugin-react"];

// These plugins call the old CommonJS function export. Keep the patched v11
// implementation and expose its named API through the older callable shape.
for (const name of legacyPlugins) {
  const pluginRequire = createRequire(require.resolve(name));
  const entry = pluginRequire.resolve("minimatch");
  const api = pluginRequire("minimatch");
  if (typeof api === "function") continue;
  if (typeof api.minimatch !== "function" || typeof api.Minimatch !== "function") {
    throw new Error(`Unsupported minimatch API used by ${name}.`);
  }
  const callable = (...args) => api.minimatch(...args);
  Object.assign(callable, api);
  // import/no-internal-modules only calls .test() on makeRe's result; v11
  // removed regex generation, so use its matcher for the same predicate.
  callable.makeRe = (pattern, options) => {
    const matcher = new api.Minimatch(pattern, options);
    return { test: value => matcher.match(value) };
  };
  require.cache[entry].exports = callable;
}
