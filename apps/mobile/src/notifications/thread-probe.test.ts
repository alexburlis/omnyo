import { afterEach, describe, expect, it, vi } from "vitest";
import { probeThreadOnServer } from "./thread-probe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeThreadOnServer", () => {
  it("reports a thread as missing only on a 404", async () => {
    const results: string[] = [];

    for (const status of [200, 404, 401, 403, 502]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      results.push(
        await probeThreadOnServer("https://alexb.omnyo.link/", "thr_1"),
      );
    }

    expect(results).toEqual([
      "found",
      "missing",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
});
