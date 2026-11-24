import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { prepareSplitAssetAttempt } from "@omnyo/process-utils/split-asset-attempt";
import type { ClientIpSource, RelayLogger } from "../contracts.js";
import { prepareIncomingClientIp } from "../net/client-ip.js";
import {
  type EdgeRequest,
  type EdgeResponse,
  writeBadRequest,
} from "../net/edge-responses.js";
import type { Gate, GateRequestMeta } from "./gate.js";
import { gateErrorPage } from "./pages.js";

export interface GateNodeHandlers {
  request(incoming: EdgeRequest, outgoing: EdgeResponse): void;
  upgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): void;
}

const CLIENT_IP_META = new WeakMap<object, string>();

export function createGateNodeHandlers(
  gate: Gate,
  clientIp: ClientIpSource,
  log: RelayLogger,
): GateNodeHandlers {
  const listener = getRequestListener(
    (request, env) => {
      const meta: GateRequestMeta = {
        rawTarget: env.incoming.url ?? "/",
        clientIp: CLIENT_IP_META.get(env.incoming) ?? "",
        splitAssetAttempt: prepareSplitAssetAttempt(
          env.incoming,
          env.outgoing,
          (fields) => log.info("gate.split_asset_attempt", fields),
        ),
      };

      return gate.fetch(request, meta);
    },
    {
      errorHandler: (error) => {
        log.error("gate.failure", {
          error: error instanceof Error ? error.name : "unknown",
        });

        return gateErrorPage();
      },
    },
  );

  return {
    request(incoming, outgoing) {
      const derived = prepareIncomingClientIp(incoming, clientIp);

      if (derived === null) {
        log.warn("gate.client_ip_missing", { mode: clientIp.mode });
        writeBadRequest(outgoing);

        return;
      }

      CLIENT_IP_META.set(incoming, derived);
      void listener(incoming, outgoing);
    },
    upgrade(incoming, socket, head) {
      const derived = prepareIncomingClientIp(incoming, clientIp);

      if (derived === null) {
        log.warn("gate.client_ip_missing", { mode: clientIp.mode });
        socket.destroy();

        return;
      }

      gate
        .upgrade(incoming, socket, head, {
          rawTarget: incoming.url ?? "/",
          clientIp: derived,
        })
        .catch((error: unknown) => {
          log.error("gate.upgrade_failure", {
            error: error instanceof Error ? error.name : "unknown",
          });
          socket.destroy();
        });
    },
  };
}
