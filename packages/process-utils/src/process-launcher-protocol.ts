export type ProcessLauncherRequest =
  | {
      type: "run";
      id: number;
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string | undefined>;
      maxBuffer: number;
      timeout: number | null;
      input: string | null;
      streamStderr: boolean;
    }
  | { type: "abort"; id: number };

export interface ProcessLauncherFailure {
  name: string;
  message: string;
  code: string | number | null;
  signal: string | null;
  killed: boolean;
  treeTermination: "confirmed" | "unverified" | null;
  processGroupId: number | null;
  processPlatform: string | null;
  stdout: string;
  stderr: string;
  syscall: string | null;
  cause: { name: string; message: string } | null;
}

export type ProcessLauncherResponse =
  | { type: "stderr"; id: number; chunk: string }
  | { type: "succeeded"; id: number; stdout: string; stderr: string }
  | { type: "failed"; id: number; error: ProcessLauncherFailure };

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isEnv(value: unknown): value is Record<string, string | undefined> {
  return (
    isFields(value) &&
    Object.values(value).every(
      (entry) => entry === undefined || typeof entry === "string",
    )
  );
}

function parseFailure(value: unknown): ProcessLauncherFailure | null {
  if (!isFields(value)) return null;

  const {
    name,
    message,
    code,
    signal,
    killed,
    treeTermination,
    processGroupId,
    processPlatform,
    stdout,
    stderr,
    syscall,
    cause,
  } = value;

  if (
    typeof name !== "string" ||
    typeof message !== "string" ||
    !(code === null || typeof code === "string" || typeof code === "number") ||
    !isNullableString(signal) ||
    typeof killed !== "boolean" ||
    !(
      treeTermination === null ||
      treeTermination === "confirmed" ||
      treeTermination === "unverified"
    ) ||
    !(
      processGroupId === null ||
      (typeof processGroupId === "number" &&
        Number.isSafeInteger(processGroupId) &&
        processGroupId > 0)
    ) ||
    !isNullableString(processPlatform) ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    !isNullableString(syscall)
  )
    return null;

  if (cause === null)
    return {
      name,
      message,
      code,
      signal,
      killed,
      treeTermination,
      processGroupId,
      processPlatform,
      stdout,
      stderr,
      syscall,
      cause,
    };

  if (
    !isFields(cause) ||
    typeof cause.name !== "string" ||
    typeof cause.message !== "string"
  )
    return null;

  return {
    name,
    message,
    code,
    signal,
    killed,
    treeTermination,
    processGroupId,
    processPlatform,
    stdout,
    stderr,
    syscall,
    cause: { name: cause.name, message: cause.message },
  };
}

export function parseProcessLauncherRequest(
  value: unknown,
): ProcessLauncherRequest {
  if (isFields(value) && isId(value.id)) {
    if (value.type === "abort") return { type: "abort", id: value.id };

    const { command, args, cwd, env, maxBuffer, timeout, input, streamStderr } =
      value;

    if (
      value.type === "run" &&
      typeof command === "string" &&
      isStringArray(args) &&
      typeof cwd === "string" &&
      isEnv(env) &&
      typeof maxBuffer === "number" &&
      (timeout === null || typeof timeout === "number") &&
      isNullableString(input) &&
      typeof streamStderr === "boolean"
    )
      return {
        type: "run",
        id: value.id,
        command,
        args,
        cwd,
        env,
        maxBuffer,
        timeout,
        input,
        streamStderr,
      };
  }

  throw new Error("process launcher received an invalid request");
}

export function parseProcessLauncherResponse(
  value: unknown,
): ProcessLauncherResponse | null {
  if (!isFields(value) || !isId(value.id)) return null;

  if (value.type === "stderr" && typeof value.chunk === "string")
    return { type: "stderr", id: value.id, chunk: value.chunk };

  if (
    value.type === "succeeded" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  )
    return {
      type: "succeeded",
      id: value.id,
      stdout: value.stdout,
      stderr: value.stderr,
    };

  if (value.type === "failed") {
    const error = parseFailure(value.error);

    return error === null ? null : { type: "failed", id: value.id, error };
  }

  return null;
}
