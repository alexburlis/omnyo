import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parseArgs } from "node:util";
import {
  hasErrorCode,
  type ServerArchiveDigest,
  ServerArchiveError,
} from "@omnyo/server-archive";
import { ApiError } from "../src/errors.js";
import {
  type OpenSqliteSnapshotSource,
  readFreeBytes,
  type ServerExportFreeSpace,
  type SqliteSnapshotSource,
} from "../src/services/server-move/export-snapshot.js";
import type { ServerLogger } from "../src/types.js";
import {
  type OmnyoAppRuntime,
  exportDataDirArchive,
} from "./stream-server-export-core.js";

const EXIT_OK = 0;

const EXIT_FAILED = 1;

const EXIT_USAGE = 2;

const EXIT_NO_CLIENT = 3;

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

const MIN_TOKEN_LENGTH = 32;

const EXPORT_PATH = "/export";

const UNSPECIFIED_ADDRESSES = new Set(["0.0.0.0", "::", "::ffff:0:0"]);

type ExitSignal = keyof typeof SIGNAL_EXIT_CODES;

class UsageError extends Error {}

interface ExportOptions {
  omnyoAppDir: string;
  dataDir: string;
  marginBytes: number;
  sqliteModule: string;
  workDir: string;
}

interface ServeOptions {
  host: string;
  maxWaitSeconds: number;
  port: number;
  tokenFile: string;
}

interface CliOptions {
  export: ExportOptions;
  serve: ServeOptions | null;
}

interface ExportContext {
  freeSpace: ServerExportFreeSpace;
  openDatabase: OpenSqliteSnapshotSource;
  options: ExportOptions;
  runtime: OmnyoAppRuntime;
  signal: AbortSignal;
}

type DatabaseConstructor = new (
  path: string,
  options?: { fileMustExist: boolean; readonly: boolean },
) => SqliteSnapshotSource;

const USAGE = `Usage: stream-server-export --data-dir <dir> --work-dir <dir> --margin-bytes <n> --sqlite-module <dir> --omnyo-app <dir> [--listen <ip:port> --token-file <file> --max-wait-seconds <n>]`;

function writeEvent(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    return error.body.code;
  }

  if (error instanceof ServerArchiveError) {
    return error.code;
  }

  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return "export_failed";
}

function requiredOption(
  values: Record<string, string | undefined>,
  name: string,
): string {
  const value = values[name];

  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`Missing --${name}. ${USAGE}`);
  }

  return value;
}

function parseCount(name: string, value: string): number {
  const parsed = Number(value);

  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new UsageError(`--${name} must be a whole number, not ${value}`);
  }

  return parsed;
}

function parseListen(value: string): { host: string; port: number } {
  const match =
    /^(?:\[(?<ipv6>[^\]]+)\]|(?<ipv4>[^:[\]]+)):(?<port>\d+)$/u.exec(value);

  const host = match?.groups?.ipv6 ?? match?.groups?.ipv4 ?? "";
  const port = Number(match?.groups?.port ?? "");

  if (isIP(host) === 0 || !Number.isInteger(port) || port > 65_535) {
    throw new UsageError(
      `--listen must be an IP address and port such as 100.64.0.1:8443 or [fd7a::1]:8443, not ${value}`,
    );
  }

  if (UNSPECIFIED_ADDRESSES.has(host.toLowerCase())) {
    throw new UsageError(
      `--listen ${value} would accept connections on every interface. Give the one address to serve on.`,
    );
  }

  return { host, port };
}

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      "omnyo-app": { type: "string" },
      "data-dir": { type: "string" },
      listen: { type: "string" },
      "margin-bytes": { type: "string" },
      "max-wait-seconds": { type: "string" },
      "sqlite-module": { type: "string" },
      "token-file": { type: "string" },
      "work-dir": { type: "string" },
    },
  });

  const exportOptions: ExportOptions = {
    omnyoAppDir: resolve(requiredOption(values, "omnyo-app")),
    dataDir: resolve(requiredOption(values, "data-dir")),
    marginBytes: parseCount(
      "margin-bytes",
      requiredOption(values, "margin-bytes"),
    ),
    sqliteModule: resolve(requiredOption(values, "sqlite-module")),
    workDir: resolve(requiredOption(values, "work-dir")),
  };

  const serveValues = [
    values.listen,
    values["token-file"],
    values["max-wait-seconds"],
  ];

  if (serveValues.every((value) => value === undefined)) {
    return { export: exportOptions, serve: null };
  }

  const listen = parseListen(requiredOption(values, "listen"));

  return {
    export: exportOptions,
    serve: {
      ...listen,
      maxWaitSeconds: parseCount(
        "max-wait-seconds",
        requiredOption(values, "max-wait-seconds"),
      ),
      tokenFile: resolve(requiredOption(values, "token-file")),
    },
  };
}

async function assertDirectory(name: string, path: string): Promise<void> {
  const stats = await stat(path).catch(() => null);

  if (stats === null || !stats.isDirectory()) {
    throw new UsageError(`--${name} ${path} is not an existing directory`);
  }
}

function assertWorkDirOutsideDataDir(options: ExportOptions): void {
  const workDirFromData = relative(options.dataDir, options.workDir);

  if (
    workDirFromData === "" ||
    (!workDirFromData.startsWith("..") && !isAbsolute(workDirFromData))
  ) {
    throw new UsageError(
      `--work-dir ${options.workDir} is inside --data-dir. Use a directory outside the data dir so the export cannot archive its own snapshot.`,
    );
  }
}

function loadSqliteModule(modulePath: string): OpenSqliteSnapshotSource {
  let loaded: unknown;

  try {
    loaded = createRequire(import.meta.url)(modulePath);
  } catch (error) {
    throw new UsageError(
      `Could not load better-sqlite3 from ${modulePath}: ${errorMessage(error)}`,
    );
  }

  if (typeof loaded !== "function") {
    throw new UsageError(
      `${modulePath} does not export the better-sqlite3 Database constructor`,
    );
  }

  const Database = loaded as DatabaseConstructor;

  try {
    new Database(":memory:").close();
  } catch (error) {
    throw new UsageError(
      `better-sqlite3 from ${modulePath} could not open a database: ${errorMessage(error)}`,
    );
  }

  return (path) => new Database(path, { fileMustExist: true, readonly: true });
}

async function loadRuntime(omnyoAppDir: string): Promise<OmnyoAppRuntime> {
  const { readOmnyoAppRuntime } =
    await import("./stream-server-export-core.js");

  try {
    return await readOmnyoAppRuntime(omnyoAppDir);
  } catch (error) {
    throw new UsageError(
      `Could not read the Omnyo app runtime identity in ${omnyoAppDir}: ${errorMessage(error)}`,
    );
  }
}

const exportLogger: Pick<ServerLogger, "warn"> = {
  warn(details: unknown, message?: string): void {
    writeEvent({ event: "warning", message: message ?? null, details });
  },
};

function exportFileName(now: Date): string {
  return `omnyo-server-${now.toISOString().slice(0, 10)}.tar.gz`;
}

async function runStdoutExport(context: ExportContext): Promise<number> {
  if (process.stdout.isTTY) {
    throw new UsageError(
      "stdout is a terminal. Redirect it to a file or a pipe.",
    );
  }

  const digest = await exportDataDirArchive({
    dataDir: context.options.dataDir,
    freeSpace: context.freeSpace,
    logger: exportLogger,
    now: Date.now(),
    openDatabase: context.openDatabase,
    output: process.stdout,
    runtime: context.runtime,
    signal: context.signal,
    workDir: context.options.workDir,
  });

  writeEvent({ sha256: digest.sha256, sizeBytes: digest.sizeBytes });

  return EXIT_OK;
}

async function readToken(tokenFile: string): Promise<string> {
  const token = (
    await readFile(tokenFile, "utf8").catch((error: unknown) => {
      throw new UsageError(
        `Could not read --token-file ${tokenFile}: ${errorCode(error)}`,
      );
    })
  ).trim();

  if (token.length < MIN_TOKEN_LENGTH || /\s/u.test(token)) {
    throw new UsageError(
      `--token-file ${tokenFile} must hold one token of at least ${String(MIN_TOKEN_LENGTH)} characters`,
    );
  }

  return token;
}

function bearerDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function writeSidecar(
  tokenFile: string,
  digest: ServerArchiveDigest,
): Promise<string> {
  const sidecarPath = `${tokenFile}.result.json`;

  const tempPath = join(
    dirname(sidecarPath),
    `.${basename(sidecarPath)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({ sha256: digest.sha256, sizeBytes: digest.sizeBytes })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(tempPath, sidecarPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return sidecarPath;
}

function failureStatus(error: unknown): number {
  return error instanceof ApiError ? error.status : 500;
}

function runServeExport(
  context: ExportContext,
  serve: ServeOptions,
  token: string,
): Promise<number> {
  const expectedAuthorization = bearerDigest(`Bearer ${token}`);
  let state: "waiting" | "streaming" | "finished" = "waiting";

  return new Promise<number>((resolveExit) => {
    let settled = false;

    const finish = (code: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      state = "finished";
      clearTimeout(maxWait);
      context.signal.removeEventListener("abort", onAbortWhileWaiting);
      server.close();
      server.closeAllConnections();
      resolveExit(code);
    };

    const onAbortWhileWaiting = (): void => {
      if (state === "waiting") {
        writeEvent({
          event: "stopped",
          message: errorMessage(context.signal.reason),
        });
        finish(EXIT_FAILED);
      }
    };

    const streamExport = async (
      response: http.ServerResponse,
    ): Promise<void> => {
      const disconnected = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) {
          disconnected.abort(new Error("The client disconnected"));
        }
      });
      response.statusCode = 200;
      response.setHeader("cache-control", "no-store");
      response.setHeader(
        "content-disposition",
        `attachment; filename="${exportFileName(new Date())}"`,
      );
      response.setHeader("content-type", "application/gzip");
      writeEvent({ event: "transfer_started" });

      try {
        const digest = await exportDataDirArchive({
          dataDir: context.options.dataDir,
          freeSpace: context.freeSpace,
          logger: exportLogger,
          now: Date.now(),
          openDatabase: context.openDatabase,
          output: response,
          runtime: context.runtime,
          signal: AbortSignal.any([context.signal, disconnected.signal]),
          workDir: context.options.workDir,
        });

        const sidecarPath = await writeSidecar(serve.tokenFile, digest);
        writeEvent({ event: "sidecar", path: sidecarPath });
        writeEvent({ sha256: digest.sha256, sizeBytes: digest.sizeBytes });
        finish(EXIT_OK);
      } catch (error) {
        if (!response.headersSent && !response.destroyed) {
          response.statusCode = failureStatus(error);
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.removeHeader("content-disposition");
          response.end(`${errorMessage(error)}\n`);
        } else {
          response.destroy();
        }

        writeEvent({
          event: "error",
          code: errorCode(error),
          message: errorMessage(error),
        });
        finish(EXIT_FAILED);
      }
    };

    const server = http.createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://export.invalid")
        .pathname;

      if (path !== EXPORT_PATH) {
        response.writeHead(404).end();

        return;
      }

      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();

        return;
      }

      const presented = bearerDigest(request.headers.authorization ?? "");

      if (!timingSafeEqual(presented, expectedAuthorization)) {
        writeEvent({ event: "refused", status: 403 });
        response.writeHead(403).end();

        return;
      }

      if (state !== "waiting") {
        writeEvent({ event: "refused", status: 409 });
        response.writeHead(409).end("The export was already served.\n");

        return;
      }

      state = "streaming";
      clearTimeout(maxWait);
      void streamExport(response);
    });

    const maxWait = setTimeout(() => {
      if (state === "waiting") {
        writeEvent({ event: "timeout", maxWaitSeconds: serve.maxWaitSeconds });
        finish(EXIT_NO_CLIENT);
      }
    }, serve.maxWaitSeconds * 1000);

    context.signal.addEventListener("abort", onAbortWhileWaiting, {
      once: true,
    });

    server.once("error", (error) => {
      writeEvent({
        event: "error",
        code: errorCode(error),
        message: errorMessage(error),
      });
      finish(EXIT_FAILED);
    });
    server.listen(
      { exclusive: true, host: serve.host, port: serve.port },
      () => {
        const address = server.address();

        if (address !== null && typeof address === "object") {
          writeEvent({
            event: "listening",
            address: address.address,
            port: address.port,
          });
        }
      },
    );
  });
}

async function main(argv: string[]): Promise<number> {
  const controller = new AbortController();
  let receivedSignal: ExitSignal | null = null;

  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as ExitSignal[]) {
    process.once(signal, () => {
      receivedSignal = signal;
      controller.abort(new Error(`Received ${signal}`));
    });
  }

  try {
    const cli = parseCli(argv);
    await assertDirectory("data-dir", cli.export.dataDir);
    await assertDirectory("work-dir", cli.export.workDir);
    assertWorkDirOutsideDataDir(cli.export);
    const openDatabase = loadSqliteModule(cli.export.sqliteModule);
    const runtime = await loadRuntime(cli.export.omnyoAppDir);

    const token =
      cli.serve === null ? null : await readToken(cli.serve.tokenFile);

    const context: ExportContext = {
      freeSpace: { marginBytes: cli.export.marginBytes, readFreeBytes },
      openDatabase,
      options: cli.export,
      runtime,
      signal: controller.signal,
    };

    const code =
      cli.serve === null || token === null
        ? await runStdoutExport(context)
        : await runServeExport(context, cli.serve, token);

    return receivedSignal === null ? code : SIGNAL_EXIT_CODES[receivedSignal];
  } catch (error) {
    if (receivedSignal !== null) {
      writeEvent({
        event: "error",
        code: "signal",
        message: `Stopped by ${receivedSignal}: ${errorMessage(error)}`,
      });

      return SIGNAL_EXIT_CODES[receivedSignal];
    }

    if (
      error instanceof UsageError ||
      hasErrorCode(error, "ERR_PARSE_ARGS_UNKNOWN_OPTION")
    ) {
      writeEvent({
        event: "error",
        code: "usage",
        message: errorMessage(error),
      });

      return EXIT_USAGE;
    }

    writeEvent({
      event: "error",
      code: errorCode(error),
      message: errorMessage(error),
    });

    return EXIT_FAILED;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.stderr.write("", () => {
    process.exit(code);
  });
});
