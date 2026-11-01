import "../../tooling/lint/legacy-minimatch-compat.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("legacy lint plugins can use patched minimatch functions, classes and Windows paths", () => {
  for (const name of ["eslint-plugin-import", "eslint-plugin-jsx-a11y", "eslint-plugin-react"]) {
    const pluginRequire = createRequire(require.resolve(name));
    const minimatch = pluginRequire("minimatch");
    assert.equal(typeof minimatch, "function");
    assert.equal(minimatch("src/features/Panel.tsx", "src/features/*.tsx"), true);
    assert.equal(minimatch("src/server/Panel.tsx", "src/features/*.tsx"), false);
    assert.equal(minimatch("src\\features\\Panel.tsx", "src/features/*.tsx", { platform: "win32", windowsPathsNoEscape: true }), true);
    assert.equal(minimatch.minimatch("src/features/Panel.tsx", "src/features/*.tsx"), true);
    assert.equal(new minimatch.Minimatch("src/features/*.tsx").match("src/features/Panel.tsx"), true);
    assert.equal(minimatch.makeRe("src/features/*.tsx").test("src/features/Panel.tsx"), true);
    assert.equal(minimatch.makeRe("src/features/*.tsx").test("src/server/Panel.tsx"), false);
  }
});

test("the real lint configuration retains boundaries and runs legacy plugin glob rules", () => {
  const probe = `
    const { ESLint } = require("eslint");
    (async () => {
      const eslint = new ESLint({ overrideConfig: { rules: {
        "react/jsx-pascal-case": ["error", { ignore: ["Bad*"] }],
        "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["Control*"], assert: "both" }],
        "import/no-internal-modules": ["error", { forbid: ["example/**"] }],
      } } });
      const source = [
        'import { useState } from "react";',
        'import { readFile } from "node:fs";',
        'import allowed from "react/private";',
        'import forbidden from "example/private";',
        'export function Example({ enabled }: { enabled: boolean }) {',
        '  if (enabled) useState(0);',
        '  return <><Bad_name /><Other_name /><label><ControlInput /></label></>;',
        '}',
      ].join("\\n");
      const [result] = await eslint.lintText(source, { filePath: "src/features/lint-probe.tsx" });
      console.log(JSON.stringify(result.messages.map(({ ruleId, message }) => ({ ruleId, message }))));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(result.error?.code, undefined);
  assert.equal(result.status, 0, result.stderr);
  const messages = JSON.parse(result.stdout);
  for (const rule of ["no-restricted-imports", "react-hooks/rules-of-hooks", "jsx-a11y/label-has-associated-control", "import/no-internal-modules"]) {
    assert.ok(messages.some(item => item.ruleId === rule), `${rule} must still report a violation`);
  }
  const names = messages.filter(item => item.ruleId === "react/jsx-pascal-case");
  assert.equal(names.length, 1, "the configured glob ignores Bad_name but not Other_name");
  assert.match(names[0].message, /Other_name/);
});
