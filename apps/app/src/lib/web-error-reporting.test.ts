// @vitest-environment jsdom
import { defaultAppSettings } from "@omnyo/domain";
import { BrowserClient, captureException, getClient } from "@sentry/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { PluginAppOverlays } from "@/components/plugin/PluginAppOverlays";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { defineSplit } from "./define-split";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "./plugin-frontend-boot-state";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import {
  recordSplitDownloadFailure,
  recordSplitImportFailure,
} from "./split-load";
import {
  applyWebErrorReporting,
  createRootErrorHandler,
  isWebErrorReportingActive,
  readLastDeliveredWebErrorEventId,
  resolveWebErrorReportingTarget,
  scrubReportedText,
  scrubReportedUrl,
  scrubWebErrorEvent,
  startShelfMoveTiming,
} from "./web-error-reporting";

type Envelope = Parameters<
  ReturnType<
    ConstructorParameters<typeof BrowserClient>[0]["transport"]
  >["send"]
>[0];

const FAKE_TOKEN = [
  "abcdefgh",
  "ijklmnop",
  "qrstuvwx",
  "yz012345",
  "6789",
].join("");

const TARGET = {
  dsn: "https://public@sentry.example.invalid/42",
  release: "0.46.300+private.1",
};

function recordingTransport() {
  const envelopes: Envelope[] = [];

  return {
    envelopes,
    transport: () => ({
      send: async (envelope: Envelope) => {
        envelopes.push(envelope);

        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  };
}

function sentEvents(envelopes: Envelope[]): Record<string, unknown>[] {
  return envelopes.flatMap(([, items]) =>
    items.flatMap(([header, payload]) =>
      header.type === "event" && typeof payload === "object" && payload !== null
        ? [payload as Record<string, unknown>]
        : [],
    ),
  );
}

afterEach(() => {
  applyWebErrorReporting(null);
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelector('meta[name="omnyo-web-release"]')?.remove();
  document.querySelector('meta[name="omnyo-web-source"]')?.remove();
});

describe("resolveWebErrorReportingTarget", () => {
  const settings = {
    ...defaultAppSettings,
    showUnhandledProviderEvents: false,
  };

  it("requires the setting, a DSN and a release", () => {
    expect(resolveWebErrorReportingTarget(undefined)).toBeNull();
    expect(
      resolveWebErrorReportingTarget({ generalSettings: settings }),
    ).toBeNull();
    expect(
      resolveWebErrorReportingTarget({
        generalSettings: settings,
        diagnostics: { release: TARGET.release },
      }),
    ).toBeNull();
    expect(
      resolveWebErrorReportingTarget({
        generalSettings: { ...settings, crashReportsEnabled: false },
        diagnostics: { release: TARGET.release, sentryDsn: TARGET.dsn },
      }),
    ).toBeNull();
    expect(
      resolveWebErrorReportingTarget({
        generalSettings: settings,
        diagnostics: { release: TARGET.release, sentryDsn: TARGET.dsn },
      }),
    ).toEqual({
      dsn: TARGET.dsn,
      release: "web-development",
      runtimeRelease: TARGET.release,
    });
  });

  it("keeps the loaded web identity when the coordinator reports a newer runtime", () => {
    const meta = document.createElement("meta");
    meta.name = "omnyo-web-release";
    meta.content = `web-${"a".repeat(64)}`;
    const source = document.createElement("meta");
    source.name = "omnyo-web-source";
    source.content = "b".repeat(40);
    document.head.append(meta, source);

    const resolve = (runtime: string) =>
      resolveWebErrorReportingTarget({
        generalSettings: settings,
        diagnostics: { release: runtime, sentryDsn: TARGET.dsn },
      });

    expect(resolve("1.0.67")).toEqual({
      dsn: TARGET.dsn,
      release: meta.content,
      sourceRevision: source.content,
      runtimeRelease: "1.0.67",
    });
    expect(resolve("1.0.68")).toEqual({
      dsn: TARGET.dsn,
      release: meta.content,
      sourceRevision: source.content,
      runtimeRelease: "1.0.68",
    });
    meta.content = "private-untrusted-meta";
    source.content = "private-untrusted-source";
    expect(resolve("1.0.68")?.release).toBe("web-development");
  });
});

describe("web error scrubbing", () => {
  it("removes uncontrolled fields while keeping owned frames and debug IDs", () => {
    const marker = "private-customer-draft";

    const event = scrubWebErrorEvent({
      type: undefined,
      message: marker,
      release: marker,
      fingerprint: [marker],
      exception: {
        values: [
          {
            type: marker,
            value: marker,
            stacktrace: {
              frames: [
                {
                  filename: `https://example.test/private/${marker}.js`,
                  function: marker,
                },
                {
                  filename:
                    "https://example.test/assets/index-AbCd1234.js?private=draft",
                  function: "privateCustomerDraft73",
                  lineno: 1,
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
            code_file: "https://example.test/assets/index-AbCd1234.js",
            debug_id: "12345678-1234-4234-8234-123456789abc",
          },
        ],
      },
    });

    expect(JSON.stringify(event)).not.toContain(marker);
    expect(JSON.stringify(event)).not.toContain("privateCustomerDraft73");
    expect(event.fingerprint).toBeUndefined();
    expect(event.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      {
        filename: "app:///assets/index-AbCd1234.js",
        lineno: 1,
      },
    ]);
    expect(event.debug_meta?.images).toEqual([
      {
        type: "sourcemap",
        code_file: "app:///assets/index-AbCd1234.js",
        debug_id: "12345678-1234-4234-8234-123456789abc",
      },
    ]);
  });

  it("strips origins, query strings and fragments from URLs", () => {
    expect(
      scrubReportedUrl(
        "https://device-348a629f.example-tailnet.ts.net:3000/assets/index-abc.js?v=1#x",
      ),
    ).toBe("app:///assets/index-abc.js");
    expect(scrubReportedUrl("blob:https://host.example/uuid-1")).toBe(
      "app:///uuid-1",
    );
  });

  it("redacts credentials, URL queries and home directories in messages", () => {
    const text = scrubReportedText(
      `load https://host.example/api/x?token=secret#frag failed for /Users/developer/project with Bearer ${FAKE_TOKEN}`,
    );

    expect(text).toContain("app:///api/x failed for ~/project");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("alex");
    expect(text).not.toContain(FAKE_TOKEN);
  });

  it("drops request, user, extra, breadcrumbs and contexts", () => {
    const scrubbed = scrubWebErrorEvent({
      type: undefined,
      request: { url: "https://host.example/chat?id=1" },
      user: { id: "u1", ip_address: "{{auto}}" },
      extra: { prompt: "hello" },
      breadcrumbs: [{ message: "clicked" }],
      contexts: { app: { app_name: "hello" } },
      tags: { other: "x" },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "bad https://host.example/a?b=c",
            mechanism: {
              type: "onerror",
              handled: false,
              data: { handler: "draft" },
            },
            stacktrace: {
              frames: [
                {
                  filename: "https://host.example/assets/app.js?v=2",
                  function: "render",
                  lineno: 1,
                  colno: 2,
                  vars: { draft: "hello" },
                  context_line: "const draft = 'hello'",
                },
              ],
            },
          },
        ],
      },
    });

    expect(scrubbed).not.toHaveProperty("request");
    expect(scrubbed).not.toHaveProperty("user");
    expect(scrubbed).not.toHaveProperty("extra");
    expect(scrubbed).not.toHaveProperty("breadcrumbs");
    expect(scrubbed).not.toHaveProperty("contexts");
    expect(scrubbed.tags).toEqual({ service: "web" });
    expect(scrubbed.exception?.values?.[0]).toEqual({
      type: "TypeError",
      value: "TypeError",
      mechanism: { type: "onerror", handled: false },
      stacktrace: {
        frames: [
          {
            filename: "app:///assets/app.js",
            lineno: 1,
            colno: 2,
          },
        ],
      },
    });
  });
});

describe("applyWebErrorReporting", () => {
  it("sends only to the same-origin relay and cancels pending delivery on withdrawal", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error("aborted");

      return new Response(null, { status: 204 });
    });

    vi.stubGlobal("fetch", fetch);
    applyWebErrorReporting(TARGET);
    const client = getClient();
    captureException(new Error("private-error"));
    await client?.flush(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/system/web-errors");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      redirect: "error",
      headers: { "content-type": "application/json" },
    });
    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain(
      "private-error",
    );
    let signal: AbortSignal | null | undefined;
    fetch.mockImplementation(async (_url, init) => {
      signal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    captureException(new Error("another-private-error"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    applyWebErrorReporting(null);
    expect(signal?.aborted).toBe(true);
    await client?.flush(1_000);
    captureException(new Error("after-refusal"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "timeout", "network"] as const)(
    "includes safe split %s metadata from the original exception in the final envelope",
    async (kind) => {
      const { envelopes, transport } = recordingTransport();
      const release = `web-${"b".repeat(64)}`;
      applyWebErrorReporting(
        { ...TARGET, release, runtimeRelease: "1.0.68" },
        transport,
      );
      const error = new Error("private-origin/path?private=request-content");
      error.name = "SplitDownloadError";
      error.stack =
        "SplitDownloadError: private-request-content\n    at downloadBeforeImport (https://private.example/assets/index-AbCd1234.js:12:4)";
      recordSplitDownloadFailure(
        error,
        kind === "http"
          ? {
              kind,
              status: 503,
              assetName: "editor-AbCd1234.js",
              downloadPhase: "request",
              online: false,
            }
          : {
              kind,
              assetName: "editor-AbCd1234.js",
              downloadPhase: kind === "timeout" ? "request" : "body",
              online: true,
              ...(kind === "timeout"
                ? { assetAttemptId: "private/invalid-attempt" }
                : {}),
            },
        3,
      );
      captureException(error);
      await getClient()?.flush(1_000);
      const [event] = sentEvents(envelopes);
      expect(event).toMatchObject({
        release,
        contexts: {
          diagnostic: {
            operation: "split-load",
            stage: "download",
            kind,
            outcome: "terminal",
            attempt: 3,
            assetName: "editor-AbCd1234.js",
            downloadPhase: kind === "network" ? "body" : "request",
            online: kind !== "http",
            ...(kind === "http" ? { status: 503 } : {}),
          },
        },
        exception: {
          values: [
            {
              type: "SplitDownloadError",
              stacktrace: {
                frames: [
                  {
                    filename: "app:///assets/index-AbCd1234.js",
                    lineno: 12,
                    colno: 4,
                  },
                ],
              },
            },
          ],
        },
      });
      expect(JSON.stringify(envelopes)).not.toContain("private");
    },
  );

  it("keeps the cause unknown while classifying import refusal and rejecting unsafe asset names", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);

    const error = new TypeError(
      "Importing a module script failed. private-request-content",
    );

    const stack = error.stack;
    recordSplitImportFailure(
      error,
      "https://private.example/assets/private-document.js?private=draft",
      2,
      "downloaded",
    );
    captureException(error);
    await getClient()?.flush(1_000);
    expect(sentEvents(envelopes)[0]).toMatchObject({
      contexts: {
        diagnostic: {
          operation: "split-load",
          stage: "import",
          kind: "module",
          failureClass: "unknown",
          outcome: "terminal",
          attempt: 2,
          importFailure: "fetch",
          preflight: "downloaded",
          online: true,
        },
      },
    });
    expect(JSON.stringify(envelopes)).not.toContain("private-request");
    expect(JSON.stringify(envelopes)).not.toContain("private.example");
    expect(error.stack).toBe(stack);
  });

  it("does not replay old captures after withdrawal and regrant", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    const oldClient = getClient();
    let release: (() => void) | undefined;
    oldClient?.addEventProcessor(
      (event) =>
        new Promise((resolve) => {
          release = () => resolve(event);
        }),
    );
    captureException(new Error("captured before withdrawal"));
    applyWebErrorReporting(null);
    applyWebErrorReporting(TARGET, transport);
    release?.();
    await oldClient?.flush(1_000);
    expect(sentEvents(envelopes)).toHaveLength(0);
    captureException(new Error("current grant"));
    await getClient()?.flush(1_000);
    expect(sentEvents(envelopes)).toHaveLength(1);
  });

  it("scrubs post-capture enrichment and keeps web and runtime identities separate", async () => {
    const { envelopes, transport } = recordingTransport();

    const target = {
      ...TARGET,
      release: `web-${"a".repeat(64)}`,
      runtimeRelease: "1.0.67",
    };

    applyWebErrorReporting(target, transport);
    const client = getClient();
    client?.on("beforeSendEvent", (event) => {
      event.release = "private-mutated-release";
      event.fingerprint = ["private-customer"];
      event.message = "private-prompt";
      event.tags = { private: "private-customer" };
    });
    captureException(new TypeError("private-error"));
    await client?.flush(1_000);
    expect(JSON.stringify(envelopes)).not.toContain("private-");
    expect(sentEvents(envelopes)[0]).toMatchObject({
      release: target.release,
      contexts: { artifact: { runtimeRelease: "1.0.67" } },
      exception: { values: [{ type: "TypeError", value: "TypeError" }] },
    });
  });

  it("sends scrubbed errors while enabled and stops immediately when disabled", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    expect(isWebErrorReportingActive()).toBe(true);
    const client = getClient();
    expect(client).toBeDefined();

    captureException(new Error("failed at /Users/developer/x?draft=1"));
    await client?.flush(1_000);

    const [event] = sentEvents(envelopes);
    expect(event).toMatchObject({
      release: TARGET.release,
      environment: "production",
      tags: { service: "web" },
    });
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(JSON.stringify(event)).not.toContain("alex");

    applyWebErrorReporting(null);
    expect(isWebErrorReportingActive()).toBe(false);
    expect(getClient()).toBeUndefined();
    captureException(new Error("after opt-out"));
    await client?.flush(1_000);
    expect(sentEvents(envelopes)).toHaveLength(1);
  });

  it("emits one content-free warning for a slow Shelf move and ignores fast moves", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    const client = getClient();
    client?.addEventProcessor((event) => ({
      ...event,
      contexts: {
        ...event.contexts,
        shelfMove: { ...event.contexts?.shelfMove, threadId: FAKE_TOKEN },
      },
    }));
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      frames.push(callback),
    );

    const showFrame = () => {
      frames.shift()?.(performance.now());
      frames.shift()?.(performance.now());
    };

    const fast = startShelfMoveTiming();
    fast?.optimisticStarted();
    fast?.requestStarted();
    fast?.requestSettled();
    fast?.finish("saved");
    showFrame();

    const responseMetric = {
      name: "omnyo_shelve",
      description: "da16f59d-3243-439f-b838-624b285247e5",
    };

    class ResourceTiming {
      constructor(
        readonly serverTiming: (typeof responseMetric)[],
        readonly responseStart: number,
        readonly responseEnd: number,
      ) {}
    }

    const entries = [
      new ResourceTiming(
        [{ ...responseMetric, description: "other" }],
        200,
        500,
      ),
      new ResourceTiming([responseMetric], 2_420, 2_820),
    ];

    const disconnect = vi.fn();
    vi.stubGlobal("PerformanceResourceTiming", ResourceTiming);
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = ["resource"];
        observe() {}
        takeRecords() {
          return entries;
        }
        disconnect = disconnect;
      },
    );

    const slow = startShelfMoveTiming();
    clock.mockReturnValue(100);
    slow?.optimisticStarted();
    clock.mockReturnValue(120);
    slow?.requestStarted();
    clock.mockReturnValue(233);
    showFrame();
    slow?.responseTiming(
      `omnyo_shelve;dur=2150;desc="${responseMetric.description}"`,
    );
    clock.mockReturnValue(2_937);
    slow?.requestSettled();
    clock.mockReturnValue(2_938);
    slow?.finish("saved");

    expect(startShelfMoveTiming()).toBeUndefined();
    await client?.flush(1_000);

    const events = sentEvents(envelopes);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "Slow Shelf move",
      level: "warning",
      fingerprint: ["slow-shelf-move"],
      release: TARGET.release,
      contexts: {
        shelfMove: {
          outcome: "saved",
          beforeOptimisticMs: 100,
          optimisticCommitMs: 20,
          foregroundFrameMs: 233,
          requestMs: 2_817,
          coordinatorMs: 2_150,
          responseStartMs: 2_300,
          responseEndMs: 2_700,
          totalMs: 2_938,
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(events)).not.toContain(responseMetric.description);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(readLastDeliveredWebErrorEventId()).toBeNull();
  });

  it("drops a slow Shelf move observed across diagnostic withdrawal", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    const client = getClient();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const timing = startShelfMoveTiming();

    expect(timing).toBeDefined();
    applyWebErrorReporting(null);
    applyWebErrorReporting(TARGET, transport);
    clock.mockReturnValue(6_000);
    timing?.finish("failed");

    await client?.flush(1_000);
    await getClient()?.flush(1_000);
    expect(envelopes).toHaveLength(0);
  });

  it("remembers the last delivered error until reporting stops", async () => {
    const { envelopes, transport } = recordingTransport();
    expect(readLastDeliveredWebErrorEventId()).toBeNull();

    applyWebErrorReporting(TARGET, transport);
    captureException(new Error("first"));
    captureException(new Error("second"));
    await getClient()?.flush(1_000);

    const lastEventId = sentEvents(envelopes).at(-1)?.event_id;
    expect(lastEventId).toMatch(/^[0-9a-f]{32}$/);
    expect(readLastDeliveredWebErrorEventId()).toBe(lastEventId);

    applyWebErrorReporting(null);
    expect(readLastDeliveredWebErrorEventId()).toBeNull();
  });

  it("does not remember an error the server rejected", async () => {
    applyWebErrorReporting(TARGET, () => ({
      send: async () => ({ statusCode: 429 }),
      flush: async () => true,
    }));
    captureException(new Error("rate limited"));
    await getClient()?.flush(1_000);

    expect(readLastDeliveredWebErrorEventId()).toBeNull();
  });

  it("captures React root errors only while reporting is active", async () => {
    const logged: unknown[] = [];
    const handler = createRootErrorHandler((error) => logged.push(error));
    const inactiveError = new Error("inactive");
    handler(inactiveError, { componentStack: "\n    in App" });
    expect(inactiveError.cause).toBeUndefined();

    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    handler(new Error("render failed"), { componentStack: "\n    in App" });
    await getClient()?.flush(1_000);

    expect(logged).toHaveLength(2);
    expect(sentEvents(envelopes)).toHaveLength(1);
  });

  it.each([
    {
      hasPluginFrame: true,
      slotId: "privateWorkspaceLabel_4831",
    },
    {
      hasPluginFrame: false,
      slotId: "overlay-v1",
    },
    { hasPluginFrame: true, slotId: "a".repeat(97) },
  ])(
    "reports the caught overlay bundle without its slot ID (plugin frame: $hasPluginFrame)",
    async ({ hasPluginFrame, slotId }) => {
      const { envelopes, transport } = recordingTransport();
      const hash = "0123456789abcdef";
      const assetPath = `/api/v1/plugin-app-assets/${hash}/app.js`;

      function BrokenOverlay(): never {
        const error = new TypeError("private exception text");
        const url = `${window.location.origin}${assetPath}?retry=private-query`;
        error.stack = [
          "TypeError: private exception text",
          ...(hasPluginFrame ? [`    at privateFunction (${url}:19:87)`] : []),
          `    at foreignFrame (https://external.example.invalid${assetPath}:92:79)`,
          `    at staleFrame (${url.replace(hash, "fedcba9876543210")}:72:99)`,
          "    at render (https://app.example.invalid/assets/startup-shell.js:8:12)",
        ].join("\n");
        throw error;
      }

      vi.spyOn(console, "warn").mockImplementation(() => {});
      applyWebErrorReporting(TARGET, transport);
      markPluginFrontendsSettled();

      try {
        setPluginSlotRegistrations(
          "overlay-plugin",
          makePluginRegistrationSet({
            appOverlays: [{ id: slotId, component: BrokenOverlay }],
          }),
          hash,
        );
        render(createElement(PluginAppOverlays), {
          onCaughtError: createRootErrorHandler(() => {}),
        });
        await getClient()?.flush(1_000);
        const events = sentEvents(envelopes);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          contexts: expect.objectContaining({
            pluginOverlay: expect.objectContaining({
              pluginId: "overlay-plugin",
              bundleHash: hash,
            }),
          }),
          exception: {
            values: expect.arrayContaining([
              expect.objectContaining({
                type: "TypeError",
                value: "TypeError",
                stacktrace: {
                  frames: [
                    {
                      filename: "app:///assets/startup-shell.js",
                      lineno: 8,
                      colno: 12,
                      in_app: true,
                    },
                    ...(hasPluginFrame
                      ? [
                          {
                            filename: `app://${assetPath}`,
                            lineno: 19,
                            colno: 87,
                            in_app: true,
                          },
                        ]
                      : []),
                  ],
                },
              }),
            ]),
          },
        });
        const serialized = JSON.stringify(envelopes);
        expect(serialized).not.toMatch(
          /private exception text|privateFunction|private-query|https?:/,
        );

        expect(serialized).not.toContain(slotId);
      } finally {
        cleanup();
        resetAllCrashedPluginSlotsForTest();
        resetPluginSlotStoreForTest();
        resetPluginFrontendBootStateForTest();
      }
    },
  );
});

describe("split failure capture ownership", () => {
  it.each([true, false])(
    "correlates the final header timeout only when error reporting is enabled (%s)",
    async (enabled) => {
      const { envelopes, transport } = recordingTransport();

      if (enabled) applyWebErrorReporting(TARGET, transport);
      vi.useFakeTimers();
      const id = `capture-stalled-${enabled}`;
      const manifest = document.createElement("script");
      manifest.id = "omnyo-prefetch-manifest";
      manifest.type = "application/json";
      manifest.textContent = JSON.stringify({
        files: [`/assets/${id}-AbCd1234.js`],
        splits: { [id]: [0] },
      });
      document.head.append(manifest);

      const fetch = vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );

      vi.stubGlobal("fetch", fetch);
      const load = vi.fn(async () => () => null);
      const Split = defineSplit({ id, load, loading: () => null });

      try {
        render(createElement(Split), {
          onCaughtError: createRootErrorHandler(() => {}),
        });
        await act(async () => vi.advanceTimersByTimeAsync(32_000));
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
        expect(load).not.toHaveBeenCalled();

        const attemptIds = fetch.mock.calls.map(([, options]) =>
          new Headers(options.headers).get("x-omnyo-asset-attempt"),
        );

        expect(attemptIds).toEqual([
          null,
          null,
          enabled ? expect.stringMatching(/^[a-f0-9-]{36}$/) : null,
        ]);
        vi.useRealTimers();
        await getClient()?.flush(1_000);
        const events = sentEvents(envelopes);
        expect(events).toHaveLength(enabled ? 1 : 0);

        if (enabled)
          expect(events[0]).toMatchObject({
            contexts: {
              diagnostic: {
                kind: "timeout",
                downloadPhase: "request",
                attempt: 3,
                assetAttemptId: attemptIds[2],
              },
            },
          });
      } finally {
        manifest.remove();
      }
    },
  );

  it.each([
    [
      new TypeError(
        "Failed to fetch dynamically imported module: private-value",
      ),
      "fetch",
    ],
    [new Error("Unable to preload CSS for private-value"), "css-preload"],
    [new SyntaxError("private-value"), "syntax"],
    [new TypeError("private-value"), "exception"],
  ] as const)(
    "classifies an owned import without sending its message",
    async (error, importFailure) => {
      const { envelopes, transport } = recordingTransport();
      applyWebErrorReporting(TARGET, transport);
      recordSplitImportFailure(error, undefined, 1, "unlisted");
      captureException(error);
      await getClient()?.flush(1_000);
      expect(sentEvents(envelopes)[0]).toMatchObject({
        contexts: {
          diagnostic: { importFailure, preflight: "unlisted", online: true },
        },
      });
      expect(JSON.stringify(envelopes)).not.toContain("private-value");
    },
  );

  it("does not capture a failed speculative preload that recovers when opened", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);
    const load = vi.fn<() => Promise<() => ReturnType<typeof createElement>>>();
    load.mockRejectedValueOnce(
      new TypeError("Importing a module script failed."),
    );
    load.mockResolvedValueOnce(() =>
      createElement("p", null, "Recovered feature"),
    );

    const Split = defineSplit({
      id: "capture-recovered",
      load,
      loading: () => null,
    });

    await Split.preload();
    render(createElement(Split), {
      onCaughtError: createRootErrorHandler(() => {}),
    });
    expect(await screen.findByText("Recovered feature")).toBeTruthy();
    await getClient()?.flush(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(sentEvents(envelopes)).toHaveLength(0);
  });

  it("captures one terminal feature failure after React shows its recovery action", async () => {
    const { envelopes, transport } = recordingTransport();
    applyWebErrorReporting(TARGET, transport);

    const load = vi.fn(async () => {
      throw new TypeError("Importing a module script failed. private-value");
    });

    const Split = defineSplit({
      id: "capture-terminal",
      load,
      loading: () => null,
    });

    render(createElement(Split), {
      onCaughtError: createRootErrorHandler(() => {}),
    });
    expect(
      await screen.findByRole("button", { name: "Reload Omnyo" }),
    ).toBeTruthy();
    await act(async () => {
      await getClient()?.flush(1_000);
    });
    expect(load).toHaveBeenCalledOnce();
    expect(sentEvents(envelopes)).toHaveLength(1);
    expect(sentEvents(envelopes)[0]).toMatchObject({
      contexts: {
        diagnostic: {
          importFailure: "fetch",
          preflight: "unlisted",
          outcome: "terminal",
        },
      },
    });
    expect(JSON.stringify(envelopes)).not.toContain("private-value");
  });
});
