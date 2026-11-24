import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeRpcRegistration } from "../internal/host-policy.js";

describe("thread bootstrap RPC declarations", () => {
  const contract = {
    read: {
      input: z.object({ threadId: z.string() }),
      output: z.object({ headline: z.string() }).nullable(),
      experimental_threadBootstrap: true,
    },
  };

  it("preserves an explicit read opt-in without marking other RPCs", () => {
    const methods = normalizeRpcRegistration(
      { ...contract, refresh: { input: z.null(), output: z.null() } },
      { read: () => null, refresh: () => null },
      new Map(),
      undefined,
    );

    expect(
      methods.map(([name, record]) => [name, record.threadBootstrap]),
    ).toEqual([
      ["read", true],
      ["refresh", false],
    ]);
  });

  it("rejects invalid declaration values rather than silently dropping them", () => {
    expect(() =>
      normalizeRpcRegistration(
        { read: { ...contract.read, experimental_threadBootstrap: "yes" } },
        { read: () => null },
        new Map(),
        undefined,
      ),
    ).toThrow("experimental_threadBootstrap must be true when provided");
  });

  it("includes read-only dispatch readiness in the bootstrap without marking ordinary reads", () => {
    const methods = normalizeRpcRegistration(
      {
        readiness: {
          input: z.unknown(),
          output: z.unknown(),
          experimental_dispatchReadiness: true,
        },
        ...contract,
      },
      { readiness: () => ({ action: "proceed" }), read: () => null },
      new Map(),
      undefined,
    );

    expect(
      methods.map(([name, record]) => [
        name,
        record.threadBootstrap,
        record.dispatchReadiness,
      ]),
    ).toEqual([
      ["readiness", true, true],
      ["read", true, false],
    ]);
  });

  it("rejects malformed readiness declarations", () => {
    expect(() =>
      normalizeRpcRegistration(
        { read: { ...contract.read, experimental_dispatchReadiness: false } },
        { read: () => null },
        new Map(),
        undefined,
      ),
    ).toThrow("experimental_dispatchReadiness must be true when provided");
  });
});
