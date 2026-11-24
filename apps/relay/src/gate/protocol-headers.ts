export const TUNNEL_TARGET_HEADER = "x-omnyo-tunnel-target";

export const MACHINE_CREDENTIAL_HEADER = "x-omnyo-connect-machine";

export const GATE_AUTH_HEADER = "x-omnyo-gate-auth";

export const GATE_MACHINE_ID_HEADER = "x-omnyo-gate-machine-id";

export const GATE_OWNER_HEADER = "x-omnyo-gate-owner";

export const GATE_REAUTH_HEADER = "x-omnyo-gate-reauth";

export const TUNNEL_OFFLINE_HEADER = "x-omnyo-tunnel-offline";

export const CLOUD_DEV_HOST_HEADER = "x-omnyo-cloud-dev-host";

const RELAY_HEADER = "x-omnyo-relay";

const RELAY_METHOD_HEADER = "x-omnyo-relay-method";

const RELAY_HAS_BODY_HEADER = "x-omnyo-relay-has-body";

const RELAY_CONTENT_LENGTH_HEADER = "x-omnyo-relay-content-length";

export const GATE_CONTROLLED_HEADERS: readonly string[] = [
  TUNNEL_TARGET_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  GATE_OWNER_HEADER,
  RELAY_HEADER,
  RELAY_METHOD_HEADER,
  RELAY_HAS_BODY_HEADER,
  RELAY_CONTENT_LENGTH_HEADER,
  CLOUD_DEV_HOST_HEADER,
];

export const HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "proxy-connection",
  "te",
  "trailer",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

export type GateAuthKind = "session" | "machine" | "anonymous";

const VISITOR_FORWARDING_HEADERS: ReadonlySet<string> = new Set([
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
]);

export function isVisitorForwardingHeader(name: string): boolean {
  return (
    VISITOR_FORWARDING_HEADERS.has(name) || name.startsWith("x-forwarded-")
  );
}
