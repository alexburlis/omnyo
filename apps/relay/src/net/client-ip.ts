import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { EdgeConfig } from "../config.js";
import {
  CLIENT_IP_HEADER,
  type ClientConnection,
  type ClientIpSource,
  INBOUND_CLIENT_IP_HEADERS,
} from "../contracts.js";
import type { EdgeRequest } from "./edge-responses.js";
import { proxiedClientOf } from "./proxy-protocol.js";

const IPV6_GROUPS = 8;

const IPV6_NETWORK_GROUPS = 4;

const IPV6_SITE_GROUPS = 3;

const IPV4_MAPPED_MARKER = "ffff";

function ipv6Groups(canonical: string): string[] {
  const [head = "", tail] = canonical.split("::");
  const headGroups = head === "" ? [] : head.split(":");

  if (tail === undefined) return headGroups;
  const tailGroups = tail === "" ? [] : tail.split(":");

  return [
    ...headGroups,
    ...Array<string>(IPV6_GROUPS - headGroups.length - tailGroups.length).fill(
      "0",
    ),
    ...tailGroups,
  ];
}

function mappedIpv4(groups: readonly string[]): string | null {
  const [high, low] = groups.slice(6);

  if (
    groups.slice(0, 5).some((group) => group !== "0") ||
    groups[5] !== IPV4_MAPPED_MARKER ||
    high === undefined ||
    low === undefined
  ) {
    return null;
  }

  const bytes = [Number.parseInt(high, 16), Number.parseInt(low, 16)].flatMap(
    (value) => [value >> 8, value & 0xff],
  );

  return bytes.join(".");
}

function normalizeAddress(address: string): string | null {
  const trimmed = address.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(trimmed);
  const candidate = bracketed?.[1] ?? trimmed;
  const version = isIP(candidate);

  if (version === 4) return candidate;

  if (version !== 6) return null;
  const url = URL.parse(`http://[${candidate}]/`);

  if (url === null) return null;
  const canonical = url.hostname.slice(1, -1);

  return mappedIpv4(ipv6Groups(canonical)) ?? canonical;
}

export function clientAddressKey(value: string): string {
  const address = normalizeAddress(value);

  if (address === null) return value;

  if (isIP(address) === 4) return address;

  return `${ipv6Groups(address).slice(0, IPV6_NETWORK_GROUPS).join(":")}::/64`;
}

export function clientSiteKey(value: string): string | null {
  const address = normalizeAddress(value);

  if (address === null || isIP(address) !== 6) return null;

  return `${ipv6Groups(address).slice(0, IPV6_SITE_GROUPS).join(":")}::/48`;
}

function headerValues(
  headers: IncomingHttpHeaders,
  name: string,
): readonly string[] {
  const value = headers[name];

  if (value === undefined) return [];

  return Array.isArray(value) ? value : [value];
}

export function rightmostForwardedFor(
  headers: IncomingHttpHeaders,
): string | null {
  const hops = headerValues(headers, "x-forwarded-for")
    .flatMap((value) => value.split(","))
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");

  const last = hops.at(-1);

  return last === undefined ? null : normalizeAddress(last);
}

export function createClientIpSource(edge: EdgeConfig): ClientIpSource {
  if (edge.clientIpSource === "proxy-protocol") {
    return {
      mode: "proxy-protocol",
      deriveClientIp(connection: ClientConnection) {
        const client = proxiedClientOf(connection.socket);

        return client === null ? null : normalizeAddress(client.address);
      },
    };
  }

  return {
    mode: "xff-rightmost",
    deriveClientIp(connection: ClientConnection) {
      return rightmostForwardedFor(connection.headers);
    },
  };
}

const STRIPPED = new Set<string>(INBOUND_CLIENT_IP_HEADERS);

export function applyClientIp(incoming: EdgeRequest, clientIp: string): void {
  const raw = incoming.rawHeaders;
  const kept: string[] = [];

  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";

    if (STRIPPED.has(name.toLowerCase())) continue;
    kept.push(name, raw[index + 1] ?? "");
  }

  kept.push(CLIENT_IP_HEADER, clientIp);
  raw.splice(0, raw.length, ...kept);

  for (const name of INBOUND_CLIENT_IP_HEADERS) {
    delete incoming.headers[name];
  }

  incoming.headers[CLIENT_IP_HEADER] = clientIp;
}

export function prepareIncomingClientIp(
  incoming: EdgeRequest,
  source: ClientIpSource,
): string | null {
  const clientIp = source.deriveClientIp({
    socket: incoming.socket,
    headers: incoming.headers,
  });

  if (clientIp === null) return null;
  applyClientIp(incoming, clientIp);

  return clientIp;
}
