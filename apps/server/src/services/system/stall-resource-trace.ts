import { spawn } from "node:child_process";
import { loadavg } from "node:os";
import { createInterface } from "node:readline";
import { roundDurationMs } from "@omnyo/process-utils";

const SAMPLE_LIMIT = 32;

const MAX_BOUNDARY_OFFSET_MS = 500;

interface ProcessSample {
  atMs: number;
  runnableUs: number;
  cpuUs: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  pageIns: number;
}

function parseProcessSample(line: string): ProcessSample | null {
  if (!/^\d{1,16}(?: \d{1,16}){5}$/.test(line)) return null;

  const [atMs, runnableUs, cpuUs, diskReadBytes, diskWriteBytes, pageIns] = line
    .split(" ")
    .map(Number);

  if (
    atMs === undefined ||
    runnableUs === undefined ||
    cpuUs === undefined ||
    diskReadBytes === undefined ||
    diskWriteBytes === undefined ||
    pageIns === undefined ||
    ![atMs, runnableUs, cpuUs, diskReadBytes, diskWriteBytes, pageIns].every(
      Number.isSafeInteger,
    )
  )
    return null;

  return { atMs, runnableUs, cpuUs, diskReadBytes, diskWriteBytes, pageIns };
}

export function startStallResourceTrace(helperPath: string) {
  let status: "unsupported" | "starting" | "sampling" | "unavailable" =
    process.platform === "darwin" ? "starting" : "unsupported";

  const samples: ProcessSample[] = [];

  const child =
    status === "starting"
      ? spawn(helperPath, { stdio: ["ignore", "pipe", "ignore"], env: {} })
      : null;

  const output = child?.stdout
    ? createInterface({ input: child.stdout, crlfDelay: Infinity })
    : null;

  output?.on("line", (line) => {
    const sample = parseProcessSample(line);

    if (sample === null) return;
    status = "sampling";
    samples.push(sample);

    if (samples.length > SAMPLE_LIMIT) samples.shift();
  });
  child?.once("error", () => {
    status = "unavailable";
  });
  child?.once("close", () => {
    status = "unavailable";
  });

  let previousThreadCpu = process.threadCpuUsage();
  let previousUsage = process.resourceUsage();

  return {
    sample(windowEndMs: number, sampleGapMs: number, stalled: boolean) {
      const threadCpu = process.threadCpuUsage();
      const usage = process.resourceUsage();
      const beforeThreadCpu = previousThreadCpu;
      const beforeUsage = previousUsage;
      previousThreadCpu = threadCpu;
      previousUsage = usage;

      if (!stalled) return;

      const windowStartMs = windowEndMs - sampleGapMs;

      const inWindow = samples.filter(
        (sample) =>
          sample.atMs >= windowStartMs - MAX_BOUNDARY_OFFSET_MS &&
          sample.atMs <= windowEndMs,
      );

      const first = inWindow[0];
      const last = inWindow.at(-1);

      const intervals = inWindow.flatMap((sample, index) => {
        const before = inWindow[index - 1];

        if (before === undefined || sample.atMs <= before.atMs) return [];
        const diskReadBytes = sample.diskReadBytes - before.diskReadBytes;
        const diskWriteBytes = sample.diskWriteBytes - before.diskWriteBytes;
        const processPageIns = sample.pageIns - before.pageIns;
        const runnableUs = sample.runnableUs - before.runnableUs;
        const cpuUs = sample.cpuUs - before.cpuUs;

        if (
          diskReadBytes < 0 ||
          diskWriteBytes < 0 ||
          processPageIns < 0 ||
          runnableUs < 0 ||
          cpuUs < 0
        )
          return [];

        return [
          {
            fromMs: before.atMs,
            toMs: sample.atMs,
            processRunnableMs: roundDurationMs(runnableUs / 1_000),
            processCpuMs: roundDurationMs(cpuUs / 1_000),
            diskReadBytes,
            diskWriteBytes,
            processPageIns,
          },
        ];
      });

      return {
        windowStartMs,
        windowEndMs,
        mainThreadCpuMs: roundDurationMs(
          (threadCpu.user -
            beforeThreadCpu.user +
            threadCpu.system -
            beforeThreadCpu.system) /
            1_000,
        ),
        processVoluntaryContextSwitches:
          usage.voluntaryContextSwitches - beforeUsage.voluntaryContextSwitches,
        processInvoluntaryContextSwitches:
          usage.involuntaryContextSwitches -
          beforeUsage.involuntaryContextSwitches,
        hostLoad1m: roundDurationMs(loadavg()[0] ?? 0),
        macOSProcessCounters: {
          status,
          coversWindow:
            first !== undefined &&
            last !== undefined &&
            intervals.length > 0 &&
            intervals.length === inWindow.length - 1 &&
            Math.abs(first.atMs - windowStartMs) <= MAX_BOUNDARY_OFFSET_MS &&
            windowEndMs - last.atMs <= MAX_BOUNDARY_OFFSET_MS &&
            intervals.every(
              ({ fromMs, toMs }) => toMs - fromMs <= MAX_BOUNDARY_OFFSET_MS,
            ),
          intervals,
        },
      };
    },
    stop() {
      output?.close();
      child?.kill();
    },
  };
}
