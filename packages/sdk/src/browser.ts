import {
  createOmnyoSdk,
  createBuiltinPlanCommandTextInput,
  type OmnyoSdk,
  type OmnyoSdkAreas,
} from "./core.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  OmnyoRealtimeSocketFactory,
  OmnyoSdkContext,
  OmnyoSdkTransport,
} from "./transport.js";

export interface CreateBrowserTransportArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
  realtimeUrl?: string;
  websocket?: OmnyoRealtimeSocketFactory;
}

export interface CreateBrowserOmnyoSdkArgs extends CreateBrowserTransportArgs {
  context?: OmnyoSdkContext;
}

export type BrowserOmnyoSdk = OmnyoSdkAreas;

export function createBrowserTransport(
  args: CreateBrowserTransportArgs = {},
): OmnyoSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    realtimeUrl: args.realtimeUrl,
    runtime: "browser",
    websocket: args.websocket,
  });
}

export function createBrowserOmnyoSdk(
  args: CreateBrowserOmnyoSdkArgs = {},
): BrowserOmnyoSdk {
  return createOmnyoSdk({
    context: args.context,
    transport: createBrowserTransport(args),
  });
}

export { OmnyoHttpError, OmnyoRequestTimeoutError } from "./response.js";

export type { OmnyoHttpErrorArgs } from "./response.js";

export { createOmnyoSdk, createBuiltinPlanCommandTextInput, createHttpTransport };

export type { OmnyoSdk, OmnyoSdkAreas, OmnyoSdkContext, OmnyoSdkTransport };

export type * from "./areas/skills.js";

export type * from "./public-types.js";
