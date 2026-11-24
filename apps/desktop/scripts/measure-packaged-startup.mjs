import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";
import { waitForChildExit } from "./child-process-helpers.mjs";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string", default: "baseline" },
    updates: { type: "string", default: "enabled" },
    "resolve-host": { type: "string" },
  },
});

const resolveHostname = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u,
  )
  .optional()
  .parse(values["resolve-host"]);

if (!values.output || !["baseline", "candidate"].includes(values.mode)) {
  throw new Error("Use --output PATH --mode baseline|candidate");
}

if (!["enabled", "disabled"].includes(values.updates)) {
  throw new Error("Use --updates enabled|disabled");
}

if (process.platform !== "darwin") {
  throw new Error("The installed-bundle timing fixture requires macOS");
}

function bounded(promise, label, milliseconds = 45_000) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolvePromise;

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());

  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function numericMarker(path) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const value = Number((await readFile(path, "utf8")).trim()) * 1000;
      requireCondition(
        Number.isFinite(value) && value > 0,
        "Invalid numeric shell marker",
      );

      return value;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      await delay(25);
    }
  }

  throw new Error("Silent login shell did not write its completion marker");
}

async function connectInspector(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const eventWaiters = new Map();
  let requestId = 0;
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());

    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) waiter?.reject(new Error("Inspector command failed"));
      else waiter?.resolve(message.result);
    } else {
      const waiter = eventWaiters.get(message.method);

      if (waiter) {
        eventWaiters.delete(message.method);
        waiter.resolve(message.params);
      }
    }
  });
  await bounded(
    new Promise((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", () =>
        reject(new Error("Inspector connection failed")),
      );
    }),
    "Inspector connection timed out",
    10_000,
  );

  return {
    call(method, params = {}) {
      const id = ++requestId;

      return bounded(
        new Promise((resolveCall, reject) => {
          pending.set(id, { resolve: resolveCall, reject });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        `Inspector ${method} timed out`,
        10_000,
      );
    },
    event(method) {
      const waiter = deferred();
      eventWaiters.set(method, waiter);

      return bounded(waiter.promise, `Inspector ${method} timed out`, 10_000);
    },
    close() {
      socket.close();
    },
  };
}

async function instrumentStartup(inspector) {
  await inspector.call("Debugger.enable");
  const paused = inspector.event("Debugger.paused");
  await inspector.call("Runtime.runIfWaitingForDebugger");
  const pause = await paused;
  const frame = pause.callFrames[0];
  requireCondition(frame !== undefined, "Missing paused main-process frame");

  const { scriptSource } = await inspector.call("Debugger.getScriptSource", {
    scriptId: frame.location.scriptId,
  });

  const initialization = await inspector.call("Debugger.evaluateOnCallFrame", {
    callFrameId: frame.callFrameId,
    expression:
      'globalThis.__omnyoStartupMeasurement = []; globalThis.__omnyoStartupElectronSession = require("electron").session; require("electron").app.setActivationPolicy("prohibited");',
  });

  requireCondition(
    !initialization.exceptionDetails,
    "Could not initialize numeric native observation",
  );

  async function logpoint(index, phase, extra = "") {
    requireCondition(index >= 0, `Missing native observation point: ${phase}`);
    const lineNumber = scriptSource.slice(0, index).split("\n").length - 1;
    await inspector.call("Debugger.setBreakpoint", {
      location: { scriptId: frame.location.scriptId, lineNumber },
      condition: `(globalThis.__omnyoStartupMeasurement.push({phase:${JSON.stringify(phase)},epochMs:performance.timeOrigin+performance.now()${extra}}),false)`,
    });
  }

  const start = scriptSource.search(
    /async function inspectInstalledPrivateUpdate\(/u,
  );

  const failure = scriptSource.indexOf(
    "Private installed update identity is invalid at",
    start,
  );

  requireCondition(
    start >= 0 && failure > start,
    "Installed verification observer is unavailable",
  );
  const scanSource = scriptSource.slice(start, failure);
  await logpoint(
    start + scanSource.indexOf('let gate = "bundle identity"'),
    "verification-start",
  );
  await logpoint(
    start + scanSource.lastIndexOf("return {"),
    "verification-complete",
  );
  await logpoint(
    scriptSource.lastIndexOf("throw new Error", failure),
    "verification-failed",
  );

  const remote = scriptSource.search(
    /async function loadRemoteServerTarget\(/u,
  );

  requireCondition(remote >= 0, "Remote UI observer is unavailable");
  await logpoint(
    scriptSource.indexOf("const loaded =", remote),
    "remote-load",
    ",installerOwned:privateUpdateInstaller!==null",
  );
  const resumedAtEpochMs = Date.now();
  await inspector.call("Debugger.resume");

  return resumedAtEpochMs;
}

function createFixture({ dataDir, desktopVersion, updatesEnabled }) {
  const assets = new Map();
  const generations = new Map();

  for (const generation of ["A", "B"]) {
    const source = `globalThis.fixtureGeneration=${JSON.stringify(generation)};`;
    const asset = `/assets/app-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.js`;
    assets.set(asset, source);
    generations.set(generation, asset);
  }

  const oldLazy = 'export const generation="A";';
  const lazyPath = `/assets/lazy-${createHash("sha256").update(oldLazy).digest("hex").slice(0, 16)}.js`;
  assets.set(lazyPath, oldLazy);
  let current;
  let ready = deferred();
  let updateFinished = deferred();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    const send = (status, body, type = "application/json", headers = {}) => {
      response.writeHead(status, { "content-type": type, ...headers });
      response.end(body);
    };

    if (url.pathname === "/health") return send(200, '{"ok":true}');

    if (url.pathname === "/api/v1/system/config") {
      return send(
        200,
        JSON.stringify({
          appearance: {
            customCss: null,
            faviconColor: "default",
            themeId: "default",
          },
          customThemes: [],
          dataDir,
          experiments: {},
          featureFlags: { placeholder: false },
          generalSettings: {},
          hostDaemonPort: 38887,
          primaryHostPlatform: null,
          voiceTranscriptionEnabled: false,
        }),
        "application/json",
        { "cache-control": "no-store" },
      );
    }

    if (url.pathname === "/fixture/api") {
      current.apiRequests += 1;

      return send(
        current.apiFailure ? 503 : 200,
        JSON.stringify({ revision: current.revision }),
        "application/json",
        { "cache-control": "no-store" },
      );
    }

    if (assets.has(url.pathname)) {
      const body = assets.get(url.pathname);
      current.assetRequests += 1;
      current.assetBytes += Buffer.byteLength(body);

      return send(200, body, "text/javascript", {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }

    if (
      url.pathname === "/fixture/ready" ||
      url.pathname === "/fixture/update"
    ) {
      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (body.length > 4096) return send(413, "{}");
      }

      try {
        const result = JSON.parse(body);

        if (url.pathname === "/fixture/ready") ready.resolve(result);
        else updateFinished.resolve(result);

        return send(204, "");
      } catch {
        return send(400, "{}");
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const etag = `"fixture-${current.generation}"`;

      if (request.headers["if-none-match"] === etag) {
        current.html304 += 1;

        return send(304, "", "text/html", {
          etag,
          "cache-control": "no-cache",
        });
      }

      current.html200 += 1;

      const html = `<!doctype html><meta charset="utf-8"><title>Packaged startup fixture</title>
<main>Startup fixture ${current.generation}</main><output id="api"></output><output id="update"></output>
<script src="${generations.get(current.generation)}"></script>
<script>
(async () => {
  const paints = new Promise((resolvePaint) => {
    const observer = new PerformanceObserver((entries) => {
      const paint = entries.getEntries().find((entry) => entry.name === "first-contentful-paint");
      if (paint) { observer.disconnect(); resolvePaint(paint.startTime); }
    });
    observer.observe({ type: "paint", buffered: true });
  });
  const info = await window.omnyoDesktop.getInfo();
  const api = await fetch("/fixture/api", { cache: "no-store" });
  const payload = await api.json();
  document.getElementById("api").textContent = api.ok ? "Current revision " + payload.revision : "API unavailable";
  const oldChunk = await import(${JSON.stringify(lazyPath)});
  const fcp = await paints;
  const resources = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/assets/"));
  await fetch("/fixture/ready", { method: "POST", body: JSON.stringify({
    bridgeOk: info.version === ${JSON.stringify(desktopVersion)},
    generation: globalThis.fixtureGeneration, oldChunkOk: oldChunk.generation === "A",
    apiStatus: api.status, apiRevision: payload.revision,
    apiVisible: document.getElementById("api").textContent,
    fcpMs: fcp, fcpEpochMs: performance.timeOrigin + fcp,
    readyEpochMs: performance.timeOrigin + performance.now(),
    resourceTransferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
    resourceDecodedBytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0)
  }) });
  if (${JSON.stringify(updatesEnabled)}) {
    const update = await window.omnyoDesktop.checkForUpdates();
    const failed = update.downloadState === "failed";
    document.getElementById("update").textContent = failed ? "Update unavailable" : "Update check complete";
    await fetch("/fixture/update", { method: "POST", body: JSON.stringify({
      failed, visible: document.getElementById("update").textContent,
      epochMs: performance.timeOrigin + performance.now()
    }) });
  }
})();
</script>`;

      return send(200, html, "text/html; charset=utf-8", {
        etag,
        "cache-control": "no-cache",
      });
    }

    return send(404, '{"message":"not found"}');
  });

  return {
    server,
    begin(generation, revision, apiFailure) {
      current = {
        generation,
        revision,
        apiFailure,
        assetRequests: 0,
        assetBytes: 0,
        apiRequests: 0,
        html200: 0,
        html304: 0,
      };
      ready = deferred();
      updateFinished = deferred();

      return {
        traffic: current,
        ready: ready.promise,
        update: updateFinished.promise,
      };
    },
  };
}

async function stopOwnedChild(child) {
  if (await waitForChildExit(child, 0)) return;
  child.kill("SIGTERM");

  if (await waitForChildExit(child, 5000)) return;
  child.kill("SIGKILL");
  requireCondition(
    await waitForChildExit(child, 5000),
    "Owned child did not exit; scratch retained",
  );
}

async function measure() {
  const channel = resolveDesktopReleaseChannel(process.env);

  const config = createDesktopReleaseConfig(
    channel,
    resolveDesktopBuildPlatform(process.platform),
  );

  const { version } = JSON.parse(
    await readFile(join(desktopRoot, "package.json"), "utf8"),
  );

  const appBinary = await resolvePackagedAppBinary({
    executableName: config.linuxExecutableName,
    platform: process.platform,
    productName: config.applicationName,
    releaseDir: join(desktopRoot, "release"),
  });

  const updatesEnabled = values.updates === "enabled";
  const root = await mkdtemp(join(tmpdir(), "omnyo-desktop-startup-"));
  const userDataDir = join(root, "profile");
  const dataDir = join(root, "data");
  const shellDir = join(root, "shell");

  const receipt = {
    schema: 1,
    mode: values.mode,
    updates: values.updates,
    version,
    appBinary,
    inspectorEnabled: true,
    shellDelayMs: 800,
    scratch: root,
    launches: [],
    completed: false,
  };

  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(
    resolve(values.output),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  let fixture;
  let child = null;

  try {
    await Promise.all([mkdir(userDataDir), mkdir(dataDir), mkdir(shellDir)]);
    fixture = createFixture({
      dataDir,
      desktopVersion: version,
      updatesEnabled,
    });
    const port = await listen(fixture.server);
    const serverUrl = `http://127.0.0.1:${port}`;
    const closedServer = createServer();
    const closedPort = await listen(closedServer);
    await closeServer(closedServer);
    await writeFile(
      join(userDataDir, "private-updates.json"),
      JSON.stringify(
        updatesEnabled
          ? {
              schema: 1,
              enabled: true,
              channel,
              url: `https://127.0.0.1:${closedPort}/`,
            }
          : { schema: 1, enabled: false },
      ),
    );
    await writeFile(
      join(userDataDir, "server-target.json"),
      JSON.stringify({
        connectServer: null,
        customServerUrl: serverUrl,
        customServerUrls: [serverUrl],
        target: "custom",
      }),
    );
    await writeFile(join(shellDir, ".zshrc"), "");

    for (const [index, generation, apiFailure] of [
      [1, "A", false],
      [2, "A", false],
      [3, "B", false],
      [4, "B", true],
    ]) {
      const shellStart = join(shellDir, `start-${index}`);
      const shellEnd = join(shellDir, `end-${index}`);
      await writeFile(
        join(shellDir, ".zprofile"),
        `zmodload zsh/datetime\nprint -r -- "$EPOCHREALTIME" > ${shellQuote(shellStart)}\n/bin/sleep 0.8\nprint -r -- "$EPOCHREALTIME" > ${shellQuote(shellEnd)}\n`,
      );
      const run = fixture.begin(generation, index, apiFailure);
      const endpoint = deferred();
      const childEnv = {};

      for (const key of [
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "SHELL",
        "PATH",
        "LANG",
      ]) {
        if (process.env[key] !== undefined) childEnv[key] = process.env[key];
      }

      Object.assign(childEnv, {
        ZDOTDIR: shellDir,
        OMNYO_DATA_DIR: dataDir,
        OMNYO_SERVER_PORT: String(port),
        OMNYO_DESKTOP_OPEN_DEVTOOLS: "0",
        OMNYO_DESKTOP_VERSION_FEED_URL: `${serverUrl}/desktop-version.json`,
      });
      const spawnedAtEpochMs = Date.now();
      const observation = { index, generation, apiFailure, spawnedAtEpochMs };
      receipt.launches.push(observation);
      child = spawn(
        appBinary,
        [
          "--inspect-brk=127.0.0.1:0",
          ...createPackagedAppLaunchArguments({
            platform: process.platform,
            userDataDir,
          }),
        ],
        { env: childEnv, stdio: ["ignore", "ignore", "pipe"] },
      );
      child.once("error", () => endpoint.resolve(null));
      let stderrRemainder = "";
      child.stderr.on("data", (chunk) => {
        stderrRemainder = (stderrRemainder + chunk.toString()).slice(-2048);

        const match =
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/u.exec(
            stderrRemainder,
          );

        if (match) {
          endpoint.resolve(match[1]);
          stderrRemainder = "";
        }
      });
      let inspector;

      try {
        const inspectorUrl = await bounded(
          endpoint.promise,
          "Packaged main inspector unavailable",
          10_000,
        );

        requireCondition(inspectorUrl !== null, "Packaged app failed to spawn");
        inspector = await connectInspector(inspectorUrl);
        const resumedAtEpochMs = await instrumentStartup(inspector);

        const renderer = await bounded(
          run.ready,
          "Packaged renderer did not produce paint metrics",
        );

        const update = updatesEnabled
          ? await bounded(run.update, "Local updater failure was not visible")
          : null;

        const observed = await inspector.call("Runtime.evaluate", {
          expression: "globalThis.__omnyoStartupMeasurement",
          returnByValue: true,
        });

        const phases = observed.result.value;
        const shellStartedEpochMs = await numericMarker(shellStart);
        const shellCompletedEpochMs = await numericMarker(shellEnd);

        const verification = phases.find(
          (phase) => phase.phase === "verification-complete",
        );

        const remote = phases.find((phase) => phase.phase === "remote-load");

        const result = {
          index,
          generation,
          apiFailure,
          spawnedAtEpochMs,
          resumedAtEpochMs,
          renderer,
          update,
          phases,
          shellStartedEpochMs,
          shellCompletedEpochMs,
          spawnToPaintMs: renderer.fcpEpochMs - spawnedAtEpochMs,
          resumeToPaintMs: renderer.fcpEpochMs - resumedAtEpochMs,
          shellDurationMs: shellCompletedEpochMs - shellStartedEpochMs,
          paintBeforeShellCompletion:
            renderer.fcpEpochMs < shellCompletedEpochMs,
          paintBeforeVerification: verification
            ? renderer.fcpEpochMs < verification.epochMs
            : null,
          traffic: { ...run.traffic },
        };

        Object.assign(observation, result);

        if (index === 1 && resolveHostname !== undefined) {
          const resolution = await inspector.call("Runtime.evaluate", {
            expression: `(async () => {
              const session = globalThis.__omnyoStartupElectronSession;
              const host = ${JSON.stringify(resolveHostname)};
              return await Promise.all(["default", "persist:omnyo-browser"].flatMap((partition) => {
                const target = partition === "default" ? session.defaultSession : session.fromPartition(partition);
                return ["any", "system", "dns"].map(async (source) => {
                  let timer;
                  try {
                    const result = await Promise.race([
                      target.resolveHost(host, { source, cacheUsage: "disallowed" }),
                      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("diagnostic-timeout")), 8000); })
                    ]);
                    return { partition, source, addresses: result.endpoints.map((endpoint) => endpoint.address), netError: null };
                  } catch (error) {
                    const netError = error?.message === "diagnostic-timeout" ? "diagnostic-timeout" : /(?:net::)?ERR_[A-Z0-9_]+/.exec(String(error?.code ?? error?.message ?? ""))?.[0] ?? "unclassified";
                    return { partition, source, addresses: [], netError };
                  } finally {
                    clearTimeout(timer);
                  }
                });
              }));
            })()`,
            awaitPromise: true,
            returnByValue: true,
          });

          requireCondition(
            !resolution.exceptionDetails,
            "Isolated Electron DNS diagnostic failed",
          );
          observation.hostResolution = z
            .array(
              z
                .object({
                  partition: z.enum(["default", "persist:omnyo-browser"]),
                  source: z.enum(["any", "system", "dns"]),
                  addresses: z.array(z.ipv4().or(z.ipv6())),
                  netError: z
                    .string()
                    .regex(
                      /^(?:(?:net::)?ERR_[A-Z0-9_]+|unclassified|diagnostic-timeout)$/u,
                    )
                    .nullable(),
                })
                .strict(),
            )
            .length(6)
            .parse(resolution.result.value);
        }

        requireCondition(
          renderer.bridgeOk &&
            renderer.generation === generation &&
            renderer.oldChunkOk,
          "Native generation or preload bridge mismatch",
        );
        requireCondition(
          renderer.apiRevision === index &&
            renderer.apiStatus === (apiFailure ? 503 : 200),
          "Native API freshness failed",
        );
        requireCondition(
          renderer.apiVisible ===
            (apiFailure ? "API unavailable" : `Current revision ${index}`),
          "API result was not visible",
        );
        requireCondition(
          Number.isFinite(renderer.fcpMs) &&
            renderer.fcpMs > 0 &&
            Number.isFinite(result.shellDurationMs),
          "Missing numeric native metrics",
        );
        requireCondition(
          remote?.installerOwned === true,
          "Remote UI preceded the installer journal owner",
        );

        if (updatesEnabled) {
          requireCondition(
            verification &&
              !phases.some((phase) => phase.phase === "verification-failed"),
            "Full installed-artifact verification did not complete",
          );
          requireCondition(
            update.failed && update.visible === "Update unavailable",
            "Local update failure was hidden",
          );
        }

        if (values.mode === "candidate") {
          if (index === 2 || index === 4)
            requireCondition(
              run.traffic.assetBytes === 0 && run.traffic.html304 > 0,
              "Warm native cache was not retained",
            );
          requireCondition(
            result.paintBeforeShellCompletion,
            "Remote paint still waited for shell PATH",
          );

          if (updatesEnabled)
            requireCondition(
              result.paintBeforeVerification,
              "Remote paint still waited for full installed verification",
            );
        }
      } finally {
        if (inspector && !observation.phases) {
          const observed = await inspector
            .call("Runtime.evaluate", {
              expression: "globalThis.__omnyoStartupMeasurement",
              returnByValue: true,
            })
            .catch(() => null);

          observation.phases = observed?.result?.value ?? [];
        }

        observation.exitCodeBeforeStop = child.exitCode;
        observation.signalBeforeStop = child.signalCode;
        inspector?.close();
        await stopOwnedChild(child);
        child = null;
      }
    }

    receipt.completed = true;
  } catch (error) {
    receipt.failure =
      error instanceof Error ? error.message : "Native measurement failed";
    process.exitCode = 1;
  } finally {
    if (child !== null) await stopOwnedChild(child);

    if (fixture) await closeServer(fixture.server);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
    receipt.scratchRemoved = true;
    await mkdir(dirname(resolve(values.output)), { recursive: true });
    await writeFile(
      resolve(values.output),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }

  console.log(
    JSON.stringify({
      completed: receipt.completed,
      launches: receipt.launches.length,
      output: resolve(values.output),
      failure: receipt.failure ?? null,
    }),
  );
}

await measure();
