import { z } from "zod";
import { DEFAULT_MAX_BUFFERED_MB } from "../config.js";
import {
  RELAY_RESTART_CLOSE_CODE,
  RELAY_RESTART_CLOSE_REASON,
  type RelayLogger,
} from "../contracts.js";
import { openRelayDatabase } from "../db.js";
import { startTunnelHarness } from "./harness.js";
import { createTunnelRegistry } from "./registry.js";

const RSS_SAMPLE_INTERVAL_MS = 100;

const KIB = 1024;

const MIB = 1024 * KIB;

const migrationArguments = z.tuple([
  z
    .string()
    .min(1, { error: "the connect-db migrations directory is required" }),
  z.string().min(1, { error: "the relay migrations directory is required" }),
]);

const parentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("report") }),
  z.object({ type: z.literal("shutdown") }),
]);

const send = process.send?.bind(process);

if (send === undefined) {
  throw new Error("load-smoke-relay runs only as a child of load-smoke.mjs");
}

const counts = new Map<string, number>();

function count(event: string): void {
  counts.set(event, (counts.get(event) ?? 0) + 1);
}

const log: RelayLogger = {
  info: count,
  warn: count,
  error: count,
};

const [connectDb, relayLocal] = migrationArguments.parse(process.argv.slice(2));

const database = openRelayDatabase(":memory:", { connectDb, relayLocal });

const registry = createTunnelRegistry({
  database,
  log,
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_MB * MIB,
});

const harness = await startTunnelHarness(registry);

let peakRssBytes = process.memoryUsage().rss;

let peakBufferedBytes = 0;

let peakBacklogBytes = 0;

let peakMemory = process.memoryUsage();

function sampleMemory(): void {
  const usage = process.memoryUsage();

  if (usage.rss >= peakRssBytes) {
    peakRssBytes = usage.rss;
    peakMemory = usage;
  }
}

const sampler = setInterval(() => {
  sampleMemory();
  const stats = registry.stats();
  peakBufferedBytes = Math.max(peakBufferedBytes, stats.bufferedBytes);
  peakBacklogBytes = Math.max(peakBacklogBytes, stats.tunnelBacklogBytes);
}, RSS_SAMPLE_INTERVAL_MS);

process.on("message", (raw) => {
  const message = parentMessage.parse(raw);

  if (message.type === "report") {
    sampleMemory();
    send({
      type: "report",
      peakRssBytes,
      peakMemory: {
        heapTotalBytes: peakMemory.heapTotal,
        heapUsedBytes: peakMemory.heapUsed,
        externalBytes: peakMemory.external,
        arrayBuffersBytes: peakMemory.arrayBuffers,
      },
      maxRssBytes: process.resourceUsage().maxRSS * KIB,
      peakBufferedBytes,
      peakBacklogBytes,
      stats: registry.stats(),
      events: Object.fromEntries(counts),
    });

    return;
  }

  clearInterval(sampler);
  registry.closeAll(RELAY_RESTART_CLOSE_CODE, RELAY_RESTART_CLOSE_REASON);
  void harness.close().then(() => {
    database.close();
    process.exit(0);
  });
});

send({
  type: "ready",
  port: harness.port,
  pid: process.pid,
  readyRssBytes: process.memoryUsage().rss,
});
