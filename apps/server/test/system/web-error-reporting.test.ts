import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setAppSettings, getAppSettings } from "@omnyo/db";
import { describe, expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";

const privateOrigin = "https://private-fixture.example";

const eventId = "a".repeat(32);

function body(event: Record<string, unknown> = {}) {
  return JSON.stringify({
    envelope: [
      JSON.stringify({
        dsn: privateOrigin,
        trace: { user_segment: "private-subject" },
      }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: eventId, ...event }),
    ].join("\n"),
  });
}

describe("same-origin browser diagnostics relay", () => {
  it("forwards sanitized envelopes using server headers and never the browser origin", async () => {
    const requests: {
      url: string | undefined;
      headers: unknown;
      body: string;
    }[] = [];

    const receiver = createServer(async (request, response) => {
      let received = "";

      for await (const chunk of request) received += String(chunk);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: received,
      });
      response.writeHead(200).end();
    });

    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    const { port } = receiver.address() as AddressInfo;

    try {
      await withTestHarness(async (harness) => {
        harness.config.isDevelopment = false;
        harness.config.appUrl = privateOrigin;
        harness.config.errorReportingDsn = `http://public@127.0.0.1:${port}/42`;

        const response = await harness.app.request(
          "/api/v1/system/web-errors",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: privateOrigin,
              referer: privateOrigin + "/private",
              "x-forwarded-for": "192.0.2.123",
            },
            body: body({
              message: privateOrigin,
              release: `web-${"b".repeat(64)}`,
              contexts: {
                artifact: { sourceRevision: "c".repeat(40) },
                diagnostic: {
                  operation: "request",
                  stage: "send",
                  failureClass: "timeout",
                  outcome: "terminal",
                },
              },
              exception: {
                values: [
                  {
                    type: "TypeError",
                    value: privateOrigin,
                    stacktrace: {
                      frames: [
                        {
                          filename:
                            privateOrigin +
                            "/assets/index-AbCd1234.js?secret=1",
                          lineno: 12,
                        },
                      ],
                    },
                  },
                ],
              },
              debug_meta: {
                images: [
                  {
                    type: "sourcemap",
                    code_file:
                      privateOrigin + "/assets/index-AbCd1234.js?secret=1",
                    debug_id: "f2345678-1234-1234-1234-123456789abc",
                  },
                ],
              },
            }),
          },
        );

        expect(response.status).toBe(204);
        expect(requests).toHaveLength(1);
        const request = requests[0];
        expect(JSON.stringify(request)).not.toMatch(
          /private-|192\.0\.2\.123|secret=1/u,
        );
        expect(request?.url).toBe(
          "/api/42/envelope/?sentry_key=public&sentry_version=7",
        );
        expect(request?.body).toContain("app:///assets/index-AbCd1234.js");
        expect(request?.body).toContain('"service":"web"');
        setAppSettings(harness.db, {
          ...getAppSettings(harness.db),
          crashReportsEnabled: false,
        });
        harness.hub.notifySystem(["config-changed"]);

        const declined = await harness.app.request(
          "/api/v1/system/web-errors",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body(),
          },
        );

        expect(declined.status).toBe(403);
        expect(requests).toHaveLength(1);
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed without an effective target and rejects non-event payloads", async () => {
    await withTestHarness(async (harness) => {
      const request = () =>
        harness.app.request("/api/v1/system/web-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body(),
        });

      expect((await request()).status).toBe(403);
      harness.config.isDevelopment = false;
      harness.config.errorReportingDsn = "https://public@sentry.invalid/42";

      const invalid = await harness.app.request("/api/v1/system/web-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: '{}\n{"type":"replay_event"}\n{}' }),
      });

      expect(invalid.status).toBe(400);

      const sensitive = await harness.app.request("/api/v1/system/web-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body({ user: { id: "private-subject" } }),
      });

      expect(sensitive.status).toBe(400);
    });
  });
});
