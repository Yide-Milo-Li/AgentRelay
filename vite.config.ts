import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { readDeploymentTarget } from "./tooling/environment/deployment-target.mjs";
import { readExecutionProfile } from "./tooling/environment/execution-profile.mjs";
import { configureToolEnvironment } from "./tooling/environment/tool-environment.mjs";
import { sites } from "./tooling/vite/sites-vite-plugin";
import { connectorPreview } from "./tooling/vite/connector-preview-plugin.mjs";
import { deploymentTargetGuard } from "./tooling/vite/deployment-target-guard.mjs";
import { localAccess } from "./tooling/vite/local-access-plugin.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";
// `sites` (default) or `cloudflare`; see src/shared/contracts/deployment-target.ts.
const deploymentTarget = readDeploymentTarget();

const localBindingConfig = {
  main: "./worker/index.ts",
  // Toolchain upgrades must not silently enable newer runtime compatibility behavior.
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  configureToolEnvironment(process.cwd());

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  // The `cloudflare` dev server signs in through a local stand-in for Access, as the Sites mock does for `sites`.
  // Builds never get it: a deployed Worker trusts only its real Access team.
  const access = command === "serve" && deploymentTarget === "cloudflare" && !managedLinux ? await localAccess() : null;

  return {
    define: { __AGENTRELAY_TARGET__: JSON.stringify(deploymentTarget) },
    server: {
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      // The mock sign-in injects Sites identity headers, which only the `sites` target reads.
      sites({ mockAuth: !managedLinux && deploymentTarget === "sites" }),
      ...(access ? [access.plugin] : []),
      connectorPreview(),
      deploymentTargetGuard(deploymentTarget),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: {
          ...localBindingConfig,
          ...(command === "serve"
            ? {
                ...(access ? { vars: access.vars } : {}),
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(command === "serve"
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./tooling/connector-preview/worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
