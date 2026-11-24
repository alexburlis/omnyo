import { parseVisitorHost } from "@omnyo/connect-db";
import {
  HEALTHCHECK_LABEL,
  STAGING_LABEL,
  isRelayReservedLabel,
} from "../reserved-labels.js";

export type HostClass =
  | { kind: "apex" }
  | { kind: "healthcheck" }
  | { kind: "reserved"; label: string }
  | { kind: "tenant"; label: string; target: string | null }
  | { kind: "misdirected" };

export interface RelayOrigin {
  baseDomain: string;
  appUrl: string;
}

function splitHost(host: string): { hostname: string; port: string } | null {
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/u.exec(host.toLowerCase());

  if (match === null) return null;

  return { hostname: match[1] ?? "", port: match[2] ?? "" };
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
};

function withoutDefaultPort(port: string, protocol: string): string {
  return port === DEFAULT_PORTS[protocol] ? "" : port;
}

export function classifyHost(host: string, relay: RelayOrigin): HostClass {
  const split = splitHost(host);

  if (split === null) return { kind: "misdirected" };
  const app = new URL(relay.appUrl);

  if (withoutDefaultPort(split.port, app.protocol) !== app.port) {
    return { kind: "misdirected" };
  }

  if (split.hostname === relay.baseDomain) return { kind: "apex" };
  const parsed = parseVisitorHost(split.hostname, relay.baseDomain);

  if (parsed === null) return { kind: "misdirected" };

  if (parsed.handle === STAGING_LABEL) return { kind: "misdirected" };

  if (parsed.handle === HEALTHCHECK_LABEL) {
    return parsed.target === null
      ? { kind: "healthcheck" }
      : { kind: "misdirected" };
  }

  if (isRelayReservedLabel(parsed.handle)) {
    return { kind: "reserved", label: parsed.handle };
  }

  return { kind: "tenant", label: parsed.handle, target: parsed.target };
}

export function originForHost(host: string, appUrl: string): string {
  const { protocol } = new URL(appUrl);
  const split = splitHost(host);

  if (split === null) return `${protocol}//${host.toLowerCase()}`;
  const port = withoutDefaultPort(split.port, protocol);

  return `${protocol}//${split.hostname}${port === "" ? "" : `:${port}`}`;
}
