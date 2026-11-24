import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { forkablePluginPaths } from "../../../apps/app/vite-forkable-plugin-paths.ts";
import { sharedUiEnvSeam } from "../../../apps/app/vite-shared-ui-seam.ts";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "../../../apps/app/src/test/fixtures/thread-responses.ts";
import { conversationRow } from "../../../apps/app/src/test/fixtures/thread-timeline-rows.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);

const label = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .parse(
    process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "run",
  );

const scratchRoot = z.string().min(1).parse(process.env.CHAT_SCROLL_SCRATCH);

const scratch = `${scratchRoot}/${label}`;

const playwrightEntry = z
  .string()
  .min(1)
  .parse(process.env.CHAT_SCROLL_PLAYWRIGHT);

const dist = `${scratch}/dist`;

const threadId = "thread-0";

const runtimeId = "chat-scroll-runtime";

const tip = 600;

const pageSize = 20;

const heavy = process.argv.includes("--heavy");

const mobile = process.argv.includes("--mobile");

const continuousOnly = process.argv.includes("--continuous-only");

const viewport = mobile
  ? { width: 390, height: 844 }
  : { width: 1280, height: 800 };

const continuousTravelPx = 24_000;

const continuousSpeedPxPerSecond = 2_400;

const continuousJumpSlackPx = 200;

function seeded(sequence: number, salt: number): number {
  const value = Math.sin(sequence * 12.9898 + salt * 78.233) * 43758.5453;

  return value - Math.floor(value);
}

function messageText(sequence: number): string {
  const parts = [`Message ${sequence}.`];
  const paragraphs = 1 + Math.floor(seeded(sequence, 1) * 8);

  for (let index = 0; index < paragraphs; index += 1)
    parts.push(
      "A paragraph of chat history with **Markdown** and `inline code`. ".repeat(
        1 + Math.floor(seeded(sequence, index + 2) * 5),
      ),
    );

  if (seeded(sequence, 40) > 0.6) {
    const lines = 4 + Math.floor(seeded(sequence, 41) * 30);
    parts.push(
      `\`\`\`ts\n${Array.from({ length: lines }, (_, line) => `const value${line} = ${line * sequence};`).join("\n")}\n\`\`\``,
    );
  }

  if (seeded(sequence, 50) > 0.7)
    parts.push(
      Array.from(
        { length: 3 + Math.floor(seeded(sequence, 51) * 8) },
        (_, item) => `- List item ${item}`,
      ).join("\n"),
    );

  if (heavy)
    parts.push(
      "Heavy tool output line with a long explanation of the change. ".repeat(
        250 + Math.floor(seeded(sequence, 60) * 250),
      ),
    );

  return parts.join("\n\n");
}

function timeline(beforeSequence?: number) {
  const end = beforeSequence === undefined ? tip : beforeSequence - 1;
  const start = Math.max(1, end - pageSize + 1);

  const rows = Array.from({ length: end - start + 1 }, (_, index) => {
    const sequence = start + index;

    return conversationRow({
      id: `${threadId}-row-${sequence}`,
      threadId,
      role: sequence % 2 === 0 ? "assistant" : "user",
      seq: sequence,
      text: messageText(sequence),
    });
  });

  return {
    ...makeThreadTimelineResponse({
      rows,
      maxSeq: tip,
      timelinePage: {
        kind: beforeSequence === undefined ? "latest" : "older",
        returnedSegmentCount: rows.length,
        hasOlderRows: start > 1,
        olderCursor:
          start > 1
            ? { anchorId: `${threadId}-row-${start}`, anchorSeq: start }
            : null,
        historySnapshot: JSON.stringify({
          version: 5,
          threadId,
          maxSeq: tip,
          status: "active",
          surface: "default",
          historyEpoch: "a".repeat(32),
        }),
      },
    }),
    runtimeId,
  };
}

const olderRequests: Array<{ at: number; before: number }> = [];

const apiErrors: string[] = [];

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      let body: unknown;

      if (url.pathname === `/api/v1/threads/${threadId}/timeline`) {
        const before = url.searchParams.get("beforeAnchorSeq");

        if (before !== null)
          olderRequests.push({ at: Date.now(), before: Number(before) });
        body = timeline(before === null ? undefined : Number(before));
      } else if (url.pathname === `/api/v1/threads/${threadId}`)
        body = {
          ...makeThreadResponse({ id: threadId }),
          environment: null,
          host: null,
        };
      else if (url.pathname.endsWith("/maintenance"))
        body = {
          contractVersion: 1,
          runtime: {
            runtimeId,
            processId: 1,
            parentProcessId: 1,
            launchId: null,
            dataDir: "/inert-fixture",
            serverHostId: null,
            appVersion: "fixture",
            protocolVersion: 1,
          },
          hold: null,
          activity: {
            runningThreads: 0,
            pendingInteractions: 0,
            hostRpcs: 0,
            provisioning: 0,
            queuedDispatches: 0,
            pluginLoads: 0,
            pluginInvocations: 0,
            hungServices: 0,
          },
        };
      else if (url.pathname.endsWith("/system/config")) body = {};
      else {
        apiErrors.push(url.pathname);
        response.writeHead(404);
        response.end("{}");

        return;
      }

      await new Promise((settle) => setTimeout(settle, 120));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));

      return;
    }

    const path = resolve(
      dist,
      url.pathname === "/" ? "fixture.html" : url.pathname.slice(1),
    );

    assert.ok(path.startsWith(`${dist}/`));

    const mime = new Map([
      [".html", "text/html"],
      [".js", "text/javascript"],
      [".css", "text/css"],
      [".woff2", "font/woff2"],
    ]);

    const bytes = await readFile(path);

    response.writeHead(200, {
      "content-type": mime.get(extname(path)) ?? "application/octet-stream",
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(500);
    response.end(error instanceof Error ? error.message : "failure");
  }
});

const appRequire = createRequire(`${repository}/apps/app/package.json`);

const { build } = await import(pathToFileURL(appRequire.resolve("vite")).href);

const { default: react } = await import(
  pathToFileURL(appRequire.resolve("@vitejs/plugin-react")).href
);

const { default: tailwindcss } = await import(
  pathToFileURL(appRequire.resolve("@tailwindcss/vite")).href
);

const { chromium } = await import(pathToFileURL(playwrightEntry).href);

await rm(scratch, { recursive: true, force: true });

await mkdir(scratch, { recursive: true });

const packages = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "react-router-dom",
  "@tanstack/react-query",
  "jotai",
  "@omnyo/shared-ui/icon-extended",
  "@omnyo/shared-ui/tooltip",
];

await build({
  configFile: false,
  logLevel: "error",
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: `${scratch}/vite-cache`,
  plugins: [
    forkablePluginPaths(`${repository}/apps/app/src`),
    sharedUiEnvSeam(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    conditions: ["source"],
    alias: [
      { find: "@", replacement: `${repository}/apps/app/src` },
      ...packages.map((name) => ({
        find: new RegExp(`^${name.replaceAll("/", "\\/")}$`),
        replacement: appRequire.resolve(name),
      })),
    ],
  },
  build: {
    target: "esnext",
    outDir: dist,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./fixture.html", import.meta.url)),
    },
  },
});

server.listen(0, "127.0.0.1");

await once(server, "listening");

const address = server.address();

assert.ok(address && typeof address === "object");

const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-first-run"],
});

interface Probe {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  topId: string | null;
  topOffset: number;
}

interface StepResult {
  step: number;
  direction: "up" | "down";
  expectedMove: number;
  actualMove: number | null;
  shift: number | null;
  jitter: number;
  scrollTopBefore: number;
  scrollTopAfter: number;
  rowsMounted: number;
  olderRequests: number;
}

interface ContinuousFrame {
  at: number;
  scrollTop: number;
  referenceTop: number;
}

const results: Record<string, unknown> = { label };

try {
  const continuousPage = await browser.newPage({ viewport, hasTouch: mobile });

  const continuousConsoleErrors: string[] = [];
  continuousPage.on("pageerror", (error: Error) =>
    continuousConsoleErrors.push(error.message),
  );
  continuousPage.on(
    "console",
    (message: { type(): string; text(): string }) => {
      if (message.type() === "error")
        continuousConsoleErrors.push(message.text());
    },
  );

  await continuousPage.addInitScript("globalThis.__name = (target) => target;");
  await continuousPage.goto(origin);

  try {
    await continuousPage.waitForSelector("[data-timeline-row-id]", {
      timeout: 15_000,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        apiErrors: [...new Set(apiErrors)],
        consoleErrors: continuousConsoleErrors.slice(0, 5),
      }),
    );

    throw error;
  }

  await continuousPage.waitForTimeout(800);

  const continuousBox = await continuousPage
    .locator("[data-page-scroll-viewport]")
    .boundingBox();

  assert.ok(continuousBox);
  await continuousPage.mouse.move(
    continuousBox.x + continuousBox.width / 2,
    continuousBox.y + continuousBox.height / 2,
  );

  await continuousPage.evaluate((referenceRowId: string) => {
    const scrollViewport = document.querySelector<HTMLElement>(
      "[data-page-scroll-viewport]",
    )!;

    const reference = document.querySelector<HTMLElement>(
      `[data-timeline-row-id="${referenceRowId}"]`,
    )!;

    const frames: Array<{
      at: number;
      scrollTop: number;
      referenceTop: number;
    }> = [];

    const ticker = document.createElement("div");
    ticker.style.cssText = "position:fixed;top:0;left:0;height:1px";
    document.body.append(ticker);
    let width = 1;

    new ResizeObserver(() => {
      frames.push({
        at: performance.now(),
        scrollTop: scrollViewport.scrollTop,
        referenceTop:
          reference.getBoundingClientRect().top -
          scrollViewport.getBoundingClientRect().top,
      });
    }).observe(ticker);

    const nextFrame = () => {
      width = width === 1 ? 2 : 1;
      ticker.style.width = `${width}px`;
      requestAnimationFrame(nextFrame);
    };

    requestAnimationFrame(nextFrame);
    Object.assign(globalThis, { chatScrollContinuousFrames: frames });
  }, `${threadId}-row-${tip}`);

  const continuousRequestsBefore = olderRequests.length;

  const continuousSession = await continuousPage
    .context()
    .newCDPSession(continuousPage);

  await continuousSession.send("Input.synthesizeScrollGesture", {
    x: continuousBox.x + continuousBox.width / 2,
    y: continuousBox.y + continuousBox.height / 2,
    yDistance: continuousTravelPx,
    speed: continuousSpeedPxPerSecond,
    gestureSourceType: mobile ? "touch" : "mouse",
  });

  await continuousPage.waitForTimeout(1500);

  const continuousFrames: ContinuousFrame[] = await continuousPage.evaluate(
    () =>
      (globalThis as unknown as { chatScrollContinuousFrames: unknown })
        .chatScrollContinuousFrames,
  );

  const continuousJumps: Array<{
    frame: number;
    jumpPx: number;
    insertedPx: number;
    frameMs: number;
    previousFrameMs: number;
  }> = [];

  let continuousInserts = 0;

  for (let index = 1; index < continuousFrames.length; index += 1) {
    const previous = continuousFrames[index - 1]!;
    const current = continuousFrames[index]!;
    const moved = current.referenceTop - previous.referenceTop;

    const inserted =
      current.referenceTop +
      current.scrollTop -
      previous.referenceTop -
      previous.scrollTop;

    if (inserted > 50) continuousInserts += 1;

    const catchUpMs =
      current.at - (continuousFrames[index - 2]?.at ?? previous.at);

    const gestureAllowance =
      (catchUpMs / 1000) * continuousSpeedPxPerSecond * 1.5 +
      continuousJumpSlackPx;

    if (Math.abs(moved) > gestureAllowance)
      continuousJumps.push({
        frame: index,
        jumpPx: Math.round(moved),
        insertedPx: Math.round(inserted),
        frameMs: Math.round(current.at - previous.at),
        previousFrameMs: Math.round(
          previous.at - (continuousFrames[index - 2]?.at ?? previous.at),
        ),
      });
  }

  results.continuous = {
    viewport,
    gestureTravelPx: continuousTravelPx,
    visualTravelPx: Math.round(
      (continuousFrames.at(-1)?.referenceTop ?? 0) -
        (continuousFrames[0]?.referenceTop ?? 0),
    ),
    unexplainedTravelPx: Math.round(
      (continuousFrames.at(-1)?.referenceTop ?? 0) -
        (continuousFrames[0]?.referenceTop ?? 0) -
        continuousTravelPx,
    ),
    frames: continuousFrames.length,
    layoutInsertsAboveReference: continuousInserts,
    olderRequests: olderRequests.length - continuousRequestsBefore,
    jumps: continuousJumps.length,
    jumpedPx: continuousJumps.reduce(
      (total, jump) => total + Math.abs(jump.jumpPx),
      0,
    ),
    firstJumps: continuousJumps.slice(0, 8),
  };
  await continuousPage.close();

  if (continuousOnly) {
    results.summary = { continuous: results.continuous };
    results.steps = [];
  } else {
    const page = await browser.newPage({ viewport });

    const consoleErrors: string[] = [];
    page.on("pageerror", (error: Error) => consoleErrors.push(error.message));
    page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.addInitScript("globalThis.__name = (target) => target;");
    await page.goto(origin);
    await page.waitForSelector("[data-timeline-row-id]", { timeout: 15_000 });
    await page.waitForTimeout(800);

    const probe = (): Promise<Probe> =>
      page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(
          "[data-page-scroll-viewport]",
        )!;

        const top = viewport.getBoundingClientRect().top;

        const row = [
          ...viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
        ].find((candidate) => {
          const rect = candidate.getBoundingClientRect();

          return rect.height > 0 && rect.bottom > top + 1;
        });

        return {
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          topId: row?.dataset.timelineRowId ?? null,
          topOffset: row ? row.getBoundingClientRect().top - top : 0,
        };
      });

    const settle = (id: string | null) =>
      page.evaluate(
        (rowId: string | null) =>
          new Promise<{ offsets: Array<number | null>; scrollTop: number }>(
            (done) => {
              const viewport = document.querySelector<HTMLElement>(
                "[data-page-scroll-viewport]",
              )!;

              const offsets: Array<number | null> = [];
              let stable = 0;
              let last = Number.NaN;
              const startedAt = performance.now();

              const read = () => {
                const row = rowId
                  ? document.querySelector<HTMLElement>(
                      `[data-timeline-row-id="${rowId}"]`,
                    )
                  : null;

                const offset = row
                  ? row.getBoundingClientRect().top -
                    viewport.getBoundingClientRect().top
                  : null;

                offsets.push(offset);
                const key = viewport.scrollTop * 100000 + (offset ?? 0);
                stable = key === last ? stable + 1 : 0;
                last = key;

                if (stable >= 6 || performance.now() - startedAt > 2000) {
                  observer.disconnect();
                  ticker.remove();
                  done({ offsets, scrollTop: viewport.scrollTop });
                } else nextFrame();
              };

              const ticker = document.createElement("div");
              ticker.style.cssText = "position:fixed;top:0;left:0;height:1px";
              document.body.append(ticker);
              let width = 1;
              let pending = false;

              const observer = new ResizeObserver(() => {
                if (!pending) return;
                pending = false;
                read();
              });

              observer.observe(ticker);

              const nextFrame = () =>
                requestAnimationFrame(() => {
                  width = width === 1 ? 2 : 1;
                  ticker.style.width = `${width}px`;
                  pending = true;
                });

              nextFrame();
            },
          ),
        id,
      );

    const box = await page.locator("[data-page-scroll-viewport]").boundingBox();

    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const steps: StepResult[] = [];

    const stepScroll = async (
      step: number,
      direction: "up" | "down",
      delta: number,
    ) => {
      const before = await probe();
      const maxScroll = before.scrollHeight - before.clientHeight;

      const expectedMove =
        direction === "up"
          ? Math.min(delta, before.scrollTop)
          : -Math.min(delta, maxScroll - before.scrollTop);

      await page.mouse.wheel(0, direction === "up" ? -delta : delta);
      const settled = await settle(before.topId);
      const finalOffset = settled.offsets.at(-1) ?? null;

      const actualMove =
        finalOffset === null ? null : finalOffset - before.topOffset;

      let jitter = 0;

      const offsets = settled.offsets.filter(
        (offset): offset is number => offset !== null,
      );

      for (let index = 1; index < offsets.length; index += 1)
        jitter += Math.abs(offsets[index]! - offsets[index - 1]!);
      jitter -= Math.abs((offsets.at(-1) ?? 0) - (offsets[0] ?? 0));

      steps.push({
        step,
        direction,
        expectedMove,
        actualMove,
        shift: actualMove === null ? null : actualMove - expectedMove,
        jitter: Math.round(jitter),
        scrollTopBefore: Math.round(before.scrollTop),
        scrollTopAfter: Math.round(settled.scrollTop),
        rowsMounted: await page.evaluate(
          () => document.querySelectorAll("[data-timeline-row-id]").length,
        ),
        olderRequests: olderRequests.length,
      });
    };

    const initial = await probe();
    results.initial = initial;

    for (let step = 0; step < 50; step += 1) await stepScroll(step, "up", 400);
    const requestsAfterUp = olderRequests.length;
    await page.waitForTimeout(2500);
    results.idleRequestsAfterUp = olderRequests.length - requestsAfterUp;
    results.afterUp = await probe();

    for (let step = 0; step < 50; step += 1)
      await stepScroll(step, "down", 400);
    results.afterDown = await probe();

    const flingStart = olderRequests.length;
    const beforeFling = await probe();

    for (let step = 0; step < 25; step += 1) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(16);
    }

    const flingStop = olderRequests.length;
    const atFlingStop = await probe();
    await page.waitForTimeout(3000);

    results.fling = {
      beforeScrollTop: Math.round(beforeFling.scrollTop),
      scrollTopAtStop: Math.round(atFlingStop.scrollTop),
      requestsDuringFling: flingStop - flingStart,
      requestsAfterStop: olderRequests.length - flingStop,
      after: await probe(),
    };

    results.historyRanges = await page.evaluate(
      () =>
        [...document.querySelectorAll("[data-timeline-history-gap]")].length,
    );
    const pullStart = olderRequests.length;

    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, -2500);
      await page.waitForTimeout(40);
    }

    let previousTop = -1;

    for (let wait = 0; wait < 40; wait += 1) {
      const top = (await probe()).scrollTop;

      if (top === previousTop) break;
      previousTop = top;
      await page.waitForTimeout(300);
    }

    const pullStop = olderRequests.length;
    const idleTrace: string[] = [];
    const pinned = await probe();

    for (let sample = 0; sample < 40; sample += 1) {
      const offset = await page.evaluate((rowId: string | null) => {
        const viewport = document.querySelector<HTMLElement>(
          "[data-page-scroll-viewport]",
        )!;

        const row = rowId
          ? document.querySelector<HTMLElement>(
              `[data-timeline-row-id="${rowId}"]`,
            )
          : null;

        return row
          ? Math.round(
              row.getBoundingClientRect().top -
                viewport.getBoundingClientRect().top,
            )
          : null;
      }, pinned.topId);

      const now = await probe();
      idleTrace.push(`${Math.round(now.scrollTop)}:${offset ?? "gone"}`);
      await page.waitForTimeout(100);
    }

    results.pull = {
      requestsDuringPull: pullStop - pullStart,
      requestsWhileIdle: olderRequests.length - pullStop,
      pinnedRow: pinned.topId,
      pinnedOffset: Math.round(pinned.topOffset),
      idleTrace: [...new Set(idleTrace)],
    };

    const meaningful = steps.filter((step) => step.shift !== null);
    const shifts = meaningful.map((step) => Math.abs(step.shift!));

    results.summary = {
      steps: steps.length,
      lostAnchorSteps: steps.length - meaningful.length,
      maxShift: Math.round(Math.max(0, ...shifts)),
      stepsShiftedOver2px: shifts.filter((shift) => shift > 2).length,
      maxJitter: Math.max(0, ...steps.map((step) => step.jitter)),
      stepsWithJitterOver2px: steps.filter((step) => step.jitter > 2).length,
      unexpectedTopJumps: steps.filter(
        (step) =>
          step.direction === "up" &&
          step.scrollTopAfter < 40 &&
          step.scrollTopBefore > 440,
      ).length,
      totalOlderRequests: olderRequests.length,
      continuous: results.continuous,
      idleRequestsAfterUp: results.idleRequestsAfterUp,
      fling: results.fling,
      pull: results.pull,
      gapsBeforePull: results.historyRanges,
      apiErrors: [...new Set(apiErrors)],
      consoleErrors: consoleErrors.slice(0, 5),
    };
    results.steps = steps;
  }
} finally {
  await browser.close();
  server.close();
}

await writeFile(`${scratch}/result.json`, JSON.stringify(results, null, 2));

console.log(JSON.stringify(results.summary, null, 2));

console.log(
  JSON.stringify(
    (results.steps as StepResult[])
      .filter(
        (step) =>
          step.shift === null || Math.abs(step.shift) > 2 || step.jitter > 2,
      )
      .slice(0, 25),
  ),
);
