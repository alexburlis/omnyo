import { useSyncExternalStore } from "react";
import {
  wsManager,
  type WebSocketConnectionState,
  type WebSocketConnectionStatus,
} from "@/lib/ws";

type StoreChangeCallback = () => void;

function subscribeServerConnectionState(
  onStoreChange: StoreChangeCallback,
): () => void {
  return wsManager.onConnectionStateChange(onStoreChange);
}

function getServerConnectionStateSnapshot(): WebSocketConnectionState {
  return wsManager.getConnectionState();
}

function getServerConnectionStatusSnapshot(): WebSocketConnectionStatus {
  return wsManager.getConnectionStatus();
}

export function useServerConnectionState(): WebSocketConnectionState {
  return useSyncExternalStore(
    subscribeServerConnectionState,
    getServerConnectionStateSnapshot,
    getServerConnectionStateSnapshot,
  );
}

export function useServerConnectionStatus(): WebSocketConnectionStatus {
  return useSyncExternalStore(
    subscribeServerConnectionState,
    getServerConnectionStatusSnapshot,
    getServerConnectionStatusSnapshot,
  );
}
