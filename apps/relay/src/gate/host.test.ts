import { describe, expect, it } from "vitest";
import { classifyHost, originForHost } from "./host.js";

const RELAY = { baseDomain: "omnyo.link", appUrl: "https://omnyo.link" };

describe("a Host header with the scheme's default port", () => {
  it.each(["slashnew.com", "alice.slashnew.com", "stg.slashnew.com"])(
    "rejects the retired relay host %s",
    (host) => {
      expect(classifyHost(host, RELAY)).toEqual({ kind: "misdirected" });
    },
  );

  it.each([
    ["omnyo.link:443", { kind: "apex" }],
    ["alice.omnyo.link:443", { kind: "tenant", label: "alice", target: null }],
  ])("classifies %s like the same host without a port", (host, expected) => {
    expect(classifyHost(host, RELAY)).toEqual(expected);
    expect(classifyHost(host.replace(/:443$/u, ""), RELAY)).toEqual(expected);
  });

  it("still refuses any other port", () => {
    expect(classifyHost("omnyo.link:8443", RELAY)).toEqual({
      kind: "misdirected",
    });
    expect(classifyHost("omnyo.link:80", RELAY)).toEqual({
      kind: "misdirected",
    });
  });

  it("accepts port 80 for a plain-http relay and keeps a non-default app port", () => {
    expect(
      classifyHost("relay.localhost:80", {
        baseDomain: "relay.localhost",
        appUrl: "http://relay.localhost",
      }),
    ).toEqual({ kind: "apex" });
    expect(
      classifyHost("relay.localhost:8787", {
        baseDomain: "relay.localhost",
        appUrl: "http://relay.localhost:8787",
      }),
    ).toEqual({ kind: "apex" });
  });

  it("gives the origin without the default port", () => {
    expect(originForHost("Alice.omnyo.link:443", RELAY.appUrl)).toBe(
      "https://alice.omnyo.link",
    );
    expect(originForHost("alice.omnyo.link", RELAY.appUrl)).toBe(
      "https://alice.omnyo.link",
    );
  });
});
