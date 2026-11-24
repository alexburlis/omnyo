import { spawn } from "node:child_process";

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export const DEFAULT_CHILD_TIMEOUT_MS = 10_000;

export interface ChildProcessOptions {
  run?: ProcessRunner;
  timeoutMs?: number;
}

export const runProcess: ProcessRunner = (request) =>
  new Promise((resolve) => {
    const child = spawn(request.executable, [...request.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: null,
        stdout: "",
        stderr: `${request.executable} did not finish within ${request.timeoutMs} ms`,
      });
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});

    child.on("error", (error) =>
      finish({ exitCode: null, stdout: "", stderr: error.message }),
    );

    child.on("close", (code) =>
      finish({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );

    child.stdin.end(request.stdin);
  });
