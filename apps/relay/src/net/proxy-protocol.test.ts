import {
  createServer,
  isIP,
  connect,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROXY_V2_MAX_HEADER_BYTES,
  PROXY_V2_SIGNATURE,
  type ProxiedAddress,
  type ProxyRejectReason,
  createProxyProtocolServer,
  parseProxyV2Header,
  proxiedClientOf,
} from "./proxy-protocol.js";

function ipv4Bytes(address: string): number[] {
  return address.split(".").map(Number);
}

function ipv6Bytes(address: string): number[] {
  const [head = "", tail = ""] = address.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");

  const groups = address.includes("::")
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
        ...tailGroups,
      ]
    : headGroups;

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);

    return [value >> 8, value & 0xff];
  });
}

function port(value: number): number[] {
  return [value >> 8, value & 0xff];
}

function header(options: {
  versionCommand?: number;
  familyTransport?: number;
  source: ProxiedAddress;
  destination: ProxiedAddress;
  tlv?: number[];
}): Buffer {
  const v6 = isIP(options.source.address) === 6;

  const block = [
    ...(v6
      ? ipv6Bytes(options.source.address)
      : ipv4Bytes(options.source.address)),
    ...(v6
      ? ipv6Bytes(options.destination.address)
      : ipv4Bytes(options.destination.address)),
    ...port(options.source.port),
    ...port(options.destination.port),
    ...(options.tlv ?? []),
  ];

  return Buffer.concat([
    PROXY_V2_SIGNATURE,
    Buffer.from([
      options.versionCommand ?? 0x21,
      options.familyTransport ?? (v6 ? 0x21 : 0x11),
      ...port(block.length),
      ...block,
    ]),
  ]);
}

const V4 = {
  source: { address: "203.0.113.9", port: 51234 },
  destination: { address: "10.0.1.5", port: 8443 },
};

describe("parseProxyV2Header", () => {
  it("parses an IPv4 stream header and reports its length", () => {
    const bytes = header(V4);

    const parsed = parseProxyV2Header(
      Buffer.concat([bytes, Buffer.from("GET / HTTP/1.1\r\n")]),
    );

    expect(parsed).toEqual({
      status: "complete",
      header: {
        command: "proxy",
        family: "inet",
        transport: "stream",
        source: V4.source,
        destination: V4.destination,
        headerLength: bytes.length,
      },
    });
  });

  it("parses an IPv6 header and skips trailing TLVs", () => {
    const bytes = header({
      source: { address: "2001:db8::7", port: 443 },
      destination: { address: "fd00::1", port: 8443 },
      tlv: [0x04, 0x00, 0x01, 0x00],
    });

    const parsed = parseProxyV2Header(bytes);

    expect(parsed.status).toBe("complete");

    if (parsed.status !== "complete") return;
    expect(parsed.header.family).toBe("inet6");
    expect(parsed.header.source).toEqual({
      address: "2001:db8:0:0:0:0:0:7",
      port: 443,
    });
    expect(parsed.header.headerLength).toBe(bytes.length);
  });

  it("waits for more bytes while a valid prefix is incomplete", () => {
    const bytes = header(V4);

    for (const length of [1, 6, 12, 15, 16, bytes.length - 1]) {
      expect(parseProxyV2Header(bytes.subarray(0, length))).toEqual({
        status: "incomplete",
      });
    }
  });

  it("rejects plain HTTP, PROXY v1 and a corrupt signature at the first wrong byte", () => {
    expect(parseProxyV2Header(Buffer.from("GET / HTTP/1.1\r\n")).status).toBe(
      "invalid",
    );
    expect(
      parseProxyV2Header(Buffer.from("PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n"))
        .status,
    ).toBe("invalid");
    const corrupt = header(V4);
    corrupt[3] = 0x00;
    expect(parseProxyV2Header(corrupt.subarray(0, 4)).status).toBe("invalid");
  });

  it("rejects wrong versions, unknown commands and families, short blocks and oversized headers", () => {
    expect(
      parseProxyV2Header(header({ ...V4, versionCommand: 0x11 })),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProxyV2Header(header({ ...V4, versionCommand: 0x2f })),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProxyV2Header(header({ ...V4, familyTransport: 0x51 })),
    ).toMatchObject({ status: "invalid" });
    expect(
      parseProxyV2Header(header({ ...V4, familyTransport: 0x13 })),
    ).toMatchObject({ status: "invalid" });

    const short = Buffer.concat([
      PROXY_V2_SIGNATURE,
      Buffer.from([0x21, 0x11, 0x00, 0x04, 1, 2, 3, 4]),
    ]);

    expect(parseProxyV2Header(short)).toEqual({
      status: "invalid",
      reason: "short IPv4 block",
    });

    const huge = Buffer.concat([
      PROXY_V2_SIGNATURE,
      Buffer.from([0x21, 0x11, ...port(PROXY_V2_MAX_HEADER_BYTES)]),
    ]);

    expect(parseProxyV2Header(huge)).toEqual({
      status: "invalid",
      reason: "PROXY v2 header too long",
    });
  });

  it("parses a LOCAL command without a client address", () => {
    const local = Buffer.concat([
      PROXY_V2_SIGNATURE,
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
    ]);

    expect(parseProxyV2Header(local)).toMatchObject({
      status: "complete",
      header: { command: "local", source: null },
    });
  });
});

describe("createProxyProtocolServer", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function start(
    cidr: string,
    prefix: number,
  ): Promise<{
    port: number;
    accepted: Array<{
      client: ProxiedAddress;
      bound: ProxiedAddress | null;
      firstBytes: Promise<string>;
    }>;
    rejected: ProxyRejectReason[];
  }> {
    const accepted: Array<{
      client: ProxiedAddress;
      bound: ProxiedAddress | null;
      firstBytes: Promise<string>;
    }> = [];

    const rejected: ProxyRejectReason[] = [];
    const sink = createServer();
    servers.push(sink);

    const server = createProxyProtocolServer({
      proxyCidr: { address: cidr, prefix, family: "ipv4" },
      headerTimeoutMs: 200,
      onSocket(socket: Socket, client) {
        accepted.push({
          client,
          bound: proxiedClientOf(socket),
          firstBytes: new Promise((resolve) => {
            socket.once("data", (chunk: Buffer) => {
              resolve(chunk.toString("utf8"));
              socket.end();
            });
            socket.resume();
          }),
        });
      },
      onReject: (reason) => rejected.push(reason),
    });

    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (address === null || typeof address === "string")
      throw new Error("no port");

    return { port: address.port, accepted, rejected };
  }

  function send(port: number, bytes: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(bytes));
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      socket.resume();
    });
  }

  it("binds the PROXY source to the socket and replays the bytes after the header", async () => {
    const server = await start("127.0.0.0", 8);
    await send(
      server.port,
      Buffer.concat([header(V4), Buffer.from("GET / HTTP/1.1\r\n\r\n")]),
    );

    expect(server.accepted).toHaveLength(1);
    expect(server.accepted[0]?.client).toEqual(V4.source);
    expect(server.accepted[0]?.bound).toEqual(V4.source);
    await expect(server.accepted[0]?.firstBytes).resolves.toBe(
      "GET / HTTP/1.1\r\n\r\n",
    );
    expect(server.rejected).toEqual([]);
  });

  it("closes connections from peers outside RELAY_PROXY_CIDR", async () => {
    const server = await start("10.0.1.0", 24);
    await send(
      server.port,
      Buffer.concat([header(V4), Buffer.from("GET / HTTP/1.1\r\n\r\n")]),
    );

    expect(server.accepted).toEqual([]);
    expect(server.rejected).toEqual(["peer-outside-proxy-cidr"]);
  });

  it("closes connections that start without a valid header, with LOCAL, or never send one", async () => {
    const server = await start("127.0.0.0", 8);
    await send(
      server.port,
      Buffer.from("GET / HTTP/1.1\r\nX-Forwarded-For: 1.2.3.4\r\n\r\n"),
    );
    await send(
      server.port,
      Buffer.concat([
        PROXY_V2_SIGNATURE,
        Buffer.from([0x20, 0x00, 0x00, 0x00]),
      ]),
    );
    await send(server.port, header(V4).subarray(0, 10));

    expect(server.accepted).toEqual([]);
    expect(server.rejected).toEqual([
      "invalid-header",
      "unsupported-header",
      "header-timeout",
    ]);
  });
});
