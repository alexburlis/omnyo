import type { ServerConfig } from "@omnyo/config/server";
import { serve } from "@hono/node-server";
import {
  createSplitAssetAttemptAdmission,
  prepareSplitAssetAttempt,
} from "@omnyo/process-utils/split-asset-attempt";
import type { ServerLogger } from "./types.js";

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  logger: Pick<ServerLogger, "info">;
  serverConfig: Pick<
    ServerConfig,
    "OMNYO_SERVER_BIND_HOST" | "OMNYO_SERVER_PORT"
  >;
}

export function startHttpListener(args: StartHttpListenerArgs) {
  const admitSplitAssetAttempt = createSplitAssetAttemptAdmission(Date.now);

  return serve({
    hostname: args.serverConfig.OMNYO_SERVER_BIND_HOST,
    port: args.serverConfig.OMNYO_SERVER_PORT,
    fetch: (request, bindings) => {
      const assetAttempt = prepareSplitAssetAttempt(
        bindings.incoming,
        bindings.outgoing,
        (fields) => args.logger.info(fields, "Split asset attempt"),
      );

      if (assetAttempt !== undefined && admitSplitAssetAttempt())
        assetAttempt.observe();

      return args.fetch(request, bindings);
    },
    serverOptions: { keepAliveTimeout: 0 },
  });
}
