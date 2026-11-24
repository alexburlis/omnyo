import { describe, expect, it } from "vitest";
import { createPreviewsArea } from "../src/areas/previews.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("preview SDK transport", () => {
  it("restricts restart to the encoded stored ID and request identity", async () => {
    const requests: { url: string; method: string; body: string }[] = [];

    const previews = createPreviewsArea({
      transport: createHttpTransport({
        baseUrl: "http://omnyo.test",
        runtime: "browser",
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: String(init?.body),
          });

          return Response.json({
            state: "host-offline",
            checkedAt: 1,
            detail: null,
            runId: null,
          });
        },
      }),
    });

    const result = await previews.restart({
      previewId: "preview/other",
      requestId: "request-1",
      ...{ argv: ["unregistered-command"], hostId: "other-host", port: 9999 },
    });

    expect(result.state).toBe("host-offline");
    expect(requests).toEqual([
      {
        url: "http://omnyo.test/api/v1/previews/preview%2Fother/restart",
        method: "POST",
        body: '{"requestId":"request-1"}',
      },
    ]);
  });
});
