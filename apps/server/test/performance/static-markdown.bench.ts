import { it, expect } from "vitest";
import { serve } from "@hono/node-server";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getAppSettings, setAppSettings } from "@omnyo/db";
import { redactCredentialText, turnScope } from "@omnyo/domain";
import { createApp } from "../../src/server.js";
import { listBundledPluginRegistrations } from "../../src/services/plugins/builtin-registry.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { installPerformanceHost } from "./app-performance.js";
import {
  seedEvent,
  seedPrimaryHost,
  seedThreadFixture,
} from "../helpers/seed.js";

it.skipIf(!process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT)(
  "records large static Markdown responsiveness",
  async () => {
    const modulePath = process.env.OMNYO_FRONTEND_PLAYWRIGHT_MODULE;
    const output = process.env.OMNYO_FRONTEND_MEASUREMENT_OUTPUT;
    const appDist = process.env.OMNYO_FRONTEND_APP_DIST;

    if (!modulePath || !output || !appDist)
      throw new Error("Existing OMNYO_FRONTEND measurement paths are required");

    const { chromium } = await import(modulePath);
    const harness = await createTestAppHarness();
    setAppSettings(harness.db, {
      ...getAppSettings(harness.db),
      onboardingCompletedAt: "2026-10-23T00:00:00.000Z",
    });

    const fixture = seedThreadFixture(harness, {
      thread: { title: "Static Markdown responsiveness", status: "idle" },
    });

    seedPrimaryHost(harness.deps, fixture.host.id);
    const host = installPerformanceHost(harness, fixture);

    const seedAnswer = (sequence: number, text: string) => {
      const common = {
        threadId: fixture.thread.id,
        environmentId: fixture.environment.id,
        providerThreadId: "static-markdown-fixture",
        scope: turnScope(`static-${sequence}`),
      };

      seedEvent(harness.deps, {
        ...common,
        sequence,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: sequence + 1,
        type: "item/completed",
        data: {
          item: { type: "agentMessage", id: `static-answer-${sequence}`, text },
        },
      });
      seedEvent(harness.deps, {
        ...common,
        sequence: sequence + 2,
        type: "turn/completed",
        data: { status: "completed" },
      });
    };

    seedAnswer(1, "Ready for static Markdown.");
    const marker = "Static Markdown exact end marker.";

    const paragraph =
      "A **bold** word and an [example](https://example.com) with `inline code` remain readable. ";

    const text = paragraph.repeat(1500) + "\n\n" + marker;

    const expected =
      "A bold word and an example with inline code remain readable. ".repeat(
        1500,
      ) + marker;

    expect(text.length).toBeGreaterThan(100_000);
    const app = createApp(harness.deps, { staticDir: resolve(appDist) });
    const errors: string[] = [];
    const failedReads: string[] = [];
    const workers: string[] = [];
    const samples: unknown[] = [];
    const requestDiagnostics: unknown[] = [];
    const canceledAttentionReads: string[] = [];
    const blockedDiscoveryUrls = new Set<string>();
    const discoveryConsoleErrors: string[] = [];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    let closeServer: (() => Promise<void>) | undefined;
    let completed = false;
    let startupHoldActive = true;
    let observedPage: any;

    try {
      try {
        await app.pluginService.start({
          hold: {
            sources: listBundledPluginRegistrations().map(
              (plugin) => `builtin:${plugin.name}`,
            ),
            detail: "Static Markdown uses the existing inert host fixture",
            isActive: async () => startupHoldActive,
          },
        });
      } finally {
        startupHoldActive = false;
      }

      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.app.fetch,
      });

      closeServer = () =>
        new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));

          if ("closeAllConnections" in server) server.closeAllConnections();
        });
      app.injectWebSocket(server);
      browser = await chromium.launch({
        headless: true,
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
      const address = server.address();

      if (!address || typeof address === "string")
        throw new Error("Missing fixture server port");
      const origin = `http://127.0.0.1:${address.port}`;

      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: "block",
      });

      await context.route(
        (url: URL) => {
          if (url.origin !== origin) {
            if (
              url.origin === "http://127.0.0.1:3001" &&
              url.pathname === "/status"
            )
              blockedDiscoveryUrls.add(url.href);
            requestDiagnostics.push({
              blocked: `${url.origin}${url.pathname}`,
            });
          }

          return url.origin !== origin;
        },
        (route: any) => route.abort(),
      );
      const page = await context.newPage();
      observedPage = page;
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(4000);
      let subscribed = false;
      page.on("websocket", (socket: any) => {
        socket.on("framesent", (frame: any) => {
          const payload = String(frame.payload);

          if (
            payload.includes("thread-detail") &&
            payload.includes(fixture.thread.id)
          )
            subscribed = true;
        });
      });
      page.on("pageerror", (error: Error) =>
        errors.push(redactCredentialText(error.message)),
      );
      page.on("console", (message: any) => {
        if (message.type() === "error") {
          if (blockedDiscoveryUrls.has(message.location().url))
            discoveryConsoleErrors.push(redactCredentialText(message.text()));
          else errors.push(redactCredentialText(message.text()));
        }
      });
      page.on("response", (response: any) => {
        if (
          new URL(response.url()).origin === origin &&
          response.status() >= 400
        )
          failedReads.push(
            `${response.status()} ${new URL(response.url()).pathname}`,
          );
      });
      page.on("requestfailed", (request: any) => {
        if (new URL(request.url()).origin === origin) {
          if (
            new URL(request.url()).pathname === "/api/v1/thread-attention" &&
            request.failure()?.errorText === "net::ERR_ABORTED"
          ) {
            canceledAttentionReads.push(new URL(request.url()).pathname);

            return;
          }

          failedReads.push(
            `Failed ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
          );
        }
      });
      page.on("worker", (worker: any) =>
        workers.push(new URL(worker.url()).pathname),
      );
      await page.goto(
        `${origin}/projects/${fixture.project.id}/threads/${fixture.thread.id}`,
        { waitUntil: "domcontentloaded" },
      );
      await page
        .getByText("Ready for static Markdown.", { exact: true })
        .waitFor({ state: "attached" });
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await expect.poll(() => subscribed, { timeout: 4000 }).toBe(true);

      const measurement = await page.evaluateHandle(() => {
        if (!PerformanceObserver.supportedEntryTypes.includes("longtask"))
          throw new Error("Long-task observation is unavailable");
        const tasks: { startTime: number; duration: number }[] = [];

        const collect = (entries: PerformanceEntry[]) => {
          for (const entry of entries)
            tasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
        };

        const observer = new PerformanceObserver((list) =>
          collect(list.getEntries()),
        );

        observer.observe({ type: "longtask" });

        return {
          stop: () => {
            collect(observer.takeRecords());
            observer.disconnect();

            return tasks;
          },
        };
      });

      const response = page.waitForResponse(
        async (response: any) =>
          new URL(response.url()).pathname.endsWith(
            `/threads/${fixture.thread.id}/timeline`,
          ) && (await response.text()).includes(marker),
      );

      const started = performance.now();
      seedAnswer(4, text);
      harness.hub.notifyThread(fixture.thread.id, ["events-appended"]);

      const rendered = page
        .getByText(marker, { exact: true })
        .waitFor({ state: "attached" })
        .then(() => performance.now());

      await response;
      const inputStarted = performance.now();
      await editor.press("x");
      expect(await editor.textContent()).toBe("x");
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(done)),
      );
      const inputMs = performance.now() - inputStarted;
      const renderedAt = await rendered;

      const finalText = await page
        .locator("[data-message-column] [data-markdown-preview]")
        .last()
        .textContent();

      const longTasks = await measurement.evaluate(
        (value: { stop: () => { startTime: number; duration: number }[] }) =>
          value.stop(),
      );

      await measurement.dispose();
      samples.push({
        renderMs: renderedAt - started,
        inputMs,
        inputStartedBeforeRenderComplete: inputStarted < renderedAt,
        longTasks,
        finalTextHash: createHash("sha256")
          .update(finalText ?? "")
          .digest("hex"),
      });
      expect(finalText?.replace(/\s+/gu, " ").trim()).toBe(expected.trim());
      expect(inputStarted).toBeLessThan(renderedAt);

      if (process.env.OMNYO_FRONTEND_EXPECT_MARKDOWN_WORKER === "1")
        expect(workers.some((url) => /markdown-parse.*\.js/u.test(url))).toBe(
          true,
        );
      expect([...errors, ...failedReads, ...host.unexpected]).toEqual([]);
      completed = true;
    } catch (error) {
      if (observedPage) {
        await observedPage
          .screenshot({ path: `${output}.png`, timeout: 2000 })
          .catch(() => undefined);

        const renderedText = await observedPage
          .locator("[data-message-column]")
          .allTextContents()
          .catch(() => []);

        await writeFile(
          `${output}.diagnostic.json`,
          JSON.stringify({
            messageTextLengths: renderedText.map(
              (value: string) => value.length,
            ),
            tails: renderedText.map((value: string) => value.slice(-200)),
          }),
        );
      }

      errors.push(
        redactCredentialText(
          error instanceof Error ? error.message : String(error),
        ),
      );
      throw error;
    } finally {
      try {
        await writeFile(
          output,
          JSON.stringify(
            {
              kind: "large-static-markdown",
              requestDiagnostics,
              canceledAttentionReads,
              discoveryConsoleErrors,
              completed,
              samples,
              appDist,
              browserVersion: browser?.version() ?? null,
              fixtureHash: createHash("sha256").update(text).digest("hex"),
              inputBytes: Buffer.byteLength(text),
              workers,
              errors,
              failedReads,
              unexpectedHostCommands: host.unexpected,
              failureCount:
                errors.length + failedReads.length + host.unexpected.length,
              boundaries: {
                renderMs:
                  "Completed answer seeded to exact end marker attached",
                inputMs:
                  "Browser key dispatch after matching timeline body arrives to correct editor DOM and next animation frame",
                longTasks:
                  "Main-thread tasks from before delivery through rendered content and foreground input; excludes app startup",
              },
            },
            null,
            2,
          ),
        );
      } finally {
        await browser?.close();
        await app.closeWebSockets();
        await closeServer?.();
        await app.pluginService.stop();
        await harness.cleanup();
      }
    }
  },
  12_000,
);
