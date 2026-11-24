import { loadCliConfig, type CliConfig } from "@omnyo/config/cli";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@omnyo/host-daemon-contract";
import { createGuideArea } from "./areas/guide.js";
import { createOmnyoSdk, type OmnyoSdk, type OmnyoSdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_CORE_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  OmnyoRealtimeSocketFactory,
  OmnyoSdkContext,
  OmnyoSdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  cliConfig?: CliConfig;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: OmnyoRealtimeSocketFactory;
}

export interface CreateNodeOmnyoSdkArgs extends CreateNodeTransportArgs {
  context?: OmnyoSdkContext;
}

export interface FetchLocalHostIdArgs {
  cliConfig?: CliConfig;
  hostDaemonUrl?: string;
}

function resolveCliConfig(cliConfig?: CliConfig): CliConfig {
  return cliConfig ?? loadCliConfig();
}

function resolveHostDaemonUrl(cliConfig?: CliConfig): string {
  const config = resolveCliConfig(cliConfig);

  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.OMNYO_HOST_DAEMON_PORT}`;
}

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): OmnyoSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl ?? resolveCliConfig(args.cliConfig).OMNYO_SERVER_URL,
    fetch:
      args.fetch ??
      createRequestTimeoutFetch({
        timeoutMs: args.timeoutMs ?? DEFAULT_CORE_REQUEST_TIMEOUT_MS,
      }),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket: args.websocket ?? createNodeWebsocketFactory(),
  });
}

export function createNodeOmnyoSdk(
  args: CreateNodeOmnyoSdkArgs = {},
): OmnyoSdk {
  return createOmnyoSdk({
    context: args.context,
    guide: createGuideArea(),
    transport: createNodeTransport(args),
  });
}

export async function fetchLocalHostId(
  args: FetchLocalHostIdArgs = {},
): Promise<string | null> {
  try {
    const client = createHostDaemonLocalClient(
      args.hostDaemonUrl ?? resolveHostDaemonUrl(args.cliConfig),
    );

    const response = await client.status.$get();

    if (!response.ok) {
      return null;
    }

    const body = await response.json();

    return body.hostId;
  } catch {
    return null;
  }
}

export {
  createOmnyoSdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_CORE_REQUEST_TIMEOUT_MS,
};

export { OmnyoHttpError, OmnyoRequestTimeoutError } from "./response.js";

export {
  pluginMutationResponseSchema,
  type PluginMutationResponse,
} from "./areas/plugins.js";

export { createBuiltinPlanCommandTextInput } from "./core.js";

export { createGuideArea } from "./areas/guide.js";

export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";

export type {
  OmnyoSdk,
  OmnyoSdkAreas,
  OmnyoSdkContext,
  OmnyoSdkTransport,
  FetchImplementation,
};

export type * from "./areas/skills.js";

export type {
  OmnyoRealtimeSocket,
  OmnyoRealtimeSocketFactory,
  OmnyoRealtimeSocketMessageEvent,
} from "./transport.js";

export type { OmnyoHttpErrorArgs } from "./response.js";

export type * from "./public-types.js";
