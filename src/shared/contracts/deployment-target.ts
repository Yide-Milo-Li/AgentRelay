/** Which platform a build serves: ChatGPT Sites, or a standalone Cloudflare Worker behind Cloudflare Access. */
export type DeploymentTarget = "sites" | "cloudflare";

// Vite `define` replaces this name with a string literal at build time (see vite.config.ts). Outside a Vite build,
// such as in unit tests, the name is not defined and the target is `sites`.
declare const __AGENTRELAY_TARGET__: DeploymentTarget;

export const DEPLOYMENT_TARGET: DeploymentTarget =
  typeof __AGENTRELAY_TARGET__ !== "undefined" && __AGENTRELAY_TARGET__ === "cloudflare" ? "cloudflare" : "sites";
