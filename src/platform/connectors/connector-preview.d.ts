declare module "virtual:sites-connector-preview" {
  const binding: import("@/platform/connectors/connector-contract.mjs").ConnectorBinding;
  export default binding;
}

// Only the local preview uses an environment binding. Hosted Sites receive the
// request-scoped capability through ctx.props.CONNECTORS in worker/index.ts.
declare namespace Cloudflare {
  interface Env {
    CONNECTORS?: import("@/platform/connectors/connector-contract.mjs").ConnectorBinding;
  }
}
