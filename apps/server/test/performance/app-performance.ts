import { readFile, writeFile } from "node:fs/promises";
import {
  availableParallelism,
  cpus,
  hostname,
  loadavg,
  platform,
  release,
} from "node:os";
import { getLatestThreadSequence, pinThread } from "@omnyo/db";
import { EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS, turnScope } from "@omnyo/domain";
import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
} from "@omnyo/host-daemon-contract";
import type { HostDaemonOnlineRpcRequestMessage } from "@omnyo/host-daemon-contract";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  seedEvent,
  seedThread,
  type seedThreadFixture,
} from "../helpers/seed.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { writeCheckpoint } from "./checkpoint.js";
import {
  bindingSchema,
  digest,
  failures,
  markdown,
  scorecardSchema,
  type Metric,
  type Sample,
} from "./scorecard.js";

type Fixture = ReturnType<typeof seedThreadFixture>;

export function installPerformanceHost(
  harness: TestAppHarness,
  fixture: Pick<Fixture, "host" | "session" | "environment">,
) {
  const commands = Array.from({ length: 525 }, (_, index) => ({
    name: index === 524 ? "security-review" : `fixture-${index}`,
    description: `Synthetic command ${index}`,
    source: "command" as const,
    origin: "project" as const,
    argumentHint: null,
  }));

  const file = "Performance file contents.\n".repeat(4096);
  const activeTurns = new Map<string, string>();
  const unexpected: string[] = [];
  const dispatches: { threadId: string; input: string }[] = [];
  const stops: string[] = [];
  const received: string[] = [];

  const terminalOutput = new Map<
    string,
    { seq: number; dataBase64: string }[]
  >();

  const emit = (
    threadId: string,
    type: "turn/started" | "turn/completed",
    turnId: string,
  ) => {
    seedEvent(harness.deps, {
      threadId,
      environmentId: fixture.environment.id,
      providerThreadId: "performance-inert",
      scope: turnScope(turnId),
      sequence: getLatestThreadSequence(harness.db, { threadId }) + 1,
      type,
      data: type === "turn/completed" ? { status: "completed" } : {},
    });
    harness.hub.notifyThread(threadId, ["events-appended"]);
  };

  const handle = ({ command }: HostDaemonOnlineRpcRequestMessage) => {
    switch (command.type) {
      case "plugin.host.call":
        if (command.method !== "resolveNativeRoots")
          throw new Error(`Unsupported inert plugin method: ${command.method}`);

        return { output: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS };
      case "provider.health":
        return {
          supported: true,
          health: {
            status: "ready",
            statusMessage: null,
            accountEmail: null,
            planLabel: null,
            installedVersion: null,
            minimumSupportedVersion: null,
            canInstall: false,
            canUpdate: false,
            loginCommand: null,
          },
        };
      case "provider.list_models":
        return {
          models: [
            availableModelFixture({ model: "test-default", isDefault: true }),
          ],
          selectedOnlyModels: [],
        };
      case "provider.installation.status":
        return {
          executableName: "performance-inert",
          executablePath: "/fixture/inert",
          installed: true,
          installSource: "external",
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          minimumSupportedVersion: null,
          npmPackageName: null,
          npmGlobalPackageVersion: null,
          installAction: null,
          needsUpdate: false,
          versionUnsupported: false,
        };
      case "workspace.pull_request":
        return { outcome: "absent" };
      case "workspace.status":
        return {
          outcome: "unavailable",
          failure: {
            code: "not_git_repo",
            workspacePath: "/fixture",
            message: "Inert fixture does not inspect a Git repository",
          },
        };
      case "host.list_command_metadata":
        return { commands, projectSkills: [], sharedSkills: [] };
      case "host.read_workspace_agent_context":
        return {
          agentInstructions: null,
          projectSkills: [],
          projectSkillsTruncated: false,
          sharedSkills: [],
        };
      case "host.list_files":
        return {
          files: [{ path: "fixture.md", name: "fixture.md" }],
          truncated: false,
        };
      case "host.list_paths":
        return {
          paths: [
            {
              path: "fixture.md",
              name: "fixture.md",
              kind: "file",
              score: 1,
              positions: [],
            },
          ],
          truncated: false,
        };
      case "host.read_file":
        return {
          path: command.path,
          content: file,
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          modifiedAtMs: 1234,
          sha256: digest(file),
          sizeBytes: Buffer.byteLength(file),
        };
      case "host.read_file_chunk":
        return {
          path: command.path,
          content: Buffer.from(file).subarray(
            command.offset,
            command.offset + command.length,
          ),
          offset: command.offset,
          mimeType: "text/markdown",
          modifiedAtMs: 1234,
          revision: digest(file),
          sizeBytes: Buffer.byteLength(file),
        };
      case "workspace.diff":
        return {
          outcome: "available",
          diff: {
            diff: "diff --git a/fixture.md b/fixture.md\n--- a/fixture.md\n+++ b/fixture.md\n@@ -1 +1 @@\n-before\n+after\n",
            truncated: false,
            shortstat: "1 file changed, 1 insertion(+), 1 deletion(-)",
            files: "fixture.md | 2 +-",
            mergeBaseRef: null,
          },
        };
      case "thread.start":
      case "turn.submit": {
        dispatches.push({
          threadId: command.threadId,
          input: JSON.stringify(command.input),
        });
        const turnId = `performance-${command.requestId}`;
        activeTurns.set(command.threadId, turnId);
        emit(command.threadId, "turn/started", turnId);

        return command.type === "thread.start"
          ? { providerThreadId: "performance-inert" }
          : { trace: { spans: [] } };
      }

      case "thread.stop": {
        stops.push(command.threadId);
        const turnId = activeTurns.get(command.threadId);

        if (turnId) {
          emit(command.threadId, "turn/completed", turnId);
          activeTurns.delete(command.threadId);
        }

        return { providerCheckpointId: null };
      }

      default:
        throw new Error(`Unsupported inert host command: ${command.type}`);
    }
  };

  harness.hub.registerDaemon(fixture.session.id, fixture.host.id, {
    close() {},
    send(data) {
      const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));

      if (message.type === "host-rpc.request") {
        received.push(message.command.type);

        try {
          harness.hub.recordHostOnlineRpcResponse({
            sessionId: fixture.session.id,
            message: hostDaemonOnlineRpcResponseMessageSchema.parse({
              type: "host-rpc.response",
              requestId: message.requestId,
              commandType: message.command.type,
              ok: true,
              result: handle(message),
            }),
          });
        } catch (error) {
          unexpected.push(
            error instanceof Error ? error.message : "Host fixture failed",
          );
          harness.hub.recordHostOnlineRpcResponse({
            sessionId: fixture.session.id,
            message: {
              type: "host-rpc.response",
              requestId: message.requestId,
              commandType: message.command.type,
              ok: false,
              errorCode: "fixture_failed",
              errorMessage: "Inert host fixture rejected the request",
            },
          });
        }
      } else if (message.type === "terminal.open") {
        terminalOutput.set(message.terminalId, []);
        harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.opened",
            requestId: message.requestId,
            terminalId: message.terminalId,
            shell: "/bin/inert",
            title: "Inert terminal",
            initialCwd: "/fixture",
            cols: message.cols,
            rows: message.rows,
          },
        });
      } else if (message.type === "terminal.input") {
        const chunks = terminalOutput.get(message.terminalId);

        if (!chunks) throw new Error("Terminal input preceded open");
        const chunk = { seq: chunks.length, dataBase64: message.dataBase64 };
        chunks.push(chunk);
        harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.output",
            terminalId: message.terminalId,
            chunk,
          },
        });
      } else if (message.type === "terminal.attach") {
        const chunks = terminalOutput.get(message.terminalId);

        if (!chunks) throw new Error("Terminal attach preceded open");
        harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId: message.terminalId,
            chunks: chunks.filter((chunk) => chunk.seq >= message.sinceSeq),
            replayStartSeq: message.sinceSeq,
            nextSeq: chunks.length,
          },
        });
      } else if (message.type === "terminal.close") {
        harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.exited",
            terminalId: message.terminalId,
            exitCode: 0,
            closeReason: "user",
          },
        });
      }
    },
  });

  return { unexpected, file, dispatches, stops, received };
}

export async function runAppPerformance(
  args: Fixture & {
    browser: any;
    harness: TestAppHarness;
    origin: string;
    heavy: Fixture;
    heavyTurn: {
      threadId: string;
      environmentId: string;
      providerThreadId: string;
      scope: ReturnType<typeof turnScope>;
    };
    output: string;
    appDist: string;
  },
) {
  const {
    browser,
    harness,
    origin,
    thread,
    project,
    heavy,
    heavyTurn,
    output,
  } = args;

  const suiteStarted = performance.now();

  const runnerTimings: {
    id: string;
    startedAt: string;
    wallMs: number;
    setupMs: number;
    operationMs: number;
    iterations: number;
  }[] = [];

  const samples = Number(process.env.OMNYO_PERFORMANCE_SAMPLES ?? "30");

  const diagnostic = process.env.OMNYO_PERFORMANCE_DIAGNOSTIC ?? "";

  if (
    diagnostic &&
    !["history-navigation", "browser-actions"].includes(diagnostic)
  )
    throw new Error("Unknown performance diagnostic");

  if (!Number.isInteger(samples) || samples < 1 || samples > 100)
    throw new Error("Samples must be an integer from 1 to 100");

  const source = bindingSchema.parse(
    JSON.parse(
      await readFile(process.env.OMNYO_PERFORMANCE_BINDING ?? "", "utf8"),
    ),
  );

  const host = installPerformanceHost(harness, args);
  const heavyHost = installPerformanceHost(harness, heavy);

  const actionThread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: args.environment.id,
    providerId: thread.providerId,
    title: "Inert action fixture",
  });

  for (let index = 0; index < 1000; index++)
    seedThread(harness.deps, {
      projectId: project.id,
      title: `Sidebar workload ${index}`,
    });
  pinThread(harness.db, harness.hub, { threadId: thread.id });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });

  await context.route(
    (url: URL) => url.origin !== origin,
    (route: any) => route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  const metrics: Metric[] = [];
  const errors: string[] = [];
  let requestCount = 0;
  let responseBytes = 0;
  let httpRequestCount = 0;
  let httpResponseBytes = 0;
  const reads = new Set<Promise<void>>();
  const progressPath = output.replace(/\.json$/u, ".progress.json");
  await writeFile(progressPath, JSON.stringify({ source, errors, metrics }), {
    flag: "wx",
  });

  const writeProgress = async (active?: {
    id: string;
    index: number;
    phase: "setup" | "operation";
  }) => {
    await writeCheckpoint(
      progressPath,
      JSON.stringify(
        {
          source,
          errors,
          metrics,
          runnerTimings,
          wallMs: performance.now() - suiteStarted,
          active,
        },
        null,
        2,
      ) + "\n",
    );
  };

  const settleReads = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        Promise.all([...reads]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Response body collection exceeded 8000ms")),
            8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const observe = (tab: any) => {
    tab.on("pageerror", () =>
      errors.push("Browser page error; inspect the local fixture run"),
    );
    tab.on("request", () => requestCount++);
    tab.on("requestfailed", (request: any) => {
      if (new URL(request.url()).origin !== origin) return;
      const error = request.failure()?.errorText ?? "Unknown network failure";

      if (error !== "net::ERR_ABORTED")
        errors.push(
          `Request failed: ${new URL(request.url()).pathname}: ${error}`,
        );
    });
    tab.on("requestfinished", (request: any) => {
      if (new URL(request.url()).origin !== origin) return;

      const pending = request.sizes().then(
        (sizes: { responseBodySize: number }) => {
          responseBytes += sizes.responseBodySize;
        },
        () => {
          errors.push(
            `Could not measure completed response size: ${new URL(request.url()).pathname}`,
          );
        },
      );

      reads.add(pending);
      void pending.finally(() => reads.delete(pending));
    });
  };

  observe(page);
  const threadPath = `/projects/${project.id}/threads/${thread.id}`;

  const answer =
    "Performance answer 39. This synthetic completed message is readable.";

  const editor = () => page.locator('[contenteditable="true"]').first();

  const ready = async () => {
    await page.getByText(answer, { exact: true }).waitFor({ state: "visible" });
    await editor().waitFor({ state: "visible" });
  };

  const navigate = async (path: string) => {
    await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  };

  const request = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    requestCount++;
    httpRequestCount++;

    const response = await fetch(origin + "/api/v1" + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });

    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    responseBytes += bytes;
    httpResponseBytes += bytes;

    if (!response.ok)
      throw new Error(
        `${method} ${path.replace(/[a-f0-9]{20,}/gu, "id")}: HTTP ${response.status}: ${text.slice(0, 400)}`,
      );

    return JSON.parse(text);
  };

  const ensure = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };

  const clearEditor = async () => {
    await editor().press("ControlOrMeta+A");
    await editor().press("Backspace");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 100);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timeout);
              resolve();
            }),
          );
        }),
    );
    ensure(
      (await editor().textContent()) === "",
      "Composer reset did not commit",
    );
  };

  const waitForDispatch = async (text: string) => {
    const deadline = performance.now() + 8000;

    while (
      !host.dispatches.some(
        (dispatch) =>
          dispatch.threadId === actionThread.id &&
          dispatch.input.includes(text),
      )
    ) {
      if (performance.now() >= deadline)
        throw new Error(
          `Accepted send did not reach the inert daemon: ${JSON.stringify({ received: host.received.slice(-10), unexpected: host.unexpected, thread: await request(`/threads/${actionThread.id}`) }).slice(0, 1800)}`,
        );
      await new Promise((done) => setTimeout(done, 5));
    }
  };

  const bounded = async <T>(
    phase: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${phase} exceeded 30000ms`)),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const measure = async (
    definition: Omit<Metric, "samples"> & { expectedRequests?: number },
    operation: (
      index: number,
    ) => Promise<void | { durationMs: number; domNodes: number }>,
    setup: () => Promise<void> = async () => {},
  ) => {
    if (
      (diagnostic === "history-navigation" &&
        !["history-scroll", "chat-navigation"].includes(definition.id)) ||
      (diagnostic === "browser-actions" &&
        !["settings-open", "plugins-open", "stream-visible"].includes(
          definition.id,
        ))
    )
      return;

    const journeyStarted = performance.now();

    const timing = {
      id: definition.id,
      startedAt: new Date().toISOString(),
      wallMs: 0,
      setupMs: 0,
      operationMs: 0,
      iterations: 0,
    };

    runnerTimings.push(timing);
    const { expectedRequests, ...measurement } = definition;
    const metric: Metric = { ...measurement, samples: [] };
    metrics.push(metric);
    const count = definition.cache === "fresh-context" ? 3 : samples;

    for (let index = -definition.warmups; index < count; index++) {
      let result: Sample;
      const iterationStarted = performance.now();
      let setupRecorded = false;
      let operationStarted: number | null = null;
      let start = performance.now();
      let initialRequests = requestCount;
      let initialBytes = responseBytes;
      let initialHttpRequests = httpRequestCount;
      let initialHttpBytes = httpResponseBytes;

      const traffic = () => {
        const requests = requestCount - initialRequests;
        const bytes = responseBytes - initialBytes;
        const httpRequests = httpRequestCount - initialHttpRequests;
        const httpBytes = httpResponseBytes - initialHttpBytes;

        return definition.surface === "http"
          ? {
              requests: httpRequests,
              responseBytes: httpBytes,
              browserTraffic: {
                requests: requests - httpRequests,
                responseBytes: bytes - httpBytes,
              },
            }
          : { requests, responseBytes: bytes };
      };

      try {
        await writeProgress({ id: definition.id, index, phase: "setup" });
        await bounded(`${definition.id} setup`, setup);
        await settleReads();
        timing.setupMs += performance.now() - iterationStarted;
        setupRecorded = true;
        initialRequests = requestCount;
        initialBytes = responseBytes;
        initialHttpRequests = httpRequestCount;
        initialHttpBytes = httpResponseBytes;
        start = performance.now();
        await writeProgress({ id: definition.id, index, phase: "operation" });
        start = performance.now();

        operationStarted = performance.now();

        const observed = await bounded(`${definition.id} operation`, () =>
          operation(index),
        );

        timing.operationMs += performance.now() - operationStarted;
        operationStarted = null;
        const durationMs = observed?.durationMs ?? performance.now() - start;
        await settleReads();
        result = {
          durationMs,
          error: null,
          ...traffic(),
          domNodes:
            observed?.domNodes ??
            (definition.surface === "browser"
              ? await page.locator("*").count()
              : null),
        };
        ensure(
          expectedRequests === undefined ||
            result.requests === expectedRequests,
          `${definition.id} expected ${expectedRequests} direct HTTP requests, observed ${result.requests}`,
        );
      } catch (error) {
        if (definition.surface === "browser")
          process.stdout.write(
            `Performance failure DOM ${definition.id}: ${(
              await bounded<string>("Failure DOM", () =>
                page.locator("body").innerText(),
              ).catch(() => "DOM unavailable")
            ).slice(0, 6000)}\n`,
          );
        result = {
          durationMs: performance.now() - start,
          error:
            error instanceof Error
              ? error.message.slice(0, 600)
              : "Measurement failed",
          ...traffic(),
          domNodes: null,
        };
      }

      if (!setupRecorded)
        timing.setupMs += performance.now() - iterationStarted;

      if (operationStarted !== null)
        timing.operationMs += performance.now() - operationStarted;
      timing.wallMs = performance.now() - journeyStarted;
      timing.iterations++;

      if (index >= 0) metric.samples.push(result);
      else if (result.error !== null)
        errors.push(`${definition.id} warmup: ${result.error}`);

      if (result.error !== null) {
        process.stdout.write(
          `Performance failure ${metric.id}: ${result.error}\n`,
        );

        for (
          let remaining = Math.max(index + 1, 0);
          remaining < count;
          remaining++
        )
          metric.samples.push({
            ...result,
            durationMs: 0,
            error:
              "Not executed because this journey's setup or preceding sample failed",
          });
        break;
      }
    }

    process.stdout.write(
      `Performance journey ${metric.id}: ${metric.samples.filter((sample) => sample.error === null).length}/${metric.samples.length} correct\n`,
    );
    await writeProgress();
  };

  const browserMetric = (
    id: string,
    category: Metric["category"],
    boundary: string,
  ): Omit<Metric, "samples"> => ({
    id,
    category,
    boundary,
    surface: "browser",
    cache: "warm",
    warmups: 2,
    limits: [
      "Automation wall time includes Playwright transport/actionability and DOM observation; no physical display paint",
      "Local built web app, inert host, desktop Chrome only",
    ],
  });

  const httpMetric = (
    id: string,
    category: Metric["category"],
    boundary: string,
    expectedRequests = 1,
  ): Omit<Metric, "samples"> & { expectedRequests: number } => ({
    id,
    category,
    boundary,
    surface: "http",
    cache: "warm",
    warmups: 2,
    expectedRequests,
    limits: [
      "Real loopback HTTP and SQLite; host work is deterministic and inert",
      "Excludes UI rendering, real filesystem/shell/provider/network latency",
    ],
  });

  try {
    await measure(
      {
        ...browserMetric(
          "startup-fresh-context",
          "startup",
          "Navigation start to readable latest message, composer and sidebar in a fresh browser context",
        ),
        cache: "fresh-context",
        warmups: 0,
      },
      async () => {
        const cold = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
        });

        try {
          await cold.route(
            (url: URL) => url.origin !== origin,
            (route: any) => route.abort(),
          );
          const tab = await cold.newPage();
          observe(tab);
          tab.setDefaultTimeout(30000);
          tab.setDefaultNavigationTimeout(30000);
          const began = performance.now();
          await tab.goto(origin + threadPath, {
            waitUntil: "domcontentloaded",
          });
          await tab
            .getByText(answer, { exact: true })
            .waitFor({ state: "visible" });
          await tab
            .locator('[contenteditable="true"]')
            .first()
            .waitFor({ state: "visible" });
          await tab
            .locator(`a[href="${threadPath}"]:visible`)
            .first()
            .waitFor({ state: "visible" });

          const result = {
            durationMs: performance.now() - began,
            domNodes: await tab.locator("*").count(),
          };

          await settleReads();

          return result;
        } finally {
          await cold.close();
        }
      },
    );
    await navigate(threadPath);
    await ready();
    await navigate(threadPath);
    await ready();
    await measure(
      browserMetric(
        "history-scroll",
        "history",
        "Scroll a populated history and return to the exact latest answer",
      ),
      async () => {
        const target = page.getByText(answer, { exact: true });

        const scroller = await target.evaluateHandle((element: Element) => {
          const viewport = element.closest("[data-page-scroll-viewport]");

          if (!viewport) throw new Error("History has no scrolling viewport");

          return viewport;
        });

        const bounds = await scroller.evaluate((element: Element) => {
          const rect = element.getBoundingClientRect();

          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });

        await page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );

        const scrollPosition = () =>
          scroller.evaluate((element: Element) => element.scrollTop);

        const before = await scrollPosition();
        ensure(before > 0, "History viewport did not begin below its top");

        await page.mouse.wheel(0, -1200);
        const upwardDeadline = performance.now() + 8000;

        while ((await scrollPosition()) >= before) {
          if (performance.now() >= upwardDeadline)
            throw new Error("History wheel did not move the timeline upward");
          await page.waitForTimeout(16);
        }

        await page.mouse.wheel(0, 100000);
        const downwardDeadline = performance.now() + 8000;

        const positions: number[][] = [];

        while (true) {
          const position = await scroller.evaluate((element: Element) => [
            element.scrollTop,
            element.scrollHeight,
            element.clientHeight,
          ]);

          positions.push(position);

          if (position[1] - position[2] - position[0] <= 4) break;

          if (performance.now() >= downwardDeadline) {
            process.stdout.write(
              `History viewport trace: ${JSON.stringify({ before, bounds, positions: [...positions.slice(0, 16), ...positions.slice(-16)] })}\n`,
            );
            throw new Error(
              "History wheel did not return the viewport to its bottom",
            );
          }

          await page.waitForTimeout(16);
        }

        await target.waitFor({ state: "visible" });
        ensure(
          await target.evaluate((element: Element) => {
            const viewport = element.closest("[data-page-scroll-viewport]");

            if (!viewport) return false;
            const message = element.getBoundingClientRect();
            const visible = viewport.getBoundingClientRect();

            return (
              message.top >= visible.top && message.bottom <= visible.bottom
            );
          }),
          "Latest answer is outside the history viewport",
        );
        await scroller.dispose();
      },
      async () => {
        await navigate(threadPath);
        await ready();
      },
    );
    await measure(
      browserMetric(
        "chat-navigation",
        "navigation",
        "Click the sidebar chat to its correct readable message and composer",
      ),
      async (index) => {
        if (diagnostic !== "history-navigation") {
          await page.locator(`a[href="${threadPath}"]:visible`).first().click();
          await ready();

          return;
        }

        const cdp = await context.newCDPSession(page);
        await bounded("Navigation CPU profiler start", async () => {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
          await cdp.send("Profiler.start");
        });
        const started = performance.now();

        const requests = new Map<
          object,
          {
            path: string;
            startMs: number;
            status: number | null;
            done: boolean;
          }
        >();

        const onRequest = (value: any) => {
          if (requests.size >= 64) return;
          requests.set(value, {
            path: new URL(value.url()).pathname.replaceAll(
              thread.id,
              "fixture-thread",
            ),
            startMs: performance.now() - started,
            status: null,
            done: false,
          });
        };

        const onResponse = (value: any) => {
          const request = requests.get(value.request());

          if (request) request.status = value.status();
        };

        const onDone = (value: object) => {
          const request = requests.get(value);

          if (request) request.done = true;
        };

        page.on("request", onRequest);
        page.on("response", onResponse);
        page.on("requestfinished", onDone);
        page.on("requestfailed", onDone);
        let clickMs: number | null = null;
        let readyMs: number | null = null;
        let error: string | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
          await page.locator(`a[href="${threadPath}"]:visible`).first().click();
          clickMs = performance.now() - started;
          await ready();
          readyMs = performance.now() - started;
        } catch (cause) {
          error =
            cause instanceof Error
              ? cause.message.slice(0, 300)
              : "Navigation failed";
          throw cause;
        } finally {
          page.off("request", onRequest);
          page.off("response", onResponse);
          page.off("requestfinished", onDone);
          page.off("requestfailed", onDone);

          const profilePath = output.replace(
            /\.json$/u,
            `.navigation-${index < 0 ? `warmup-${-index}` : index}.cpuprofile`,
          );

          try {
            const profile = await bounded(
              "Navigation CPU profiler stop",
              async () => {
                const response = await cdp.send("Profiler.stop");
                ensure(
                  response.profile !== undefined,
                  "Navigation CPU profile missing",
                );

                return JSON.stringify(response.profile);
              },
            );

            await writeFile(profilePath, profile + "\n", {
              flag: "wx",
            });
          } finally {
            await bounded("Navigation CPU profiler detach", () => cdp.detach());
          }

          const httpStarted = performance.now();

          const http = await request(`/threads/${thread.id}/timeline`).then(
            (value) => ({
              ok: true,
              containsExactAnswer: JSON.stringify(value).includes(answer),
            }),
            (cause: Error) => ({
              ok: false,
              error: cause.message.slice(0, 200),
            }),
          );

          const httpMs = performance.now() - httpStarted;
          let mainThread;

          try {
            mainThread = await Promise.race([
              page.evaluate(() => ({
                readyState: document.readyState,
                time: performance.now(),
              })),
              new Promise((resolve) => {
                timer = setTimeout(
                  () => resolve({ error: "Main-thread probe exceeded3000ms" }),
                  3000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }

          process.stdout.write(
            `Navigation causal probe: ${JSON.stringify({ index, clickMs, readyMs, error, profilePath, mainThread, http, httpMs, requests: [...requests.values()] })}\n`,
          );
        }
      },
      async () => {
        await navigate("/");
        await editor().waitFor({ state: "visible" });
      },
    );

    if (diagnostic === "history-navigation") return;

    await measure(
      browserMetric(
        "new-chat-composer",
        "new-chat",
        "Navigate to new chat and wait for its editable composer",
      ),
      async () => {
        await navigate("/");
        await editor().waitFor({ state: "visible" });
      },
      async () => {
        await navigate(threadPath);
        await ready();
      },
    );
    await navigate(threadPath);
    await ready();
    await measure(
      browserMetric(
        "composer-keystroke",
        "composer",
        "Insert one character through the browser keyboard to matching editor DOM",
      ),
      async () => {
        await editor().press("x");
        ensure(
          (await editor().innerText()).includes("x"),
          "Typed character missing",
        );
      },
      async () => {
        await clearEditor();
      },
    );
    await measure(
      browserMetric(
        "composer-large-input",
        "composer",
        "Insert 128KiB plain text through the browser editing path to matching editor DOM",
      ),
      async () => {
        const text = "paste ".repeat(21846);
        await editor().fill(text);
        ensure((await editor().textContent()) === text, "Large input differs");
      },
      async () => {
        await clearEditor();
      },
    );
    await navigate(threadPath);
    await ready();
    await measure(
      browserMetric(
        "slash-search",
        "discovery",
        "Type slash query to the exact correct command result among 525 commands",
      ),
      async () => {
        await editor().press("/");
        await editor().pressSequentially("security");
        await page
          .getByText("security-review", { exact: true })
          .waitFor({ state: "visible" });
      },
      async () => {
        await clearEditor();
        await page
          .getByText("security-review", { exact: true })
          .waitFor({ state: "hidden" });
      },
    );
    await clearEditor();
    await measure(
      browserMetric(
        "model-picker",
        "pickers",
        "Open provider/model picker to the fixture's available model choice",
      ),
      async () => {
        await page
          .getByRole("button", { name: /^Provider, model and reasoning/u })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Test-Default", exact: true })
          .last()
          .waitFor({ state: "visible" });
      },
      async () => {
        await page.keyboard.press("Escape");
      },
    );
    await page.keyboard.press("Escape");

    if (diagnostic !== "browser-actions") {
      await measure(
        httpMetric(
          "inert-chat-create",
          "new-chat",
          "Create a scheduled inert chat through HTTP to a readable persisted thread; scheduling prevents provider execution",
          2,
        ),
        async (index) => {
          const body = await request("/threads", {
            projectId: project.id,
            providerId: "codex",
            origin: "app",
            title: `Created fixture ${index}`,
            input: [{ type: "text", text: "Scheduled inert fixture" }],
            model: "test-default",
            environment: { type: "reuse", environmentId: args.environment.id },
            sendAt: Date.now() + 86400000,
          });

          const saved = await request(`/threads/${body.id}`);
          ensure(
            saved.id === body.id && saved.title === `Created fixture ${index}`,
            "Created thread differs",
          );
        },
      );
      await measure(
        httpMetric(
          "global-chat-search",
          "search",
          "Search the 1000-sidebar-chat workload to the correct target ID in the parsed response",
        ),
        async () => {
          const body = await request(
            "/threads/search?query=Performance&limitPerGroup=10",
          );

          ensure(
            body.active.results.some(
              (result: any) => result.thread.id === thread.id,
            ),
            "Search returned wrong target",
          );
        },
      );
      await measure(
        httpMetric(
          "command-catalog",
          "discovery",
          "Resolve command metadata through HTTP to all 525 fixture entries",
        ),
        async () => {
          const body = await request(
            `/projects/${project.id}/commands?provider=codex`,
          );

          ensure(
            body.commands.some(
              (entry: any) => entry.name === "security-review",
            ) && body.commands.length >= 525,
            "Command catalog incomplete",
          );
        },
      );
      await measure(
        httpMetric(
          "file-mention-discovery",
          "discovery",
          "Resolve workspace file paths through the actual project path route",
        ),
        async () => {
          const body = await request(
            `/projects/${project.id}/paths?query=fixture&includeFiles=true&includeDirectories=false`,
          );

          ensure(
            JSON.stringify(body).includes("fixture.md"),
            "File mention target missing",
          );
        },
      );
      await measure(
        httpMetric(
          "history-page",
          "history",
          "Read persisted timeline to the correct last answer in parsed JSON",
        ),
        async () => {
          const body = await request(`/threads/${thread.id}/timeline`);
          ensure(
            JSON.stringify(body).includes(answer),
            "Timeline lost expected answer",
          );
        },
      );
      await measure(
        httpMetric(
          "file-preview-read",
          "files",
          "Read and decode a 104KiB Markdown file through the real file route",
        ),
        async () => {
          const body = await request("/files/read", {
            hostId: args.host.id,
            path: "/fixture/fixture.md",
          });

          ensure(body.content === host.file, "Preview content differs");
        },
      );
      await measure(
        httpMetric(
          "workspace-diff",
          "files",
          "Read the real environment diff route to a correct one-file patch",
        ),
        async () => {
          const body = await request(
            `/environments/${args.environment.id}/diff?target=uncommitted`,
          );

          ensure(
            JSON.stringify(body).includes("+after"),
            "Diff content differs",
          );
        },
      );
      let terminalId = "";
      await measure(
        httpMetric(
          "terminal-open",
          "terminal",
          "Create terminal to acknowledged running session through the terminal lifecycle",
        ),
        async () => {
          const body = await request("/terminals", {
            cols: 100,
            rows: 30,
            target: { kind: "thread", threadId: thread.id },
          });

          ensure(body.status === "running", "Terminal did not start");
          terminalId = body.id;
        },
        async () => {
          if (terminalId)
            await request(`/terminals/${terminalId}/close`, {
              mode: "force",
              reason: "user",
            });
        },
      );
      await request(`/terminals/${terminalId}/close`, {
        mode: "force",
        reason: "user",
      });

      const terminal = await request("/terminals", {
        cols: 100,
        rows: 30,
        target: { kind: "thread", threadId: thread.id },
      });

      terminalId = terminal.id;
      await measure(
        httpMetric(
          "terminal-input-echo",
          "terminal",
          "Input through HTTP and daemon message handling to the same bytes in the real output route",
          2,
        ),
        async (index) => {
          const dataBase64 = Buffer.from(`echo-${index}`).toString("base64");
          await request(`/terminals/${terminalId}/input`, { dataBase64 });
          const body = await request(`/terminals/${terminalId}/output`);
          ensure(
            JSON.stringify(body).includes(dataBase64),
            "Terminal echo missing",
          );
        },
      );
      await request(`/terminals/${terminalId}/close`, {
        mode: "force",
        reason: "user",
      });
      await measure(
        httpMetric(
          "inert-send-acceptance",
          "send",
          "Submit a message to accepted server response and inert daemon dispatch",
        ),
        async (index) => {
          const text = `Inert send ${index}`;

          const body = await request(`/threads/${actionThread.id}/send`, {
            input: [{ type: "text", text }],
            model: "test-default",
            reasoningLevel: "low",
            permissionMode: "full",
            serviceTier: "default",
            mode: "start",
          });

          ensure(body !== null, "Send not accepted");
          await waitForDispatch(text);
        },
        async () => {
          await request(`/threads/${actionThread.id}/stop`, {});
        },
      );
      await request(`/threads/${actionThread.id}/stop`, {});
      await measure(
        httpMetric(
          "queue-create-read",
          "interactions",
          "Create a queued message, read back its exact ID and text, then delete it through the real routes",
          3,
        ),
        async (index) => {
          const body = await request(
            `/threads/${heavy.thread.id}/queued-messages`,
            { input: [{ type: "text", text: `Queue ${index}` }] },
          );

          const queued = await request(
            `/threads/${heavy.thread.id}/queued-messages`,
          );

          ensure(
            JSON.stringify(queued).includes(body.id) &&
              JSON.stringify(queued).includes(`Queue ${index}`),
            "Queue item missing or changed",
          );
          await request(
            `/threads/${heavy.thread.id}/queued-messages/${body.id}`,
            undefined,
            "DELETE",
          );
        },
      );
      await measure(
        httpMetric(
          "stop-acknowledged",
          "interactions",
          "Stop an active inert turn through HTTP to the settled server response",
        ),
        async () => {
          const count = host.stops.length;
          const body = await request(`/threads/${actionThread.id}/stop`, {});
          ensure(body !== null, "Stop response missing");
          ensure(
            host.stops.length > count,
            "Stop did not reach the inert daemon",
          );
        },
        async () => {
          const text = `Stop fixture ${host.dispatches.length}`;
          await request(`/threads/${actionThread.id}/send`, {
            input: [{ type: "text", text }],
            model: "test-default",
            reasoningLevel: "low",
            permissionMode: "full",
            serviceTier: "default",
            mode: "start",
          });
          await waitForDispatch(text);
        },
      );
    }

    await measure(
      browserMetric(
        "settings-open",
        "plugins-settings",
        "Navigate to settings to its real settings content",
      ),
      async () => {
        await navigate("/settings/appearance");
        await page
          .getByRole("button", { name: "Theme", exact: true })
          .waitFor({ state: "visible" });
      },
      async () => {
        await navigate(threadPath);
        await ready();
      },
    );
    await measure(
      browserMetric(
        "plugins-open",
        "plugins-settings",
        "Navigate to the plugin catalog and wait for its search control",
      ),
      async () => {
        await navigate("/plugins");
        await page
          .getByPlaceholder(/Search/u)
          .first()
          .waitFor({ state: "visible" });
      },
      async () => {
        await navigate(threadPath);
        await ready();
      },
    );
    await measure(
      httpMetric(
        "update-status",
        "reconnect-updates",
        "Read local runtime update state through the actual update status route",
      ),
      async () => {
        const body = await request("/system/app-update");
        ensure(
          typeof body === "object" && body !== null,
          "Update status missing",
        );
      },
    );
    await navigate(`/projects/${heavy.project.id}/threads/${heavy.thread.id}`);
    await page
      .getByText("Selection sentinel stays stable.", { exact: true })
      .waitFor({ state: "attached" });
    await measure(
      browserMetric(
        "stream-visible",
        "streaming",
        "Seed one received delta and notify through WebSocket to the exact visible tail in a 135KB formatted answer",
      ),
      async (index) => {
        const tail = `stream-marker-${index}`;
        seedEvent(harness.deps, {
          ...heavyTurn,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: heavy.thread.id }) +
            1,
          type: "item/agentMessage/delta",
          data: { itemId: "heavy-answer", delta: `\n\n${tail}\n` },
        });
        harness.hub.notifyThread(heavy.thread.id, ["events-appended"]);
        await page
          .getByText(tail, { exact: true })
          .waitFor({ state: "attached" });
        await page
          .getByText(tail, { exact: true })
          .evaluate((element: Element) =>
            element.scrollIntoView({ block: "end", behavior: "instant" }),
          );
        await page
          .getByText(tail, { exact: true })
          .waitFor({ state: "visible" });
      },
    );
    await navigate(threadPath);
    await ready();
    await measure(
      browserMetric(
        "background-foreground-input",
        "background",
        "Type and verify input while a concurrent HTTP request builds/reads the large answer timeline",
      ),
      async () => {
        const background = request(`/threads/${heavy.thread.id}/timeline`);

        try {
          await editor().press("z");
          ensure(
            (await editor().innerText()).includes("z"),
            "Foreground character missing",
          );
        } finally {
          await background;
        }
      },
      async () => {
        await clearEditor();
      },
    );
  } catch (error) {
    errors.push(
      error instanceof Error
        ? error.message.slice(0, 600)
        : "Suite setup failed",
    );
  } finally {
    await context.close();
    await settleReads();

    await writeFile(
      output.replace(/\.json$/u, ".runner.json"),
      JSON.stringify(
        {
          schema: 1,
          source,
          wallMs: performance.now() - suiteStarted,
          journeys: runnerTimings,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );

    const rawReport = {
      schema: 1,
      recordedAt: new Date().toISOString(),
      source: source.source,
      buildHash: source.buildHash,
      contract: {
        suiteHash: source.suiteHash,
        fixture: "1000-sidebar-40-turns-135KB-answer-525-commands-actions-v2",
        machine: hostname(),
        platform: `${platform()} ${release()} ${process.arch}`,
        cpu: cpus()[0]?.model ?? "unknown",
        browser: browser.version(),
        node: process.version,
        viewport: "1440x1000",
        samples,
      },
      environment: {
        node: process.version,
        loadAverage: loadavg(),
        parallelism: availableParallelism(),
      },
      limits: [
        "Local built desktop web app with real HTTP/SQLite/WebSocket; no provider inference or production data",
        "Browser DOM readiness is not physical paint; timings include automation overhead",
        "Fresh contexts do not flush OS/server caches; cold observations report maximum, not p95",
        "HTTP host/terminal/diff responses are inert; native startup, real shell echo, remote filesystem and update installation require separate native measurements",
        "No retained-heap claim; response bytes exclude WebSocket frames; background measurement includes completion of its concurrent timeline request",
        "Managed benchmark admission does not exclude unmanaged machine load",
      ],
      errors: [...errors, ...host.unexpected, ...heavyHost.unexpected],
      metrics,
    };

    if (diagnostic) {
      await writeFile(
        output,
        JSON.stringify({ ...rawReport, diagnostic }, null, 2) + "\n",
        { flag: "wx" },
      );

      if (
        rawReport.errors.length ||
        metrics.length !== (diagnostic === "browser-actions" ? 3 : 2) ||
        metrics.some(
          (metric) =>
            metric.samples.length !== samples ||
            metric.samples.some((sample) => sample.error !== null),
        )
      )
        throw new Error(
          `${diagnostic} diagnostic failed; inspect its raw samples`,
        );

      return;
    }

    await writeFile(output, JSON.stringify(rawReport, null, 2) + "\n", {
      flag: "wx",
    });
    const report = scorecardSchema.parse(rawReport);
    await writeFile(output.replace(/\.json$/u, "") + ".md", markdown(report), {
      flag: "wx",
    });
    const issues = failures(report);

    if (issues.length)
      throw new Error(
        `Performance suite failed: ${issues.slice(0, 5).join("; ")}`,
      );
  }
}
