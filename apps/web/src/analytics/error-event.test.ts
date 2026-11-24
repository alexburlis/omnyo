import type { ErrorEvent } from "@sentry/core";
import { describe, expect, it } from "vitest";

import {
  rebuildErrorEvent,
  routeSection,
  type ErrorReportIdentity,
} from "./error-event";
import { ownServerFrame, rebuildServerEvent } from "./server-errors";

const FAKE_TOKEN = ["ghp", "_", "x".repeat(36)].join("");

const browser: ErrorReportIdentity = {
  service: "website-browser",
  environment: "production",
  platform: "javascript",
  ownFrame: (filename) =>
    filename.startsWith("https://omnyohq.com/")
      ? filename.split("?", 1)[0]
      : undefined,
};

function hostileEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_790_000_000,
    level: "error",
    user: { id: "visitor", ip_address: "198.51.100.7", email: "a@b.example" },
    request: {
      url: "https://omnyohq.com/features?token=secret",
      headers: { cookie: "omnyo_analytics_consent_v1=accepted:1" },
    },
    breadcrumbs: [{ message: "clicked Download" }],
    extra: { note: "private" },
    contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) } },
    server_name: "omnyo-landing-1",
    exception: {
      values: [
        {
          type: "TypeError",
          value: `Failed for jane@example.com at https://omnyohq.com/guides/x?session=abc#top with ${FAKE_TOKEN}`,
          mechanism: { type: "onerror", handled: false },
          stacktrace: {
            frames: [
              { filename: "chrome-extension://abc/content.js", lineno: 1 },
              {
                filename: "https://omnyohq.com/assets/main-abc123.js?v=2",
                function: "render",
                lineno: 12,
                colno: 340,
                vars: { secret: "x" },
              },
            ],
          },
        },
      ],
    },
  };
}

describe("rebuildErrorEvent", () => {
  it("keeps only the allowlisted diagnosis fields", () => {
    const rebuilt = rebuildErrorEvent(hostileEvent(), browser, {
      stage: "browser",
      route: "features",
    });

    const wire = JSON.stringify(rebuilt);

    for (const leaked of [
      "198.51.100.7",
      "jane@example.com",
      "a@b.example",
      "session=abc",
      "token=secret",
      FAKE_TOKEN,
      "chrome-extension",
      "Download",
      "private",
      "omnyo-landing-1",
      "trace_id",
      "vars",
    ])
      expect(wire).not.toContain(leaked);

    expect(rebuilt).toEqual({
      type: undefined,
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_790_000_000,
      level: "error",
      platform: "javascript",
      environment: "production",
      tags: {
        runtime: "website",
        service: "website-browser",
        stage: "browser",
        route: "features",
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value:
              "Failed for [email] at https://omnyohq.com/guides/x with [redacted]",
            mechanism: { type: "onerror", handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "https://omnyohq.com/assets/main-abc123.js",
                  function: "render",
                  in_app: true,
                  lineno: 12,
                  colno: 340,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("drops errors that carry none of the site's own code", () => {
    const event = hostileEvent();
    const [exception] = event.exception?.values ?? [];

    if (exception?.stacktrace?.frames !== undefined)
      exception.stacktrace.frames = exception.stacktrace.frames.slice(0, 1);

    expect(rebuildErrorEvent(event, browser, {})).toBeNull();
  });
});

describe("server error events", () => {
  it("maps bundle frames to app paths and hides host paths", () => {
    expect(ownServerFrame("/app/dist/server/assets/router-1a2b.js")).toBe(
      "app:///dist/server/assets/router-1a2b.js",
    );
    expect(ownServerFrame("file:///app/dist/server/server-entry.js")).toBe(
      "app:///dist/server/server-entry.js",
    );
    expect(ownServerFrame("node:internal/process/task_queues")).toBe(
      "node:internal/process/task_queues",
    );
    expect(ownServerFrame("/home/runner/secret/file.js")).toBeUndefined();
  });

  it("reduces the request path tag to a route section", () => {
    const event: ErrorEvent = {
      type: undefined,
      tags: { stage: "request", route: "/guides/private-name", other: "x" },
      exception: {
        values: [
          {
            type: "Error",
            value: "loader failed",
            stacktrace: {
              frames: [{ filename: "/app/dist/server/server-entry.js" }],
            },
          },
        ],
      },
    };

    expect(rebuildServerEvent(event)?.tags).toEqual({
      runtime: "website",
      service: "website-server",
      stage: "request",
      route: "guides",
    });
  });

  it.each([
    ["/", "home"],
    ["/features/remote-access", "features"],
    ["/w/abc", "other"],
    ["/unknown", "other"],
  ])("puts %s in the %s section", (path, section) => {
    expect(routeSection(path)).toBe(section);
  });
});
