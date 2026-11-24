import { totalmem } from "node:os";
import { startWindowsHostJob, type WindowsHostJob } from "@omnyo/process-utils";
import type { HostDaemonLogger } from "./logger.js";

export const AGENT_MEMORY_LIMIT_ENV = "OMNYO_AGENT_MEMORY_LIMIT_MIB";

const DEFAULT_MEMORY_SHARE = 0.5;

const MIB = 1024 * 1024;

export type AgentMemoryLimit =
  | { kind: "off" }
  | { kind: "bytes"; bytes: number; source: "default" | "env" };

export function resolveAgentMemoryLimit(args: {
  env: NodeJS.ProcessEnv;
  totalMemoryBytes: number;
}): AgentMemoryLimit {
  const raw = args.env[AGENT_MEMORY_LIMIT_ENV]?.trim();

  if (raw === undefined || raw === "") {
    return {
      kind: "bytes",
      bytes:
        Math.floor((args.totalMemoryBytes * DEFAULT_MEMORY_SHARE) / MIB) * MIB,
      source: "default",
    };
  }

  if (raw.toLowerCase() === "off") return { kind: "off" };

  if (!/^\d+$/.test(raw) || Number(raw) < 256) {
    throw new Error(
      `${AGENT_MEMORY_LIMIT_ENV} must be "off" or a whole number of MiB of at least 256`,
    );
  }

  return { kind: "bytes", bytes: Number(raw) * MIB, source: "env" };
}

interface CreateAgentProcessContainmentArgs {
  env?: NodeJS.ProcessEnv;
  logger: Pick<HostDaemonLogger, "info" | "warn" | "error">;
  platform?: NodeJS.Platform;
  startJob?: typeof startWindowsHostJob;
  totalMemoryBytes?: number;
}

export interface AgentProcessContainment {
  contain(pid: number): Promise<void>;
  dispose(): void;
  terminate(): Promise<number>;
}

export function createAgentProcessContainment(
  args: CreateAgentProcessContainmentArgs,
): AgentProcessContainment | undefined {
  if ((args.platform ?? process.platform) !== "win32") return undefined;

  let limit: AgentMemoryLimit;

  try {
    limit = resolveAgentMemoryLimit({
      env: args.env ?? process.env,
      totalMemoryBytes: args.totalMemoryBytes ?? totalmem(),
    });
  } catch (error) {
    args.logger.error(
      { err: error },
      "Agent processes cannot start until the memory limit is valid",
    );

    return {
      contain: () => Promise.reject(error),
      dispose: () => undefined,
      terminate: async () => 0,
    };
  }

  if (limit.kind === "off") {
    args.logger.warn(
      { env: AGENT_MEMORY_LIMIT_ENV },
      "Agent process containment is turned off for this machine",
    );

    return undefined;
  }

  const { bytes: memoryLimitBytes, source } = limit;
  const startJob = args.startJob ?? startWindowsHostJob;
  let current: Promise<WindowsHostJob> | undefined;
  let ready: WindowsHostJob | undefined;
  let disposed = false;

  const job = (): Promise<WindowsHostJob> => {
    if (disposed) {
      return Promise.reject(new Error("Agent process containment is closed"));
    }

    current ??= (async () => {
      const started = await startJob({ memoryLimitBytes });

      args.logger.info(
        {
          memoryLimitMiB: Math.round(memoryLimitBytes / MIB),
          source,
        },
        "Agent processes run in the Omnyo host job",
      );
      ready = started;
      void started.closed.then(() => {
        if (ready === started) ready = undefined;

        if (disposed) return;
        args.logger.error(
          {},
          "Omnyo host job helper exited; its agent processes were stopped",
        );
        current = undefined;
      });

      return started;
    })().catch((error: unknown) => {
      current = undefined;
      throw error;
    });

    return current;
  };

  void job().catch((error: unknown) => {
    args.logger.error(
      { err: error },
      "Could not start the Omnyo host job; agent starts will retry it",
    );
  });

  return {
    async contain(pid) {
      try {
        await (await job()).adopt(pid);
      } catch (error) {
        args.logger.error(
          { err: error, pid },
          "Could not place an agent process in the Omnyo host job",
        );
        throw error;
      }
    },
    async terminate() {
      if (ready === undefined) return 0;

      const count = await ready.terminate();

      args.logger.warn(
        { terminatedProcessCount: count },
        "Ended every agent process in the Omnyo host job",
      );

      return count;
    },
    dispose() {
      disposed = true;
      void current?.then(
        (started) => started.close(),
        () => undefined,
      );
    },
  };
}
