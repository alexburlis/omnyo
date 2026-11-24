import {
  clientMessageSchema,
  type ChangedMessage,
  type PongMessage,
} from "@omnyo/domain";
import { parseSocketMessage } from "./decode-payload.js";
import type { NotificationHub } from "./hub.js";
import type { WatchInterestCoordinator } from "./watch-interests.js";

const PONG_MESSAGE: PongMessage = { type: "pong" };

const COMMAND_CATALOG_CATCH_UP_MESSAGE: ChangedMessage = {
  type: "changed",
  entity: "system",
  changes: ["command-catalog-changed"],
};

interface ClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export function onClientSocketOpen(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.registerClient(socket);
}

export function onClientSocketMessage(
  deps: {
    hub: NotificationHub;
    watchInterests: Pick<
      WatchInterestCoordinator,
      "subscribe" | "unsubscribe" | "releaseSocket"
    >;
  },
  socket: ClientSocket,
  raw: unknown,
): void {
  const parsed = parseSocketMessage(socket, raw, clientMessageSchema);

  if (parsed === null) {
    return;
  }

  switch (parsed.type) {
    case "subscribe":
      deps.hub.subscribe(socket, parsed.target);
      deps.watchInterests.subscribe(socket, parsed.target);

      if (parsed.target.kind === "system") {
        deps.hub.sendClientPayload(
          socket,
          JSON.stringify(COMMAND_CATALOG_CATCH_UP_MESSAGE),
        );
      }

      break;
    case "unsubscribe":
      deps.hub.unsubscribe(socket, parsed.target);
      deps.watchInterests.unsubscribe(socket, parsed.target);
      break;
    case "ping":
      deps.hub.sendClientPayload(socket, JSON.stringify(PONG_MESSAGE));
      break;
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled client message: ${_exhaustive}`);
    }
  }
}

export function onClientSocketClose(
  deps: {
    hub: NotificationHub;
    watchInterests: Pick<WatchInterestCoordinator, "releaseSocket">;
  },
  socket: ClientSocket,
): void {
  deps.watchInterests.releaseSocket(socket);
  deps.hub.unregisterClient(socket);
}
