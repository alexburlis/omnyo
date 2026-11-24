import { describe, expect, it, vi } from "vitest";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("usage consent SDK", () => {
  it("uses purpose-specific routes, leaves the proof out of URLs and forbids redirects", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });

        return Response.json({});
      },
    );

    const sdk = createOmnyoSdk({
      transport: createHttpTransport({
        baseUrl: "http://localhost:1234",
        runtime: "node",
        fetch,
      }),
    });

    await sdk.system.experimental_usageStatus();
    await sdk.system.experimental_usageConsent({
      purpose: "product",
      choice: "granted",
      source: "sdk",
    });
    const proof = "a".repeat(64);
    await sdk.system.experimental_eraseUsageAnalytics(proof);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/system/usage",
      "/api/v1/system/usage/consent",
      "/api/v1/system/usage/erase",
    ]);

    for (const request of requests) {
      expect(request.url).not.toContain(proof);
      expect(request.init?.redirect).toBe("error");
    }

    expect(requests[2]?.init?.body).toBe(JSON.stringify({ proof }));
  });
});
