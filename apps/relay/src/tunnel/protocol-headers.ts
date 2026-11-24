import type { HeaderPair } from "@omnyo/tunnel-contract";

export const TUNNEL_TARGET_HEADER = "x-omnyo-tunnel-target";

export const GATE_OWNER_HEADER = "x-omnyo-gate-owner";

export const TUNNEL_OFFLINE_HEADER = "x-omnyo-tunnel-offline";

export const HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  TUNNEL_TARGET_HEADER,
  GATE_OWNER_HEADER,
]);

export function withoutHopHeaders(
  headers: readonly HeaderPair[],
): HeaderPair[] {
  return headers.filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()));
}
