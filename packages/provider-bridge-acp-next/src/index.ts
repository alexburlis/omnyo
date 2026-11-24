export { experimental_providerBridge as acpProviderBridge } from "./bridge/bridge.js";

export { registerAcpDialect } from "./dialect.js";

export type {
  AcpClientRequestOutcome,
  AcpDelegationReport,
  AcpDialect,
  AcpToolIdentity,
} from "./dialect.js";

export { acpAgentProbeSchema, probeAcpAgent } from "./probe.js";

export type { AcpAgentProbe, AcpAgentProbeRequest } from "./probe.js";

export {
  acpLaunchSpecSchema,
  type AcpLaunchSpec,
} from "@omnyo/provider-bridge-protocol/acp/launch-spec";

export type { AcpClassifiedToolCall } from "@omnyo/provider-bridge-protocol/acp/tool-classification";

export type {
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolCallUpdateEvent,
  AcpToolKind,
} from "./wire.js";

export type { AgentModelCatalog } from "./bridge/model-catalog.js";
