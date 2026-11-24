import { expect, it, vi } from "vitest";
import { createOmnyoSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { FetchImplementation } from "../src/response.js";

it("sends one compact command-proof request with selectors and cancellation", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    body: unknown;
    signal: AbortSignal | null | undefined;
  }> = [];

  const fetch = vi.fn<FetchImplementation>(async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      signal: init?.signal,
    });

    return Response.json({
      threadId: "thread-1",
      proofs: [{ status: "missing" }, { status: "ambiguous" }],
    });
  });

  const sdk = createOmnyoSdk({
    transport: createHttpTransport({
      baseUrl: "http://fixture",
      runtime: "node",
      fetch,
    }),
  });

  const controller = new AbortController();

  const selectors: Parameters<
    typeof sdk.threads.experimental_lookupCommandProofs
  >[0]["selectors"] = [
    { kind: "command", command: "pnpm test" },
    { kind: "event", eventSeq: 15 },
  ];

  const response = await sdk.threads.experimental_lookupCommandProofs({
    threadId: "thread-1",
    selectors,
    signal: controller.signal,
  });

  expect(requests).toEqual([
    {
      url: "http://fixture/api/v1/threads/thread-1/command-proofs",
      method: "POST",
      body: { selectors },
      signal: controller.signal,
    },
  ]);
  expect(response).toEqual({
    threadId: "thread-1",
    proofs: [{ status: "missing" }, { status: "ambiguous" }],
  });
});
