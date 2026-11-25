import { it, expect } from "vitest";
import { serve } from "@hono/node-server";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getAppSettings, setAppSettings } from "@omnyo/db";
import { pluginListResponseSchema } from "@omnyo/server-contract";
import { redactCredentialText, turnScope } from "@omnyo/domain";
import { createApp } from "../../src/server.js";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { runAppPerformance } from "./app-performance.js";
import {
  seedEvent,
  seedPrimaryHost,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";

type FrameMeasurement = {
  samples: number[];
  stop: () => void;
};

type ReadResponseDiagnostic = {
  path: string;
  status: number;
  phase: string;
  elapsedMs: number;
};

it.skipIf(!process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT)(
  "records cold routes and a confirmed then delayed thread reload in real Chrome",
  async () => {
    const modulePath = process.env.OMNYO_FRONTEND_PLAYWRIGHT_MODULE;
    const output = process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT;
    const appDist = process.env.OMNYO_FRONTEND_APP_DIST;

    if (!modulePath || !output || !appDist)
      throw new Error(
        "OMNYO_FRONTEND_PLAYWRIGHT_MODULE, OMNYO_FRONTEND_MEASUREMENT_OUTPUT and OMNYO_FRONTEND_APP_DIST are required",
      );

    const requestDelayMs = Number(
      process.env.OMNYO_FRONTEND_REQUEST_DELAY_MS ?? "0",
    );

    if (
      !Number.isInteger(requestDelayMs) ||
      requestDelayMs < 0 ||
      requestDelayMs > 2000
    )
      throw new Error("Request delay must be an integer from 0 to 2000ms");

    const { chromium } = await import(modulePath);
    const harness = await createTestAppHarness();
    setAppSettings(harness.db, {
      ...getAppSettings(harness.db),
      onboardingCompletedAt: "2026-10-16T00:00:00.000Z",
    });

    const { host, session, thread, environment, project } = seedThreadFixture(
      harness,
      {
        thread: { title: "Performance fixture A" },
      },
    );

    seedPrimaryHost(harness.deps, host.id);

    for (let i = 0; i < 40; i++) {
      const common = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "performance-fixture",
        scope: turnScope(`fixture-${i}`),
      };

      seedEvent(harness.deps, {
        ...common,
        sequence: i * 3 + 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: i * 3 + 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: `answer-${i}`,
            text: `Performance answer ${i}. This synthetic completed message is readable.`,
          },
        },
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: i * 3 + 3,
        type: "turn/completed",
        data: { status: "completed" },
      });
    }

    const heavy = seedThreadFixture(harness, {
      thread: { title: "Heavy render fixture", status: "active" },
    });

    const heavyTurn = {
      threadId: heavy.thread.id,
      environmentId: heavy.environment.id,
      providerThreadId: "heavy-fixture",
      scope: turnScope("heavy-turn"),
    } as const;

    const heavyText =
      "Selection sentinel stays stable.\n\n" +
      "A **bold** word and an [example](https://example.com) with `inline code` remain readable. ".repeat(
        1500,
      );

    seedThreadRuntimeState(harness.deps, heavyTurn);
    seedTurnStarted(harness.deps, { ...heavyTurn, turnId: "heavy-turn" });
    seedEvent(harness.deps, {
      ...heavyTurn,
      sequence: 4,
      type: "item/started",
      data: {
        item: { type: "agentMessage", id: "heavy-answer", text: "" },
      },
    });

    seedEvent(harness.deps, {
      ...heavyTurn,
      sequence: 5,
      type: "item/agentMessage/delta",
      data: { itemId: "heavy-answer", delta: heavyText + "\n" },
    });

    const responders = [{ host, session }, heavy].map(({ host, session }) =>
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health")
            return {
              ok: true,
              result: {
                supported: true,
                health: {
                  status: "not_installed",
                  statusMessage: null,
                  accountEmail: null,
                  planLabel: null,
                  installedVersion: null,
                  minimumSupportedVersion: null,
                  canInstall: false,
                  canUpdate: false,
                  loginCommand: null,
                },
              },
            };

          if (request.command.type === "provider.list_models")
            return {
              ok: true,
              result: {
                models: [availableModelFixture({ model: "test-default" })],
                selectedOnlyModels: [],
              },
            };

          return {
            ok: false,
            errorCode: "fixture_unavailable",
            errorMessage: "The performance fixture does not execute host work",
          };
        },
      }),
    );

    let app = createApp(harness.deps, {
      staticDir: resolve(appDist),
    });

    await app.pluginService.start({
      hold: {
        sources: listBundledPluginRegistrations()
          .filter(
            (plugin) =>
              process.env.OMNYO_PERFORMANCE_SUITE !== "1" ||
              plugin.name !== "thread-list",
          )
          .map((p) => `builtin:${p.name}`),
        detail: "Provider fixture already registered",
        isActive: async () => true,
      },
    });

    const server = serve({
      hostname: "127.0.0.1",
      port: process.env.OMNYO_PERFORMANCE_SUITE === "1" ? 0 : 41999,
      fetch: async (request, env) => {
        if (
          new URL(request.url).pathname.startsWith("/api/") &&
          requestDelayMs > 0
        )
          await new Promise((resolve) => setTimeout(resolve, requestDelayMs));

        return app.app.fetch(request, env);
      },
    });

    app.injectWebSocket(server);
    const applications = [app];
    const closedApplications = new Set<ReturnType<typeof createApp>>();
    const stoppedApplications = new Set<ReturnType<typeof createApp>>();

    try {
      const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });

      const results: unknown[] = [];
      const threadPath = `/projects/${project.id}/threads/${thread.id}`;
      let completed = false;

      try {
        const address = server.address();

        if (address === null || typeof address === "string")
          throw new Error("Performance server did not expose a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;

        const inventoryPath = process.env.OMNYO_FRONTEND_PLUGIN_INVENTORY;

        if (inventoryPath) {
          const { checkPluginInventory } = await import(
            new URL(
              "../../../../tests/qa/plugin-loading/inventory.mjs",
              import.meta.url,
            ).href
          );

          results.push(
            await checkPluginInventory({ browser, origin, inventoryPath }),
          );
          completed = true;

          return;
        }

        const pluginLoadingOutput =
          process.env.OMNYO_FRONTEND_PLUGIN_LOADING_PROOF_OUTPUT;

        if (pluginLoadingOutput) {
          const proof = await import(
            new URL(
              "../../../../tests/qa/plugin-loading/proof.mjs",
              import.meta.url,
            ).href
          );

          results.push(
            await proof.runPluginLoadingProof({
              browser,
              origin,
              output: pluginLoadingOutput,
              appBuild: {
                dist: appDist,
                indexSha256: createHash("sha256")
                  .update(await readFile(resolve(appDist, "index.html")))
                  .digest("hex"),
              },
              validateRegistry: pluginListResponseSchema.parse,
              notifyChanged: () =>
                harness.deps.hub.notifySystem(["plugins-changed"]),
            }),
          );
          completed = true;

          return;
        }

        if (process.env.OMNYO_PERFORMANCE_SUITE === "1") {
          await runAppPerformance({
            browser,
            harness,
            origin,
            thread,
            project,
            environment,
            host,
            session,
            heavy,
            heavyTurn,
            output,
            appDist,
          });
          completed = true;

          return;
        }

        const sidebarOutput = process.env.OMNYO_FRONTEND_SIDEBAR_PROOF_OUTPUT;

        if (sidebarOutput) {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          });

          try {
            await context.route(
              (url: URL) => url.origin !== origin,
              (route: any) => route.abort(),
            );
            const page = await context.newPage();

            const proof = await import(
              new URL(
                "../../../../tests/qa/sidebar-rail/proof.mjs",
                import.meta.url,
              ).href
            );

            const usageDirectory = process.env.OMNYO_FRONTEND_SIDEBAR_USAGE_DIR;

            const resourcesDirectory =
              process.env.OMNYO_FRONTEND_SIDEBAR_RESOURCES_DIR;

            const fixture =
              usageDirectory && resourcesDirectory
                ? await proof.installSidebarRailPluginFixtures(page, {
                    usageDirectory,
                    resourcesDirectory,
                    validateRegistry: pluginListResponseSchema.parse,
                  })
                : undefined;

            await page.goto(`${origin}${threadPath}`, {
              waitUntil: "domcontentloaded",
            });
            await page
              .getByText(
                "Performance answer 39. This synthetic completed message is readable.",
                { exact: true },
              )
              .waitFor({ state: "visible" });
            results.push(
              await proof.runSidebarRailProof(page, sidebarOutput, fixture),
            );
            completed = true;

            return;
          } finally {
            await context.unrouteAll({ behavior: "wait" });
            await context.close();
          }
        }

        for (const pathname of ["/settings", "/extensions", "/", threadPath]) {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          });

          await context.route(
            (url: URL) => url.origin !== origin,
            (route: any) => route.abort(),
          );
          const page = await context.newPage();
          const errors: string[] = [];
          const consoleErrors: string[] = [];
          const readResponses: ReadResponseDiagnostic[] = [];
          let phase = "cold";
          let phaseStart = performance.now();

          const requestStarts: {
            path: string;
            phase: string;
            elapsedMs: number;
          }[] = [];

          page.on("request", (request: any) => {
            const path = new URL(request.url()).pathname;

            if (
              path === "/api/v1/server/runtime" ||
              path.startsWith(`/api/v1/threads/${thread.id}`)
            )
              requestStarts.push({
                path,
                phase,
                elapsedMs: performance.now() - phaseStart,
              });
          });
          page.on("pageerror", (e: Error) =>
            errors.push(e.message.slice(0, 160)),
          );
          page.on("console", (message: any) => {
            if (message.type() === "error")
              consoleErrors.push(
                redactCredentialText(message.text()).slice(0, 600),
              );
          });
          page.on("response", (response: any) => {
            const path = new URL(response.url()).pathname;

            if (
              !path.startsWith(`/api/v1/threads/${thread.id}`) &&
              path !== "/api/v1/server/runtime"
            )
              return;

            const entry: ReadResponseDiagnostic = {
              path,
              status: response.status(),
              phase,
              elapsedMs: performance.now() - phaseStart,
            };

            readResponses.push(entry);
          });
          await page.goto(origin + pathname, { waitUntil: "domcontentloaded" });
          let coldReadableAfterDomMs: number | null = null;

          if (pathname === threadPath) {
            const start = Date.now();
            await page.waitForFunction(
              () =>
                [...document.querySelectorAll("p")].some((element) => {
                  const rect = element.getBoundingClientRect();

                  return (
                    element.textContent ===
                      "Performance answer 39. This synthetic completed message is readable." &&
                    element.checkVisibility({
                      visibilityProperty: true,
                      contentVisibilityAuto: true,
                    }) &&
                    rect.height > 0 &&
                    rect.top < innerHeight &&
                    rect.bottom > 0
                  );
                }),
              undefined,
              { polling: "raf" },
            );
            coldReadableAfterDomMs = Date.now() - start;
          }

          await page.waitForTimeout(1600);

          const data = await page.evaluate(() => ({
            text: document.body.innerText.slice(0, 2200),
            paint: performance
              .getEntriesByType("paint")
              .map((r) => ({ name: r.name, startTime: r.startTime })),
            resources: performance.getEntriesByType("resource").map((r) => ({
              path: new URL(r.name).pathname,
              duration: r.duration,
              responseEnd:
                r instanceof PerformanceResourceTiming ? r.responseEnd : 0,
              transferSize:
                r instanceof PerformanceResourceTiming ? r.transferSize : 0,
            })),
          }));

          results.push({
            pathname,
            ...data,
            errors,
            consoleErrors,
            readResponses: [...readResponses],
            requestStarts: [...requestStarts],
            coldReadableAfterDomMs,
          });

          if (pathname === threadPath) {
            const panelToggle = page.getByRole("button", {
              name: /^Show right panel/,
            });

            const panelStart = Date.now();
            await panelToggle.click();
            await page
              .locator('[data-testid="thread-secondary-panel-top-chrome"]')
              .waitFor({ state: "visible" });
            const panelOpenMs = Date.now() - panelStart;
            await page
              .getByRole("button", { name: /^Hide right panel/ })
              .click();
            results.push({
              kind: "right-panel-open",
              panelOpenMs,
              completed: true,
            });
            await expect
              .poll(() =>
                page
                  .getByText("Performance answer 39.", { exact: false })
                  .count(),
              )
              .toBeGreaterThan(0);
            results.push({
              kind: "pre-reload-display-cache",
              cache: await page.evaluate(() => {
                const raw = localStorage.getItem(
                  "omnyo.threadTimelineDisplay.v1",
                );

                if (raw === null) return { present: false };
                const cache = JSON.parse(raw);

                return {
                  present: true,
                  runtimeId: cache.runtimeId,
                  records: cache.records.map(
                    (record: {
                      threadId: string;
                      rows: unknown[];
                      savedAt: number;
                    }) => ({
                      threadId: record.threadId,
                      rows: record.rows.length,
                      savedAt: record.savedAt,
                    }),
                  ),
                };
              }),
            });
            let timelineReleased = false;
            let bootstrapReleased = false;
            let metadataRequests = 0;
            let timelineRequests = 0;

            await page.route(/\/timeline(?:\?|$)/, async (route: any) => {
              timelineRequests += 1;
              await new Promise((r) => setTimeout(r, 800));
              timelineReleased = true;
              await route.continue();
            });
            await page.route(
              (url: URL) => url.pathname === `/api/v1/threads/${thread.id}`,
              async (route: any) => {
                metadataRequests += 1;
                await new Promise((r) => setTimeout(r, 800));
                bootstrapReleased = true;
                await route.continue();
              },
            );
            phase = "reload";
            phaseStart = performance.now();
            await page.reload({ waitUntil: "domcontentloaded" });
            const start = Date.now();

            await page.waitForFunction(
              () =>
                [...document.querySelectorAll("p")].some((element) => {
                  if (
                    element.textContent !==
                    "Performance answer 39. This synthetic completed message is readable."
                  )
                    return false;

                  const rect = element.getBoundingClientRect();

                  return (
                    element.checkVisibility({
                      visibilityProperty: true,
                      contentVisibilityAuto: true,
                    }) &&
                    rect.height > 0 &&
                    rect.top < window.innerHeight &&
                    rect.bottom > 0
                  );
                }),
              undefined,
              { polling: "raf" },
            );
            results.push({
              kind: "reload-readable",
              elapsedAfterDomMs: Date.now() - start,
              timelineReleased,
              bootstrapReleased,
              metadataRequests,
              timelineRequests,
              readResponses: readResponses.filter(
                (read) => read.phase === "reload",
              ),
              requestStarts: requestStarts.filter(
                (read) => read.phase === "reload",
              ),
            });

            if (process.env.OMNYO_FRONTEND_EXPECT_PERSISTED_DISPLAY === "1") {
              expect(metadataRequests).toBeGreaterThan(0);
              expect(timelineRequests).toBeGreaterThan(0);
              expect(timelineReleased).toBe(false);
              expect(bootstrapReleased).toBe(false);

              await page.waitForTimeout(1100);
              await page.unrouteAll({ behavior: "wait" });

              const threadRequest = (url: URL) =>
                url.pathname === `/api/v1/threads/${thread.id}` ||
                url.pathname === `/api/v1/threads/${thread.id}/timeline`;

              await page.route(threadRequest, (route: any) =>
                route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: JSON.stringify({
                    error: {
                      code: "service_unavailable",
                      message: "Performance fixture is temporarily unavailable",
                    },
                  }),
                }),
              );
              await page.reload({ waitUntil: "domcontentloaded" });
              await page
                .getByText("Performance answer 39.", { exact: false })
                .first()
                .waitFor({ state: "visible" });
              await page
                .getByText("Failed to load thread.", { exact: true })
                .waitFor({ state: "visible" });
              results.push({
                kind: "generic-failure-readable",
                text: await page.locator("body").innerText(),
              });

              await page.unrouteAll({ behavior: "wait" });
              await page.route(threadRequest, (route: any) =>
                route.fulfill({
                  status: 404,
                  contentType: "application/json",
                  body: JSON.stringify({
                    error: {
                      code: "not_found",
                      message: "Thread not found",
                    },
                  }),
                }),
              );
              await page.reload({ waitUntil: "domcontentloaded" });
              await expect
                .poll(() =>
                  page.evaluate((threadId: string) => {
                    const raw = localStorage.getItem(
                      "omnyo.threadTimelineDisplay.v1",
                    );

                    const records = raw ? JSON.parse(raw).records : [];

                    return records.some(
                      (record: { threadId: string }) =>
                        record.threadId === threadId,
                    );
                  }, thread.id),
                )
                .toBe(false);
              await expect
                .poll(() =>
                  page
                    .getByText("Performance answer 39.", { exact: false })
                    .count(),
                )
                .toBe(0);
              results.push({
                kind: "confirmed-deletion-purged",
                text: await page.locator("body").innerText(),
              });
            }
          }

          await context.unrouteAll({ behavior: "wait" });
          await context.close();
        }

        const reconnectContext = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });

        try {
          await reconnectContext.route(
            (url: URL) => url.origin !== origin,
            (route: any) => route.abort(),
          );
          const page = await reconnectContext.newPage();
          const sockets: { event: string; payload?: string }[] = [];

          const timelineReads: { runtimeId: string | null; maxSeq: number }[] =
            [];

          const errors: string[] = [];
          page.on("pageerror", (error: Error) => errors.push(error.message));
          page.on("websocket", (socket: any) => {
            sockets.push({ event: "open" });
            socket.on("close", () => sockets.push({ event: "close" }));
            socket.on("framereceived", (frame: any) =>
              sockets.push({
                event: "received",
                payload: String(frame.payload).slice(0, 1000),
              }),
            );
            socket.on("framesent", (frame: any) =>
              sockets.push({
                event: "sent",
                payload: String(frame.payload).slice(0, 1000),
              }),
            );
          });
          const pendingTimelineReads = new Set<Promise<void>>();
          const captureFailures: string[] = [];

          const captureTimeline = (response: any) => {
            if (
              new URL(response.url()).pathname !==
                `/api/v1/threads/${thread.id}/timeline` ||
              response.status() !== 200
            )
              return;

            const read = response
              .json()
              .then((data: { runtimeId?: string; maxSeq: number }) => {
                timelineReads.push({
                  runtimeId: data.runtimeId ?? null,
                  maxSeq: data.maxSeq,
                });
              });

            pendingTimelineReads.add(read);
            void read.then(
              () => pendingTimelineReads.delete(read),
              (error: Error) => {
                captureFailures.push(error.message);
                pendingTimelineReads.delete(read);
              },
            );
          };

          page.on("response", captureTimeline);
          await page.goto(origin + threadPath, {
            waitUntil: "domcontentloaded",
          });
          await page
            .getByText(
              "Performance answer 39. This synthetic completed message is readable.",
              { exact: true },
            )
            .waitFor({ state: "visible" });
          await expect
            .poll(() =>
              sockets.some(
                (frame) =>
                  frame.event === "sent" &&
                  frame.payload?.includes("thread-detail"),
              ),
            )
            .toBe(true);
          const document = await page.evaluateHandle(() => window.document);
          const oldRuntimeId = app.maintenance.getRuntimeId();
          await expect
            .poll(() =>
              timelineReads.some((read) => read.runtimeId === oldRuntimeId),
            )
            .toBe(true);

          const replacement = createApp(harness.deps, {
            staticDir: resolve(appDist),
          });

          applications.push(replacement);
          await replacement.pluginService.start({
            hold: {
              sources: listBundledPluginRegistrations().map(
                (p) => `builtin:${p.name}`,
              ),
              detail: "Reconnect fixture holds providers",
              isActive: async () => true,
            },
          });
          const newRuntimeId = replacement.maintenance.getRuntimeId();
          expect(newRuntimeId).not.toBe(oldRuntimeId);

          const answer =
            "Replacement runtime answer is visible after reconnect.";

          const scope = turnScope("reconnect-turn");

          const common = {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId: "performance-fixture",
            scope,
          };

          seedEvent(harness.deps, {
            ...common,
            sequence: 121,
            type: "turn/started",
            data: {},
          });
          seedEvent(harness.deps, {
            ...common,
            sequence: 122,
            type: "item/completed",
            data: {
              item: {
                type: "agentMessage",
                id: "reconnect-answer",
                text: answer,
              },
            },
          });
          seedEvent(harness.deps, {
            ...common,
            sequence: 123,
            type: "turn/completed",
            data: { status: "completed" },
          });
          const previous = app;

          server.removeAllListeners("upgrade");
          app = replacement;
          app.injectWebSocket(server);
          await previous.closeWebSockets();
          closedApplications.add(previous);
          await previous.pluginService.stop();
          stoppedApplications.add(previous);
          await expect
            .poll(
              () => sockets.filter((event) => event.event === "open").length,
              { timeout: 15000 },
            )
            .toBeGreaterThan(1);
          await page
            .getByText(answer, { exact: true })
            .waitFor({ state: "visible", timeout: 15000 });
          expect(
            await page.evaluate(
              (original: Document) => window.document === original,
              document,
            ),
          ).toBe(true);
          await expect
            .poll(() =>
              timelineReads.some(
                (read) =>
                  read.runtimeId === newRuntimeId && read.maxSeq === 123,
              ),
            )
            .toBe(true);
          expect(sockets.some((event) => event.event === "close")).toBe(true);
          page.off("response", captureTimeline);
          await Promise.all(pendingTimelineReads);
          expect(captureFailures).toEqual([]);
          expect(errors).toEqual([]);
          results.push({
            kind: "replacement-runtime-reconnect",
            oldRuntimeId,
            newRuntimeId,
            sockets,
            timelineReads,
            visibleText: answer,
            sameDocument: true,
            completed: true,
          });
          await document.dispose();
        } finally {
          await reconnectContext.unrouteAll({ behavior: "wait" });
          await reconnectContext.close();
        }

        const heavyContext = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });

        try {
          await heavyContext.route(
            (url: URL) => url.origin !== origin,
            (route: any) => route.abort(),
          );
          const page = await heavyContext.newPage();
          const markdownWorkers: string[] = [];
          page.on("worker", (worker: any) =>
            markdownWorkers.push(new URL(worker.url()).pathname),
          );
          const socketFrames: { direction: string; payload: string }[] = [];
          const heavyReads: string[] = [];
          const heavyResponses: unknown[] = [];
          page.on("response", async (response: any) => {
            if (
              !new URL(response.url()).pathname.endsWith(
                `/threads/${heavy.thread.id}/timeline`,
              )
            )
              return;

            try {
              const body = await response.json();
              const rows: any[] = [];

              const visit = (items: any[]) => {
                for (const row of items) {
                  if (row.kind === "conversation")
                    rows.push({
                      id: row.id,
                      end: row.sourceSeqEnd,
                      length: row.text.length,
                      tail: row.text.slice(-80),
                    });

                  if (row.children) visit(row.children);
                }
              };

              visit(body.rows);
              heavyResponses.push({
                maxSeq: body.maxSeq,
                rows,
                delta: body.delta,
              });
            } catch (error) {
              heavyResponses.push({ error: String(error) });
            }
          });
          page.on("websocket", (socket: any) => {
            socket.on("framesent", (frame: any) =>
              socketFrames.push({
                direction: "sent",
                payload: String(frame.payload).slice(0, 1000),
              }),
            );
            socket.on("framereceived", (frame: any) =>
              socketFrames.push({
                direction: "received",
                payload: String(frame.payload).slice(0, 1000),
              }),
            );
          });
          page.on("request", (request: any) => {
            const url = new URL(request.url());

            if (url.pathname.startsWith(`/api/v1/threads/${heavy.thread.id}`))
              heavyReads.push(url.pathname);
          });
          results.push({
            kind: "large-answer-transport",
            socketFrames,
            heavyReads,
            heavyResponses,
          });
          await page.goto(
            `${origin}/projects/${heavy.project.id}/threads/${heavy.thread.id}`,
            { waitUntil: "domcontentloaded" },
          );

          const sentinel = page.getByText("Selection sentinel stays stable.", {
            exact: true,
          });

          await sentinel.waitFor({ state: "attached" });
          await sentinel.scrollIntoViewIfNeeded();
          const settledNode = await sentinel.elementHandle();
          const selected = page.locator("[data-message-column] strong").first();
          await selected.waitFor({ state: "attached" });
          const selectedNode = await selected.elementHandle();
          await selected.evaluate((element: Element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
          await expect
            .poll(
              () =>
                socketFrames.some(
                  (frame) =>
                    frame.direction === "sent" &&
                    frame.payload.includes("thread-detail") &&
                    frame.payload.includes(heavy.thread.id),
                ),
              { timeout: 10_000 },
            )
            .toBe(true);
          await page.waitForTimeout(100);
          const cdp = await heavyContext.newCDPSession(page);
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");

          const frameMeasurement = await page.evaluateHandle(() => {
            const samples: number[] = [];
            let previous = performance.now();
            let active = true;

            const tick = (now: number) => {
              samples.push(now - previous);
              previous = now;

              if (active) requestAnimationFrame(tick);
            };

            requestAnimationFrame(tick);

            return {
              samples,
              stop: () => {
                active = false;
              },
            };
          });

          const updateDurationsMs: number[] = [];

          for (let step = 0; step < 12; step++) {
            const start = Date.now();
            seedEvent(harness.deps, {
              ...heavyTurn,
              sequence: 6 + step,
              type: "item/agentMessage/delta",
              data: { itemId: "heavy-answer", delta: ` tail-${step}.\n` },
            });
            harness.deps.hub.notifyThread(heavy.thread.id, ["events-appended"]);
            await page.waitForFunction(
              (expected: string) => {
                const paragraphs = document.querySelectorAll(
                  "[data-message-column] p",
                );

                return paragraphs[paragraphs.length - 1]?.textContent
                  ?.trimEnd()
                  .endsWith(expected);
              },
              `tail-${step}.`,
              { polling: "raf", timeout: 10_000 },
            );
            updateDurationsMs.push(Date.now() - start);
            expect(
              await page.evaluate(() => window.getSelection()?.toString()),
            ).toBe("bold");
            expect(
              await sentinel.evaluate(
                (element: Element, original: Element) => element === original,
                settledNode,
              ),
            ).toBe(true);
            expect(
              await selected.evaluate(
                (element: Element, original: Element) => element === original,
                selectedNode,
              ),
            ).toBe(true);
            await page.waitForTimeout(100);
          }

          const { profile } = await cdp.send("Profiler.stop");

          const cpu = profile.nodes
            .filter((node: any) => node.hitCount > 0)
            .map((node: any) => ({
              name: node.callFrame.functionName,
              url: new URL(node.callFrame.url || origin, origin).pathname,
              hits: node.hitCount,
            }))
            .sort((a: any, b: any) => b.hits - a.hits);

          const frameIntervalsMs = await frameMeasurement.evaluate(
            (measurement: FrameMeasurement) => {
              measurement.stop();

              return measurement.samples;
            },
          );

          await frameMeasurement.dispose();
          expect(await page.locator("strong").count()).toBeGreaterThan(100);
          expect(await page.locator("code").count()).toBeGreaterThan(100);
          expect(
            await page.locator('a[href="https://example.com"]').count(),
          ).toBeGreaterThan(100);

          const finalText = await page
            .locator("[data-message-column] p")
            .last()
            .textContent();

          const expectedText =
            "A bold word and an example with inline code remain readable. ".repeat(
              1500,
            ) +
            Array.from(
              { length: 12 },
              (_unused, step) => ` tail-${step}.\n`,
            ).join("");

          expect(finalText?.replace(/\s+/gu, " ").trim()).toBe(
            expectedText.replace(/\s+/gu, " ").trim(),
          );

          if (process.env.OMNYO_FRONTEND_EXPECT_MARKDOWN_WORKER === "1")
            expect(
              markdownWorkers.some((url) => /markdown-parse.*\.js/u.test(url)),
            ).toBe(true);
          results.push({
            kind: "large-answer-stream",
            fixtureHash: createHash("sha256").update(heavyText).digest("hex"),
            inputBytes: Buffer.byteLength(heavyText),
            appends: 12,
            updateDurationsMs,
            frameIntervalsMs,
            cpu: cpu.slice(0, 50),
            cpuSamples: profile.samples.length,
            cpuDurationMs: (profile.endTime - profile.startTime) / 1000,
            selection:
              "inside large paragraph unchanged after every append; settled and selected nodes retained",
            markdownWorkers,
            finalTextHash: createHash("sha256")
              .update(finalText ?? "")
              .digest("hex"),
            finalFormatting: "bold, links and inline code retained",
          });
        } finally {
          await heavyContext.unrouteAll({ behavior: "wait" });
          await heavyContext.close();
        }

        completed = true;
      } finally {
        try {
          const index = await readFile(resolve(appDist, "index.html"), "utf8");

          if (process.env.OMNYO_PERFORMANCE_SUITE !== "1")
            await writeFile(
              output,
              JSON.stringify(
                {
                  threadPath,
                  results,
                  indexBytes: index.length,
                  completed,
                  appDist,
                  requestDelayMs,
                  browserVersion: browser.version(),
                },
                null,
                2,
              ),
            );
        } finally {
          await browser.close();
        }
      }
    } finally {
      for (const application of applications)
        if (!closedApplications.has(application))
          await application.closeWebSockets();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );

      for (const application of applications)
        if (!stoppedApplications.has(application))
          await application.pluginService.stop();

      for (const responder of responders) responder.unregister();
      await harness.cleanup();
    }
  },
  process.env.OMNYO_PERFORMANCE_SUITE === "1" ? 2_880_000 : 150_000,
);
