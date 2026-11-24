import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { tsImport } from "tsx/esm/api";
import { WebSocket, WebSocketServer } from "ws";
import { buildNodeEsmEntry } from "../../../scripts/build-utils.mjs";

const KIB = 1024;

const MIB = 1024 * KIB;

const RSS_LIMIT_BYTES = 300 * MIB;

const HEARTBEAT_PROBE_INTERVAL_MS = 2_000;

const HEARTBEAT_LATENCY_LIMIT_MS = 5_000;

const DRAIN_TIMEOUT_MS = 10_000;

const SLOW_CLOSE_TIMEOUT_MS = 8_000;

const ROUTING_HEADER = "x-harness-routing-key";

const PRODUCTION_NODE_OPTIONS = /^ENV NODE_OPTIONS=(\S.*)$/mu.exec(
  readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"),
)?.[1];

if (PRODUCTION_NODE_OPTIONS === undefined) {
  throw new Error("apps/relay/Dockerfile must set ENV NODE_OPTIONS");
}

const OWNER_HEADER = "x-harness-owner";

const { values } = parseArgs({
  options: {
    tunnels: { type: "string", default: "50" },
    streams: { type: "string", default: "10" },
    "slow-readers": { type: "string", default: "5" },
    seconds: { type: "string", default: "30" },
    "fast-kib": { type: "string", default: "64" },
    "slow-mib": { type: "string", default: "48" },
    "stalled-tunnels": { type: "string", default: "1" },
    "stalled-uploaders": { type: "string", default: "8" },
  },
});

function positiveInteger(name, raw, allowZero = false) {
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(
      `--${name} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }

  return parsed;
}

const tunnelCount = positiveInteger("tunnels", values.tunnels);

const streamsPerTunnel = positiveInteger("streams", values.streams);

const slowReaderCount = positiveInteger(
  "slow-readers",
  values["slow-readers"],
  true,
);

const seconds = positiveInteger("seconds", values.seconds);

const fastBytes = positiveInteger("fast-kib", values["fast-kib"]) * KIB;

const slowBytes = positiveInteger("slow-mib", values["slow-mib"]) * MIB;

const stalledTunnelCount = positiveInteger(
  "stalled-tunnels",
  values["stalled-tunnels"],
  true,
);

const stalledUploaders = positiveInteger(
  "stalled-uploaders",
  values["stalled-uploaders"],
);

const STALLED_MESSAGE_BYTES = 2 * MIB;

const STALLED_MESSAGES_PER_UPLOADER = 4;

const TUNNEL_BACKLOG_BOUND_BYTES = 48 * MIB;

if (seconds + 25 > 60) {
  throw new Error(
    "--seconds must leave the whole run inside 60 seconds (at most 35)",
  );
}

const { TunnelSession } = await tsImport(
  "@omnyo/tunnel-client",
  import.meta.url,
);

const { HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, PROTOCOL_VERSION } =
  await tsImport("@omnyo/tunnel-contract", import.meta.url);

const relayEntry = fileURLToPath(
  new URL("../src/tunnel/load-smoke-relay.ts", import.meta.url),
);

const relayDirectory = fileURLToPath(new URL("..", import.meta.url));

const connectDbMigrations = fileURLToPath(
  new URL("../../../packages/connect-db/migrations/", import.meta.url),
);

const relayMigrations = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

const bundleParent = fileURLToPath(
  new URL("../node_modules/.cache/", import.meta.url),
);

await mkdir(bundleParent, { recursive: true });

const bundleDirectory = await mkdtemp(`${bundleParent}load-smoke-`);

const relayBundle = `${bundleDirectory}/relay.mjs`;

function removeBundle() {
  rmSync(bundleDirectory, { force: true, recursive: true });
}

try {
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint: relayEntry,
    outfile: relayBundle,
    packageRoot: relayDirectory,
    sourcemap: false,
  });
} catch (error) {
  removeBundle();
  throw error;
}

const fastBody = Buffer.alloc(fastBytes, 5);

const origin = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://origin.local");

  if (url.pathname === "/fast") {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(fastBody.byteLength),
    });
    response.end(fastBody);

    return;
  }

  if (url.pathname === "/slow") {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(256 * KIB, 9);
    let written = 0;
    let open = true;
    response.once("close", () => {
      open = false;
    });

    const writeNext = () => {
      while (open && written < slowBytes) {
        written += chunk.byteLength;

        if (!response.write(chunk)) {
          response.once("drain", writeNext);

          return;
        }
      }

      if (open) response.end();
    };

    writeNext();

    return;
  }

  response.writeHead(404);
  response.end();
});

const originSockets = new WebSocketServer({ noServer: true });

originSockets.on("connection", (socket) => socket.on("message", () => {}));

origin.on("upgrade", (request, socket, head) =>
  originSockets.handleUpgrade(request, socket, head, (ws) =>
    originSockets.emit("connection", ws, request),
  ),
);

origin.listen(0, "127.0.0.1");

await once(origin, "listening");

const originPort = origin.address().port;

const relay = spawn(
  process.execPath,
  [relayBundle, connectDbMigrations, relayMigrations],
  {
    cwd: relayDirectory,
    env: { ...process.env, NODE_OPTIONS: PRODUCTION_NODE_OPTIONS },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
);

relay.once("exit", removeBundle);

const relayExited = once(relay, "exit");

function nextRelayMessage(type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      relay.off("message", onMessage);
      relay.off("exit", onExit);
      resolve(message);
    };

    const onExit = (code) => {
      relay.off("message", onMessage);
      reject(new Error(`the relay process exited early with code ${code}`));
    };

    relay.on("message", onMessage);
    relay.once("exit", onExit);
  });
}

const startedAt = performance.now();

const watchdog = setTimeout(
  () => {
    console.error(
      "load-smoke: the run exceeded its time bound; stopping the relay",
    );
    relay.kill("SIGKILL");
    removeBundle();
    process.exit(2);
  },
  (seconds + 25) * 1000,
);

const ready = await nextRelayMessage("ready");

const relayPort = ready.port;

const agent = new Agent({ keepAlive: true, maxSockets: Infinity });

function resolveOrigin(target) {
  if (target !== undefined) return { kind: "unregistered" };

  return {
    kind: "ok",
    resolved: {
      origin: `http://127.0.0.1:${originPort}`,
      publicOrigin: "http://load.relay.test",
    },
  };
}

const tunnels = [];

async function dialTunnel(index) {
  const routingKey = `t${index}`;

  const socket = new WebSocket(
    `ws://127.0.0.1:${relayPort}/__tunnel?v=${PROTOCOL_VERSION}`,
    {
      headers: {
        [ROUTING_HEADER]: routingKey,
        [OWNER_HEADER]: `server:s${index}`,
      },
    },
  );

  const session = new TunnelSession({
    tunnel: socket,
    log: { warn: () => {}, info: () => {} },
    resolveOrigin,
  });

  socket.once("open", () => session.start());
  await once(socket, "open");

  const tunnel = {
    routingKey,
    socket,
    closedDuringRun: false,
    probesSent: 0,
    probesAnswered: 0,
    maxAckMs: 0,
    pendingProbeAt: null,
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary || data.toString() !== HEARTBEAT_RESPONSE) return;

    if (tunnel.pendingProbeAt === null) return;
    tunnel.maxAckMs = Math.max(
      tunnel.maxAckMs,
      performance.now() - tunnel.pendingProbeAt,
    );
    tunnel.probesAnswered += 1;
    tunnel.pendingProbeAt = null;
  });
  socket.once("close", () => {
    if (running) tunnel.closedDuringRun = true;
  });
  tunnels.push(tunnel);
}

let running = true;

await Promise.all(
  Array.from({ length: tunnelCount }, (_, index) => dialTunnel(index)),
);

const stalledTunnels = [];

async function dialStalledTunnel(index) {
  const routingKey = `stalled${index}`;

  const socket = new WebSocket(
    `ws://127.0.0.1:${relayPort}/__tunnel?v=${PROTOCOL_VERSION}`,
    {
      headers: {
        [ROUTING_HEADER]: routingKey,
        [OWNER_HEADER]: `server:stalled${index}`,
      },
    },
  );

  const session = new TunnelSession({
    tunnel: socket,
    log: { warn: () => {}, info: () => {} },
    resolveOrigin,
  });

  socket.once("open", () => session.start());
  await once(socket, "open");

  const stalled = { routingKey, socket, uploaders: [], closedByRelay: false };

  socket.once("close", () => {
    if (running) stalled.closedByRelay = true;
  });

  stalled.uploaders = await Promise.all(
    Array.from({ length: stalledUploaders }, async () => {
      const uploader = new WebSocket(`ws://127.0.0.1:${relayPort}/sink`, {
        headers: { [ROUTING_HEADER]: routingKey },
      });

      uploader.on("error", () => {});
      await once(uploader, "open");

      return uploader;
    }),
  );

  socket.pause();
  stalled.heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(HEARTBEAT_REQUEST);
  }, HEARTBEAT_PROBE_INTERVAL_MS);

  const message = Buffer.alloc(STALLED_MESSAGE_BYTES, 6);

  for (const uploader of stalled.uploaders) {
    for (let count = 0; count < STALLED_MESSAGES_PER_UPLOADER; count += 1) {
      uploader.send(message);
    }
  }

  stalledTunnels.push(stalled);
}

await Promise.all(
  Array.from({ length: stalledTunnelCount }, (_, index) =>
    dialStalledTunnel(index),
  ),
);

const probeTimer = setInterval(() => {
  const now = performance.now();

  for (const tunnel of tunnels) {
    if (tunnel.pendingProbeAt !== null) {
      tunnel.maxAckMs = Math.max(tunnel.maxAckMs, now - tunnel.pendingProbeAt);
      continue;
    }

    if (tunnel.socket.readyState !== WebSocket.OPEN) continue;
    tunnel.pendingProbeAt = now;
    tunnel.probesSent += 1;
    tunnel.socket.send(HEARTBEAT_REQUEST);
  }
}, HEARTBEAT_PROBE_INTERVAL_MS);

function getFast(routingKey) {
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: "/fast",
        agent,
        headers: { [ROUTING_HEADER]: routingKey },
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.byteLength;
        });
        response.once("end", () =>
          resolve(
            response.statusCode === 200 && received === fastBytes
              ? "ok"
              : `status ${response.statusCode}, ${received} bytes`,
          ),
        );
        response.once("error", (error) => resolve(error.message));
      },
    );

    request.once("error", (error) => resolve(error.message));
    request.end();
  });
}

const fast = { ok: 0, failed: 0, failures: new Map() };

async function fastLoop(routingKey) {
  while (running) {
    const outcome = await getFast(routingKey);

    if (outcome === "ok") {
      fast.ok += 1;
    } else {
      fast.failed += 1;
      fast.failures.set(outcome, (fast.failures.get(outcome) ?? 0) + 1);
    }
  }
}

function openSlowReader(routingKey) {
  const slow = {
    routingKey,
    received: 0,
    status: null,
    closed: null,
    error: null,
  };

  slow.done = new Promise((resolve) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: relayPort,
        path: "/slow",
        headers: { [ROUTING_HEADER]: routingKey },
      },
      (response) => {
        slow.status = response.statusCode;
        slow.response = response;
        response.pause();
        response.on("data", (chunk) => {
          slow.received += chunk.byteLength;
        });
        response.once("error", (error) => {
          slow.error = error.message;
        });
        response.once("close", () => {
          slow.closed = response.complete ? "complete" : "aborted";
          resolve();
        });
      },
    );

    request.once("error", (error) => {
      slow.error = error.message;
      slow.closed = "request-error";
      resolve();
    });
    request.end();
  });

  return slow;
}

const slowReaders = tunnels
  .slice(0, slowReaderCount)
  .map((tunnel) => openSlowReader(tunnel.routingKey));

const loops = tunnels.flatMap((tunnel) =>
  Array.from({ length: streamsPerTunnel }, () => fastLoop(tunnel.routingKey)),
);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

running = false;

const drained = await Promise.race([
  Promise.all(loops).then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
]);

clearInterval(probeTimer);

for (const slow of slowReaders) slow.response?.resume();

await Promise.race([
  Promise.all(slowReaders.map((slow) => slow.done)),
  new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_TIMEOUT_MS)),
]);

relay.send({ type: "report" });

const report = await nextRelayMessage("report");

relay.send({ type: "shutdown" });

await relayExited;

clearTimeout(watchdog);

for (const tunnel of tunnels) tunnel.socket.terminate();

for (const stalled of stalledTunnels) {
  clearInterval(stalled.heartbeat);

  for (const uploader of stalled.uploaders) uploader.terminate();
  stalled.socket.terminate();
}

agent.destroy();

origin.closeAllConnections();

origin.close();

const heartbeatMisses = tunnels.filter(
  (tunnel) =>
    tunnel.closedDuringRun ||
    tunnel.probesAnswered === 0 ||
    tunnel.probesAnswered < tunnel.probesSent - 1 ||
    tunnel.maxAckMs > HEARTBEAT_LATENCY_LIMIT_MS,
);

const slowSummary = slowReaders.map((slow) => ({
  routingKey: slow.routingKey,
  status: slow.status,
  receivedBytes: slow.received,
  closed: slow.closed,
  error: slow.error,
}));

const slowClosedByOverflow = slowSummary.filter(
  (slow) => slow.closed === "aborted" && slow.receivedBytes < slowBytes,
).length;

const overflowEvents = report.events["tunnel.stream_overflow"] ?? 0;

const peakRelayRssBytes = Math.max(report.peakRssBytes, report.maxRssBytes);

const checks = {
  zeroFailedFastStreams: fast.failed === 0 && fast.ok > 0,
  fastStreamsDrained: drained,
  everySlowReaderClosedByOverflow:
    slowClosedByOverflow === slowReaderCount &&
    overflowEvents >= slowReaderCount,
  noMissedHeartbeat: heartbeatMisses.length === 0,
  peakRelayRssBelow300MiB: peakRelayRssBytes < RSS_LIMIT_BYTES,
  noSilentTunnelClosed: (report.events["tunnel.silent"] ?? 0) === 0,
  stalledTunnelBacklogBounded:
    report.peakBacklogBytes <= TUNNEL_BACKLOG_BOUND_BYTES,
};

const summary = {
  config: {
    tunnels: tunnelCount,
    streamsPerTunnel,
    slowReaders: slowReaderCount,
    seconds,
    fastBytes,
    slowBytes,
    stalledTunnels: stalledTunnelCount,
    stalledUploaders,
  },
  elapsedSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
  fastStreams: {
    ok: fast.ok,
    failed: fast.failed,
    failures: Object.fromEntries(fast.failures),
    requestsPerSecond: Math.round(fast.ok / seconds),
  },
  slowReaders: slowSummary,
  stalledTunnels: stalledTunnels.map((stalled) => ({
    routingKey: stalled.routingKey,
    closedByRelay: stalled.closedByRelay,
  })),
  heartbeats: {
    probes: tunnels.reduce((total, tunnel) => total + tunnel.probesSent, 0),
    answered: tunnels.reduce(
      (total, tunnel) => total + tunnel.probesAnswered,
      0,
    ),
    maxAckMs: Math.round(
      Math.max(0, ...tunnels.map((tunnel) => tunnel.maxAckMs)),
    ),
    missingTunnels: heartbeatMisses.map((tunnel) => tunnel.routingKey),
  },
  relay: {
    pid: ready.pid,
    nodeOptions: PRODUCTION_NODE_OPTIONS,
    readyRssMiB: Math.round((ready.readyRssBytes / MIB) * 10) / 10,
    peakRssMiB: Math.round((report.peakRssBytes / MIB) * 10) / 10,
    maxRssMiB: Math.round((report.maxRssBytes / MIB) * 10) / 10,
    atPeakMiB: Object.fromEntries(
      Object.entries(report.peakMemory).map(([name, bytes]) => [
        name.replace(/Bytes$/u, ""),
        Math.round((bytes / MIB) * 10) / 10,
      ]),
    ),
    peakBufferedMiB: Math.round((report.peakBufferedBytes / MIB) * 10) / 10,
    peakTunnelBacklogMiB: Math.round((report.peakBacklogBytes / MIB) * 10) / 10,
    finalStats: report.stats,
    events: report.events,
  },
  checks,
  passed: Object.values(checks).every(Boolean),
};

removeBundle();

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () =>
  process.exit(summary.passed ? 0 : 1),
);
