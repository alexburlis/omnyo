import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER } from "../contracts.js";
import {
  applyClientIp,
  clientAddressKey,
  clientSiteKey,
  createClientIpSource,
  prepareIncomingClientIp,
  rightmostForwardedFor,
} from "./client-ip.js";
import { bindProxiedClient } from "./proxy-protocol.js";

function incoming(
  rawHeaders: string[],
  socket = new Socket(),
): IncomingMessage {
  const message = new IncomingMessage(socket);
  message.rawHeaders = rawHeaders;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = (rawHeaders[index] ?? "").toLowerCase();
    const value = rawHeaders[index + 1] ?? "";
    const existing = message.headers[name];
    message.headers[name] =
      existing === undefined ? value : `${String(existing)}, ${value}`;
  }

  return message;
}

const FORGED = [
  "X-Forwarded-For",
  "6.6.6.6",
  "X-Real-IP",
  "7.7.7.7",
  "CF-Connecting-IP",
  "8.8.8.8",
  "X-Omnyo-Client-IP",
  "9.9.9.9",
  "Accept",
  "text/html",
];

describe("rightmostForwardedFor", () => {
  it("trusts only the right-most hop", () => {
    expect(
      rightmostForwardedFor({
        "x-forwarded-for": "6.6.6.6, 1.1.1.1, 203.0.113.4",
      }),
    ).toBe("203.0.113.4");
    expect(
      rightmostForwardedFor({ "x-forwarded-for": ["6.6.6.6", "203.0.113.4"] }),
    ).toBe("203.0.113.4");
    expect(
      rightmostForwardedFor({
        "x-forwarded-for": "1.1.1.1, ::ffff:203.0.113.4",
      }),
    ).toBe("203.0.113.4");
    expect(
      rightmostForwardedFor({ "x-forwarded-for": "2001:DB8:0:0:0:0:0:1" }),
    ).toBe("2001:db8::1");
    expect(
      rightmostForwardedFor({ "x-forwarded-for": "1.1.1.1, not-an-ip" }),
    ).toBeNull();
    expect(rightmostForwardedFor({})).toBeNull();
  });

  it("reads a hex IPv4-mapped hop as IPv4 and refuses a scoped IPv6 hop without throwing", () => {
    expect(
      rightmostForwardedFor({ "x-forwarded-for": "0:0:0:0:0:ffff:cb00:7104" }),
    ).toBe("203.0.113.4");
    expect(
      rightmostForwardedFor({ "x-forwarded-for": "1.1.1.1, fe80::1%eth0" }),
    ).toBeNull();
  });
});

describe("clientAddressKey", () => {
  it("keeps IPv4 addresses whole and collapses IPv6 addresses to their /64", () => {
    expect(clientAddressKey("198.51.100.7")).toBe("198.51.100.7");
    expect(clientAddressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(clientAddressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientAddressKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64",
    );
    expect(clientAddressKey("[2001:db8:0:0:1::9]:443")).toBe(
      "2001:db8:0:0::/64",
    );
    expect(clientAddressKey("::1")).toBe("0:0:0:0::/64");
    expect(clientAddressKey("2001:db8:1:3::1")).not.toBe(
      clientAddressKey("2001:db8:1:2::1"),
    );
  });

  it("returns keys that are not addresses unchanged", () => {
    expect(clientAddressKey("sawyer")).toBe("sawyer");
    expect(clientAddressKey("user:42")).toBe("user:42");
  });
});

describe("clientSiteKey", () => {
  it("collapses IPv6 addresses to their /48 and gives IPv4 and other keys none", () => {
    expect(clientSiteKey("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
    expect(clientSiteKey("[2001:DB8:1:ffff::9]:443")).toBe("2001:db8:1::/48");
    expect(clientSiteKey("2001:db8:2:2::1")).not.toBe(
      clientSiteKey("2001:db8:1:2::1"),
    );
    expect(clientSiteKey("198.51.100.7")).toBeNull();
    expect(clientSiteKey("::ffff:198.51.100.7")).toBeNull();
    expect(clientSiteKey("sawyer")).toBeNull();
  });
});

describe("client IP derivation", () => {
  it("proxy-protocol mode uses the PROXY source and ignores every forwarded header", () => {
    const socket = new Socket();
    bindProxiedClient(socket, { address: "203.0.113.9", port: 4000 });

    const source = createClientIpSource({
      clientIpSource: "proxy-protocol",
      proxyCidr: { address: "10.0.0.0", prefix: 8, family: "ipv4" },
      acme: {
        directoryUrl: "https://acme.test/dir",
        accountEmail: "ops@relay.test",
        cloudflareDnsToken: "unused",
        cloudflareZoneId: "0123456789abcdef0123456789abcdef",
      },
    });

    const message = incoming([...FORGED], socket);

    expect(prepareIncomingClientIp(message, source)).toBe("203.0.113.9");
    expect(message.headers["x-forwarded-for"]).toBeUndefined();
    expect(message.headers["x-real-ip"]).toBeUndefined();
    expect(message.headers["cf-connecting-ip"]).toBeUndefined();
    expect(message.headers[CLIENT_IP_HEADER]).toBe("203.0.113.9");
    expect(message.rawHeaders).toEqual([
      "Accept",
      "text/html",
      CLIENT_IP_HEADER,
      "203.0.113.9",
    ]);
  });

  it("proxy-protocol mode refuses a socket that carried no PROXY header", () => {
    const source = createClientIpSource({
      clientIpSource: "proxy-protocol",
      proxyCidr: { address: "10.0.0.0", prefix: 8, family: "ipv4" },
      acme: {
        directoryUrl: "https://acme.test/dir",
        accountEmail: "ops@relay.test",
        cloudflareDnsToken: "unused",
        cloudflareZoneId: "0123456789abcdef0123456789abcdef",
      },
    });

    expect(prepareIncomingClientIp(incoming([...FORGED]), source)).toBeNull();
  });

  it("xff-rightmost mode keeps the proxy-appended hop and strips forged headers", () => {
    const source = createClientIpSource({ clientIpSource: "xff-rightmost" });

    const message = incoming([
      "X-Forwarded-For",
      "6.6.6.6, 198.51.100.20",
      ...FORGED.slice(2),
    ]);

    expect(prepareIncomingClientIp(message, source)).toBe("198.51.100.20");
    expect(message.headers[CLIENT_IP_HEADER]).toBe("198.51.100.20");
    expect(message.rawHeaders.filter((_, index) => index % 2 === 0)).toEqual([
      "Accept",
      CLIENT_IP_HEADER,
    ]);
  });

  it("replaces repeated inbound copies of the client IP header", () => {
    const message = incoming([
      "x-omnyo-client-ip",
      "1.1.1.1",
      "X-OMNYO-CLIENT-IP",
      "2.2.2.2",
    ]);

    applyClientIp(message, "203.0.113.1");

    expect(message.rawHeaders).toEqual([CLIENT_IP_HEADER, "203.0.113.1"]);
  });
});
