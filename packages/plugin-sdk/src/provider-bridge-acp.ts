/**
 * `@omnyo/plugin-sdk/provider-bridge/acp` — the stable import path for the
 * original ACP kit exports, backed by the current ACP implementation.
 *
 * The Agent Client Protocol (https://agentclientprotocol.com) is one wire
 * protocol spoken by many agents, so Omnyo runs all of them through one generic
 * bridge: the agent to launch arrives per command in the provider options,
 * and nothing in the bridge is Omnyo-first-party. A plugin that wants to add an
 * ACP agent re-exports the bridge from its `omnyo.host` artifact and registers
 * its providers as any other plugin does:
 *
 * ```ts
 * // host.ts (the plugin's `omnyo.host` entry)
 * export { experimental_acpProviderBridge as experimental_providerBridge }
 *   from "@omnyo/plugin-sdk/provider-bridge/acp";
 *
 * // server.ts
 * api.providers.register({
 *   id: "amp",
 *   displayName: "Amp",
 *   experimental_bridgeOptions: {
 *     acpLaunchSpec: { displayName: "Amp", command: "amp", args: ["acp"], env: {} },
 *     acpDialect: "generic",
 *   },
 *   // …the rest of the declaration
 * })
 * ```
 *
 * **Dialects.** Version 1 of the protocol has no sub-agent concept and
 * standardizes nothing about `rawInput`, so what most distinguishes one
 * agent from another lives beside the protocol: grok stamps
 * `_meta["x.ai/tool"]` on every tool event, Cursor reports sub-agents
 * through a vendor `cursor/task` request. A dialect is a small module that
 * reads those channels. The built-in dialect IDs are `acp` (generic),
 * `cursor`, `grok`, `omp` and `opencode`. Set `acpDialect` in the
 * registration's bridge options. To register a custom dialect, import
 * `experimental_registerAcpDialect` from `provider-bridge/acp-next`.
 *
 * Curated by hand — named exports only, never `export *`. Value exports
 * carry the `experimental_` prefix every new plugin API member ships with
 * (see docs/api_to_audit.md); types are unprefixed. Exports no plugin
 * consumes are not published: the surface grows with a consumer, not ahead
 * of one.
 */
import type { AcpLaunchSpec } from "@omnyo/provider-bridge-acp-next";

export { acpProviderBridge as experimental_acpProviderBridge } from "@omnyo/provider-bridge-acp-next";

export type {
  AcpClassifiedToolCall,
  AcpClientRequestOutcome,
  AcpDelegationReport,
  AcpDialect,
  AcpToolIdentity,
} from "@omnyo/provider-bridge-acp-next";

export {
  acpAgentProbeSchema as experimental_acpAgentProbeSchema,
  probeAcpAgent as experimental_probeAcpAgent,
} from "@omnyo/provider-bridge-acp-next";

export type {
  AcpAgentProbe,
  AcpAgentProbeRequest,
} from "@omnyo/provider-bridge-acp-next";

export { acpLaunchSpecSchema as experimental_acpLaunchSpecSchema } from "@omnyo/provider-bridge-acp-next";

export type { AcpLaunchSpec } from "@omnyo/provider-bridge-acp-next";

/**
 * @deprecated The bridge reads the parsed `AcpLaunchSpec` directly; the
 * profile it used to derive from the spec carried the same fields under
 * other names, and nothing outside the bridge produced or consumed it. Kept
 * as an alias because 0.4.x published the name; scheduled for removal at the
 * next major (docs/api_to_audit.md).
 */
export type AcpAgentProfile = AcpLaunchSpec;

export type {
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolCallUpdateEvent,
  AcpToolKind,
} from "@omnyo/provider-bridge-acp-next";

export type { AgentModelCatalog as AcpAgentModelCatalog } from "@omnyo/provider-bridge-acp-next";
