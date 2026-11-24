import { WebSocket as NodeWebSocket } from "ws";

interface NodeWebSocketConstructor {
  new (address: string | URL, protocols?: string | string[]): object;
}

export function createNodeWebSocketConstructor(
  headers: Record<string, string> | undefined,
  onCreated: (socket: NodeWebSocket) => void,
): NodeWebSocketConstructor {
  return class HeaderAwareWebSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers });
      onCreated(this);
    }
  };
}
