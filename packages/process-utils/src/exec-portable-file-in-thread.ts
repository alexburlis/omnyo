import { execa } from "execa";
import { createProcessStop } from "./managed-process.js";
import { resolveExecutable } from "./resolve-executable.js";
import {
  shouldCreateProcessGroup,
  type ProcessStopResult,
} from "./process-group.js";

export interface PortableFileRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout?: number;
  signal?: AbortSignal;
  input?: string;
  onStderr?: (chunk: string) => void;
}

export async function execPortableFileInThread(
  command: string,
  args: string[],
  options: PortableFileRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw options.signal.reason;

  const searchesPath = process.platform === "win32" || !command.includes("/");

  const executable = searchesPath
    ? resolveExecutable(command, options)
    : command;

  if (executable === undefined) {
    throw Object.assign(new Error(`spawn ${command} ENOENT`), {
      code: "ENOENT",
      syscall: `spawn ${command}`,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    });
  }

  const subprocess = execa(
    process.platform === "win32" ? command : executable,
    args,
    {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      encoding: "buffer",
      stripFinalNewline: false,
      maxBuffer: options.maxBuffer,
      input: options.input ?? "",
      detached: shouldCreateProcessGroup(),
      forceKillAfterDelay: 1_000,
      reject: false,
    },
  );

  const stopProcess = createProcessStop(subprocess);
  let stopPromise: Promise<ProcessStopResult> | undefined;

  let resolveStopped: (value: { stopped: ProcessStopResult }) => void = () =>
    undefined;

  const stoppedOutcome = new Promise<{ stopped: ProcessStopResult }>(
    (resolve) => {
      resolveStopped = resolve;
    },
  );

  const captured: Record<
    "stdout" | "stderr",
    { chunks: Buffer[]; size: number }
  > = {
    stdout: { chunks: [], size: 0 },
    stderr: { chunks: [], size: 0 },
  };

  let overflow: "stdout" | "stderr" | undefined;

  for (const key of ["stdout", "stderr"] as const) {
    subprocess[key]?.on("data", (chunk: Buffer) => {
      const remaining = options.maxBuffer - captured[key].size;

      if (chunk.length > remaining) overflow ??= key;

      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        captured[key].chunks.push(retained);
        captured[key].size += retained.length;
      }
    });
  }

  let canceled = false;
  let timedOut = false;

  function stop(): void {
    stopPromise ??= stopProcess({ gracePeriodMs: 1_000 }).catch(
      (): ProcessStopResult => ({ treeTermination: "unverified" }),
    );
    void stopPromise.then((stopped) => resolveStopped({ stopped }));
  }

  const onAbort = (): void => {
    canceled = true;
    stop();
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeout)
    : undefined;

  for (const stream of [subprocess.stdout, subprocess.stderr]) {
    stream?.once("close", () => {
      if (
        !stream.readableEnded &&
        (process.platform !== "win32" ||
          (subprocess.exitCode === null && subprocess.signalCode === null))
      ) {
        stop();
      }
    });
  }

  if (options.onStderr) {
    const decoder = new TextDecoder();
    const onStderr = options.onStderr;
    subprocess.stderr?.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true });

      if (text) onStderr(text);
    });
    subprocess.stderr?.on("end", () => {
      const text = decoder.decode();

      if (text) onStderr(text);
    });
  }

  const outcome = await Promise.race([
    subprocess.then((result) => ({ result })),
    stoppedOutcome,
  ]);

  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);
  const result = "result" in outcome ? outcome.result : undefined;

  if (result?.failed) stop();
  const stopResult = await stopPromise;

  const output = {
    stdout: Buffer.from(
      result?.stdout ?? Buffer.concat(captured.stdout.chunks),
    ).toString("utf8"),
    stderr: Buffer.from(
      result?.stderr ?? Buffer.concat(captured.stderr.chunks),
    ).toString("utf8"),
  };

  if (
    result !== undefined &&
    !result.failed &&
    !canceled &&
    !timedOut &&
    stopResult === undefined
  )
    return output;
  const maxBufferExceeded = result?.isMaxBuffer || overflow !== undefined;
  const stopped = canceled || maxBufferExceeded || timedOut;

  const syscall =
    result?.cause instanceof Error &&
    "syscall" in result?.cause &&
    typeof result?.cause.syscall === "string"
      ? result?.cause.syscall
      : undefined;

  const overflowStream =
    overflow ??
    (result?.shortMessage?.startsWith("Command's stderr was larger than ")
      ? "stderr"
      : "stdout");

  const message = canceled
    ? "The operation was aborted"
    : maxBufferExceeded
      ? `${overflowStream} maxBuffer length exceeded`
      : timedOut
        ? `Command timed out after ${options.timeout}ms`
        : result?.originalMessage || `Command failed: ${command}`;

  throw Object.assign(
    new Error(message, {
      cause: canceled ? options.signal?.reason : result?.cause,
    }),
    {
      name: canceled ? "AbortError" : "Error",
      code: canceled
        ? "ABORT_ERR"
        : maxBufferExceeded
          ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          : (result?.code ?? result?.exitCode ?? null),
      signal: stopped ? "SIGTERM" : (result?.signal ?? null),
      killed: stopped || result?.isTerminated,
      treeTermination: stopResult?.treeTermination ?? "confirmed",
      processGroupId: subprocess.pid ?? null,
      processPlatform: process.platform,
      ...(syscall === undefined ? {} : { syscall }),
      ...output,
    },
  );
}
