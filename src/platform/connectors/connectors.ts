import { createConnectors } from "@/platform/connectors/connector-contract.mjs";
import { getConnectorBinding } from "@/platform/connectors/connector-context";

/** Keep invocation context on this request; never cache it across visitors. */
export function connectorsForRequest() {
  return createConnectors(getConnectorBinding());
}
export type {
  ConnectorContext,
  ConnectorResult,
  ConnectorFailureStatus,
  Json,
} from "@/platform/connectors/connector-contract.mjs";
