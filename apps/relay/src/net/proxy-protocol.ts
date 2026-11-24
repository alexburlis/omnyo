import {
  BlockList,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import type { Cidr } from "../config.js";

export const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

const FIXED_HEADER_BYTES = 16;

export const PROXY_V2_MAX_HEADER_BYTES = 4096;

export const PROXY_HEADER_TIMEOUT_MS = 5_000;

const IPV4_ADDRESS_BLOCK_BYTES = 12;

const IPV6_ADDRESS_BLOCK_BYTES = 36;

const UNIX_ADDRESS_BLOCK_BYTES = 216;

export interface ProxiedAddress {
  address: string;
  port: number;
}

export type ProxyV2Command = "local" | "proxy";

export type ProxyV2Family = "unspec" | "inet" | "inet6" | "unix";

export type ProxyV2Transport = "unspec" | "stream" | "dgram";

export interface ProxyV2Header {
  command: ProxyV2Command;
  family: ProxyV2Family;
  transport: ProxyV2Transport;
  source: ProxiedAddress | null;
  destination: ProxiedAddress | null;
  headerLength: number;
}

export type ProxyV2ParseResult =
  | { status: "incomplete" }
  | { status: "invalid"; reason: string }
  | { status: "complete"; header: ProxyV2Header };

const FAMILIES: Record<number, ProxyV2Family> = {
  0: "unspec",
  1: "inet",
  2: "inet6",
  3: "unix",
};

const TRANSPORTS: Record<number, ProxyV2Transport> = {
  0: "unspec",
  1: "stream",
  2: "dgram",
};

function invalid(reason: string): ProxyV2ParseResult {
  return { status: "invalid", reason };
}

function ipv4At(buffer: Buffer, offset: number): string {
  return [0, 1, 2, 3].map((index) => buffer[offset + index]).join(".");
}

function ipv6At(buffer: Buffer, offset: number): string {
  const groups: string[] = [];

  for (let index = 0; index < 8; index += 1) {
    groups.push(buffer.readUInt16BE(offset + index * 2).toString(16));
  }

  return groups.join(":");
}

function addressesFor(
  buffer: Buffer,
  family: ProxyV2Family,
  blockLength: number,
): { source: ProxiedAddress; destination: ProxiedAddress } | string | null {
  const start = FIXED_HEADER_BYTES;

  if (family === "inet") {
    if (blockLength < IPV4_ADDRESS_BLOCK_BYTES) return "short IPv4 block";

    return {
      source: {
        address: ipv4At(buffer, start),
        port: buffer.readUInt16BE(start + 8),
      },
      destination: {
        address: ipv4At(buffer, start + 4),
        port: buffer.readUInt16BE(start + 10),
      },
    };
  }

  if (family === "inet6") {
    if (blockLength < IPV6_ADDRESS_BLOCK_BYTES) return "short IPv6 block";

    return {
      source: {
        address: ipv6At(buffer, start),
        port: buffer.readUInt16BE(start + 32),
      },
      destination: {
        address: ipv6At(buffer, start + 16),
        port: buffer.readUInt16BE(start + 34),
      },
    };
  }

  if (family === "unix" && blockLength < UNIX_ADDRESS_BLOCK_BYTES) {
    return "short UNIX block";
  }

  return null;
}

export function parseProxyV2Header(buffer: Buffer): ProxyV2ParseResult {
  const prefix = Math.min(buffer.length, PROXY_V2_SIGNATURE.length);

  if (
    !buffer.subarray(0, prefix).equals(PROXY_V2_SIGNATURE.subarray(0, prefix))
  )
    return invalid("missing PROXY v2 signature");

  if (buffer.length < FIXED_HEADER_BYTES) return { status: "incomplete" };
  const versionCommand = buffer[12] ?? 0;
  const version = versionCommand >> 4;
  const commandBits = versionCommand & 0x0f;

  if (version !== 2) return invalid("unsupported PROXY protocol version");

  if (commandBits > 1) return invalid("unknown PROXY v2 command");
  const familyTransport = buffer[13] ?? 0;
  const family = FAMILIES[familyTransport >> 4];
  const transport = TRANSPORTS[familyTransport & 0x0f];

  if (family === undefined) return invalid("unknown address family");

  if (transport === undefined) return invalid("unknown transport");
  const blockLength = buffer.readUInt16BE(14);
  const headerLength = FIXED_HEADER_BYTES + blockLength;

  if (headerLength > PROXY_V2_MAX_HEADER_BYTES)
    return invalid("PROXY v2 header too long");

  if (buffer.length < headerLength) return { status: "incomplete" };
  const command: ProxyV2Command = commandBits === 0 ? "local" : "proxy";
  const addresses = addressesFor(buffer, family, blockLength);

  if (typeof addresses === "string") return invalid(addresses);

  return {
    status: "complete",
    header: {
      command,
      family,
      transport,
      source: addresses?.source ?? null,
      destination: addresses?.destination ?? null,
      headerLength,
    },
  };
}

export function cidrBlockList(cidr: Cidr): BlockList {
  const list = new BlockList();
  list.addSubnet(cidr.address, cidr.prefix, cidr.family);

  return list;
}

export function addressInCidr(list: BlockList, address: string): boolean {
  const version = isIP(address);

  if (version === 4) return list.check(address, "ipv4");

  if (version === 6) return list.check(address, "ipv6");

  return false;
}

const proxiedClients = new WeakMap<Socket, ProxiedAddress>();

export function bindProxiedClient(
  socket: Socket,
  client: ProxiedAddress,
): void {
  proxiedClients.set(socket, client);
}

export function proxiedClientOf(socket: Socket): ProxiedAddress | null {
  return proxiedClients.get(socket) ?? null;
}

export type ProxyRejectReason =
  | "peer-outside-proxy-cidr"
  | "invalid-header"
  | "unsupported-header"
  | "header-timeout"
  | "closed-before-header";

export interface ProxyProtocolServerOptions {
  proxyCidr: Cidr;
  headerTimeoutMs?: number;
  onSocket(socket: Socket, client: ProxiedAddress): void;
  onReject(reason: ProxyRejectReason, peer: string): void;
}

function usableClient(header: ProxyV2Header): ProxiedAddress | null {
  if (header.command !== "proxy" || header.transport !== "stream") return null;

  if (header.family !== "inet" && header.family !== "inet6") return null;

  return header.source;
}

export function acceptProxyProtocol(
  socket: Socket,
  allowed: BlockList,
  options: Omit<ProxyProtocolServerOptions, "proxyCidr">,
): void {
  const peer = socket.remoteAddress ?? "";

  if (!addressInCidr(allowed, peer)) {
    options.onReject("peer-outside-proxy-cidr", peer);
    socket.destroy();

    return;
  }

  let buffered = Buffer.alloc(0);
  let settled = false;

  const timer = setTimeout(
    () => reject("header-timeout"),
    options.headerTimeoutMs ?? PROXY_HEADER_TIMEOUT_MS,
  );

  function cleanup(): void {
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("close", onClose);
    socket.removeListener("error", onError);
  }

  function reject(reason: ProxyRejectReason): void {
    if (settled) return;
    cleanup();
    options.onReject(reason, peer);
    socket.destroy();
  }

  function onClose(): void {
    reject("closed-before-header");
  }

  function onError(): void {
    reject("closed-before-header");
  }

  function onData(chunk: Buffer): void {
    buffered = Buffer.concat([buffered, chunk]);
    const parsed = parseProxyV2Header(buffered);

    if (parsed.status === "incomplete") return;

    if (parsed.status === "invalid") {
      reject("invalid-header");

      return;
    }

    const client = usableClient(parsed.header);

    if (client === null) {
      reject("unsupported-header");

      return;
    }

    cleanup();
    socket.pause();
    const rest = buffered.subarray(parsed.header.headerLength);

    if (rest.length > 0) socket.unshift(rest);
    bindProxiedClient(socket, client);
    options.onSocket(socket, client);
  }

  socket.on("data", onData);
  socket.on("close", onClose);
  socket.on("error", onError);
}

export function createProxyProtocolServer(
  options: ProxyProtocolServerOptions,
): Server {
  const allowed = cidrBlockList(options.proxyCidr);

  return createServer((socket) =>
    acceptProxyProtocol(socket, allowed, options),
  );
}
