// The build's deployment target, read from AGENTRELAY_TARGET: `sites` (the default) or `cloudflare`.
export const DEPLOYMENT_TARGETS = ["sites", "cloudflare"];

export function readDeploymentTarget(value = process.env.AGENTRELAY_TARGET) {
  const target = (value ?? "").trim() || "sites";
  if (!DEPLOYMENT_TARGETS.includes(target)) {
    throw new Error(`AGENTRELAY_TARGET must be "sites" or "cloudflare", not "${target}".`);
  }
  return target;
}
