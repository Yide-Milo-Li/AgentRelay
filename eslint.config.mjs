import "./tooling/lint/legacy-minimatch-compat.mjs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    "dist/**",
    ".vinext/**",
    ".wrangler/**",
    ".sites-runtime/**",
    "outputs/**",
    ".local/**",
    "work/**",
    "scratch/**",
  ]),
  {
    files: ["src/**/*.{ts,tsx,mts}", "worker/**/*.ts"],
    ignores: ["src/platform/connectors/connector-context.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "Runtime modules must remain Workers-compatible. Put Node tools in tooling/." }] }],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/shared/**/*.{ts,mts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["node:*", "@/server", "@/server/**", "@/platform", "@/platform/**"], message: "Browser modules must use shared contracts and server endpoints." }] }],
    },
  },
  {
    files: ["src/components/ui/**/*.{ts,tsx}", "src/shared/hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
