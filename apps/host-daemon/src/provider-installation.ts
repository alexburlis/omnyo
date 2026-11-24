import { PassThrough, type Readable } from "node:stream";
import { spawn as spawnProcess } from "node:child_process";
import type { ProviderInstallationCommand } from "@omnyo/provider-bridge-protocol";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@omnyo/host-daemon-contract";
import { spawn as spawnPty } from "node-pty";
import { createProcessStop, resolveExecutable } from "@omnyo/process-utils";
import type { HostDaemonLogger } from "./logger.js";
import { ensureNodePtySpawnHelperExecutable } from "./terminals/terminal-manager.js";

const nodePtyLogger: HostDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ProviderInstallationProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean | Promise<void>;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface ProviderInstallationProcessSpawner {
  spawn(args: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }): ProviderInstallationProcess;
}

let activeProviderId: string | null = null;

export class ProviderInstallationInProgressError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider installation already running for ${providerId}`);
    this.name = "ProviderInstallationInProgressError";
    this.providerId = providerId;
  }
}

const WINDOWS_BATCH_META_PATTERN = /([()\[\]%!^"\x60<>&|;, *?])/gu;

function escapeWindowsBatchArgument(argument: string): string {
  let escaped = argument.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/gu, "$1$1");
  escaped = `"${escaped}"`;

  return escaped
    .replace(WINDOWS_BATCH_META_PATTERN, "^$1")
    .replace(WINDOWS_BATCH_META_PATTERN, "^$1");
}

function createProviderInstallationProcessSpawner(): ProviderInstallationProcessSpawner {
  return {
    spawn(args) {
      const cwd = process.cwd();
      const env = args.env ?? process.env;

      const command =
        process.platform === "win32"
          ? resolveExecutable(args.command, { cwd, env })
          : args.command;

      if (command === undefined) {
        throw new Error(`Executable not found: ${args.command}`);
      }

      if (process.platform === "win32") {
        const isBatchCommand = /\.(?:cmd|bat)$/iu.test(command);
        let launchCommand = command;
        let launchArgs = args.args;

        if (isBatchCommand) {
          const interpreterKey = Object.keys(env)
            .sort()
            .find((key) => key.toUpperCase() === "COMSPEC");

          const interpreter = env[interpreterKey ?? "ComSpec"];

          if (!interpreter) {
            throw new Error("Windows command interpreter is unavailable");
          }

          const batchCommand = [
            command.replace(WINDOWS_BATCH_META_PATTERN, "^$1"),
            ...args.args.map(escapeWindowsBatchArgument),
          ].join(" ");

          launchCommand = interpreter;
          launchArgs = ["/d", "/v:off", "/s", "/c", `"${batchCommand}"`];
        }

        const child = spawnProcess(launchCommand, launchArgs, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: isBatchCommand,
        });

        const stop = createProcessStop(child);

        return {
          stdout: child.stdout,
          stderr: child.stderr,
          async kill() {
            const result = await stop();

            if (result.treeTermination !== "confirmed") {
              throw new Error("Provider updater process tree did not stop");
            }
          },
          onError(listener) {
            child.on("error", listener);
          },
          onClose(listener) {
            child.on("close", listener);
          },
        };
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      ensureNodePtySpawnHelperExecutable(nodePtyLogger);

      const pty = spawnPty(command, args.args, {
        cols: 120,
        cwd,
        env,
        name: "xterm-256color",
        rows: 30,
      });

      pty.onData((data) => stdout.write(data));
      pty.onExit(() => {
        stdout.end();
        stderr.end();
      });

      return {
        stdout,
        stderr,
        kill(signal) {
          pty.kill(signal);

          return true;
        },
        onError(listener) {
          void listener;
        },
        onClose(listener) {
          pty.onExit((event) => listener(event.exitCode, null));
        },
      };
    },
  };
}

export function streamProviderInstallation(args: {
  providerId: string;
  plan: ProviderInstallationCommand;
  env?: NodeJS.ProcessEnv;
  processSpawner?: ProviderInstallationProcessSpawner;
}): ReadableStream<Uint8Array> {
  if (activeProviderId !== null) {
    throw new ProviderInstallationInProgressError(activeProviderId);
  }

  activeProviderId = args.providerId;
  let closed = false;
  let child: ProviderInstallationProcess | null = null;

  const release = () => {
    if (activeProviderId === args.providerId) activeProviderId = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const write = (event: ProviderCliInstallEvent) => {
        if (closed) return;
        const parsed = providerCliInstallEventSchema.parse(event);
        controller.enqueue(encoder.encode(`${JSON.stringify(parsed)}\n`));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        release();
        controller.close();
      };

      write({
        type: "started",
        provider: args.providerId,
        command: args.plan.displayCommand,
      });

      try {
        const processArgs: Parameters<
          ProviderInstallationProcessSpawner["spawn"]
        >[0] = {
          command: args.plan.command,
          args: [...args.plan.args],
        };

        if (args.env !== undefined) processArgs.env = args.env;

        child = (
          args.processSpawner ?? createProviderInstallationProcessSpawner()
        ).spawn(processArgs);
      } catch (error) {
        write({
          type: "error",
          provider: args.providerId,
          message: error instanceof Error ? error.message : String(error),
        });
        close();

        return;
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stdout",
          text,
        }),
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stderr",
          text,
        }),
      );
      child.onError((error) => {
        write({
          type: "error",
          provider: args.providerId,
          message: error.message,
        });
        close();
      });
      child.onClose((exitCode, signal) => {
        write({
          type: "completed",
          provider: args.providerId,
          exitCode,
          signal,
          success: exitCode === 0,
        });
        close();
      });
    },
    async cancel() {
      closed = true;
      await child?.kill("SIGTERM");
      release();
    },
  });
}
