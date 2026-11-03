import test from "node:test";
import assert from "node:assert/strict";
import { deploymentTargetGuard } from "../../tooling/vite/deployment-target-guard.mjs";

const HEADER = "oai-authenticated-user-id";
// Run the guard's generateBundle hook the way Vite does, collecting the build error it raises.
const check = (target, bundle) => {
  const errors = [];
  deploymentTargetGuard(target).generateBundle.call({ error: message => { errors.push(message); throw new Error(message); } }, {}, bundle);
  return errors;
};
const chunk = code => ({ type: "chunk", code });
const asset = source => ({ type: "asset", source });

test("a cloudflare build fails when code or a served asset reads the Sites identity headers", () => {
  assert.throws(() => check("cloudflare", { "auth.js": chunk(`headers.get("${HEADER}")`) }), /auth\.js still reads Sites identity headers/);
  assert.throws(() => check("cloudflare", { "data.json": asset(`{"h":"${HEADER}"}`) }), /data\.json still reads Sites identity headers/);
});

test("source maps may embed the tree-shaken Sites module; they execute nothing", () => {
  assert.deepEqual(check("cloudflare", { "auth.js": chunk("export {}"), "auth.js.map": asset(`{"sourcesContent":["${HEADER}"]}`) }), []);
});

test("the sites build is not checked", () => {
  assert.deepEqual(check("sites", { "auth.js": chunk(`headers.get("${HEADER}")`) }), []);
});
