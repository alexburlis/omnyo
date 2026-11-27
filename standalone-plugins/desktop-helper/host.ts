import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@omnyo/plugin-sdk";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { verifyNativeSignature } from "./native-signature";
import {
  hostContract,
  nativeCommandSchema,
  nativeEventSchema,
  nativeProtocol,
  nativeResultSchema,
  type NativeEvent,
} from "./contracts";

const execute = promisify(execFile);

/**
 * Signing settings for the locally built helper. Set these in the plugin host's
 * environment on the Mac that runs the probe; see the plugin skill for details.
 */
function nativeConfig() {
  const artifactDirectory = process.env.OMNYO_DESKTOP_HELPER_ARTIFACTS;
  const teamId = process.env.OMNYO_DESKTOP_HELPER_TEAM_ID;

  if (!artifactDirectory || !teamId)
    throw new Error(
      "Set OMNYO_DESKTOP_HELPER_ARTIFACTS and OMNYO_DESKTOP_HELPER_TEAM_ID for the native probe.",
    );

  return {
    artifactDirectory,
    bundleId: process.env.OMNYO_DESKTOP_HELPER_BUNDLE_ID ?? "dev.omnyo.desktop-helper",
    teamId,
  };
}

const manifestSchema = z.object({
  schema: z.literal(1),
  protocol: z.literal(nativeProtocol),
  bundleId: z.string(),
  teamId: z.string(),
  architecture: z.literal("arm64"),
  build: z.union([z.string(), z.number()]),
  app: z.string(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .max(512),
});

async function verifiedApp(
  fixture: boolean,
  config: ReturnType<typeof nativeConfig>,
): Promise<string> {
  const { artifactDirectory, teamId } = config;
  const appName = fixture ? "Omnyo Desktop Helper Fixture.app" : "Omnyo Desktop Helper.app";
  const bundleId = fixture ? `${config.bundleId}.fixture` : config.bundleId;
  const app = join(artifactDirectory, appName);

  if ((await realpath(app)) !== app)
    throw new Error("Native app must use the exact task artifact path.");

  const manifestPath = join(
    artifactDirectory,
    fixture ? "fixture-manifest.json" : "native-manifest.json",
  );

  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));

  if (manifest.teamId !== teamId) throw new Error("Native manifest team mismatch.");

  if (manifest.bundleId !== bundleId || manifest.app !== appName)
    throw new Error("Native manifest identity mismatch.");
  const found = new Set<string>();

  async function inspect(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);

      if (item.isSymbolicLink()) throw new Error("Native artifact contains a symbolic link.");

      if (item.isDirectory()) await inspect(path);
      else if (item.isFile()) found.add(relative(app, path));
      else throw new Error("Native artifact contains an unsupported file.");
    }
  }

  await inspect(app);

  if (found.size !== manifest.files.length)
    throw new Error("Native manifest file coverage mismatch.");
  let totalBytes = 0;

  for (const file of manifest.files) {
    const path = resolve(app, file.path);

    if (!found.delete(file.path) || !path.startsWith(`${app}/`))
      throw new Error("Native manifest path mismatch.");
    const stat = await lstat(path);
    totalBytes += stat.size;

    if (stat.size !== file.bytes || totalBytes > 32 * 1024 * 1024)
      throw new Error("Native artifact size mismatch.");

    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");

    if (digest !== file.sha256) throw new Error("Native artifact hash mismatch.");
  }

  const plist = await execute(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", join(app, "Contents/Info.plist")],
    { timeout: 2_000 },
  );

  const executableName = plist.stdout.trim();

  if (basename(executableName) !== executableName)
    throw new Error("Native executable name is invalid.");
  const executable = join(app, "Contents/MacOS", executableName);

  const executableHash = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");

  if (executableHash !== manifest.executableSha256)
    throw new Error("Native executable hash mismatch.");
  await verifyNativeSignature(app, bundleId, teamId);
  const architecture = await execute("/usr/bin/lipo", ["-archs", executable], { timeout: 2_000 });

  if (architecture.stdout.trim() !== manifest.architecture)
    throw new Error("Native architecture mismatch.");

  return executable;
}

class NativeChild {
  readonly events: NativeEvent[] = [];
  readonly process: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private ended = false;
  private failure: Error | null = null;
  private pending: {
    match: (event: NativeEvent) => boolean;
    resolve: (event: NativeEvent) => void;
    reject: (error: Error) => void;
  } | null = null;
  private buffer = "";
  private totalBytes = 0;

  constructor(executable: string, argv: string[], signal: AbortSignal) {
    this.process = spawn(executable, argv, { stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise((resolveClosed) => {
      this.process.once("close", () => {
        this.ended = true;
        this.fail(new Error("Native child closed before the requested response."));
        resolveClosed();
      });
    });
    this.process.once("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.stderr.on("data", () => undefined);
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.totalBytes += Buffer.byteLength(chunk);
      this.buffer += chunk;

      if (this.totalBytes > 128 * 1024 || this.buffer.length > 8192) {
        this.fail(new Error("Native response exceeded its bound."));
        this.process.kill("SIGTERM");

        return;
      }

      let newline = this.buffer.indexOf("\n");

      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);

        try {
          const event = nativeEventSchema.parse(JSON.parse(line));

          if (this.events.length >= 32) throw new Error("Native response event limit exceeded.");
          this.events.push(event);

          if (this.pending?.match(event)) {
            const waiting = this.pending;
            this.pending = null;
            waiting.resolve(event);
          }
        } catch {
          this.fail(new Error("Native response validation failed."));
          this.process.kill("SIGTERM");
        }

        newline = this.buffer.indexOf("\n");
      }
    });

    const cancel = () => {
      this.fail(new Error("Native probe cancelled or exceeded its deadline."));
      this.process.stdin.end();
      this.process.kill("SIGTERM");
    };

    signal.addEventListener("abort", cancel, { once: true });
    void this.closed.then(() => signal.removeEventListener("abort", cancel));

    if (signal.aborted) cancel();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.reject(error);
    this.pending = null;
  }

  wait(match: (event: NativeEvent) => boolean): Promise<NativeEvent> {
    const existing = this.events.find(match);

    if (existing) return Promise.resolve(existing);

    if (this.failure) return Promise.reject(this.failure);

    return new Promise((resolveWaiting, reject) => {
      this.pending = { match, resolve: resolveWaiting, reject };
    });
  }

  request(
    input: z.infer<typeof nativeCommandSchema>,
    fixture?: { pid: number; windowId: number; x: number; y: number },
  ): Promise<NativeEvent> {
    const id = randomUUID();
    const response = this.wait((event) => event.id === id);
    this.process.stdin.write(
      `${JSON.stringify({ protocol: nativeProtocol, id, ...input, fixture })}\n`,
    );

    return response;
  }

  async stop(): Promise<void> {
    this.process.stdin.end();
    const terminate = setTimeout(() => this.process.kill("SIGTERM"), 750);
    const kill = setTimeout(() => this.process.kill("SIGKILL"), 1_500);

    try {
      await this.closed;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }

  get exited(): boolean {
    return this.ended;
  }
}

type RunOwner = {
  cancellation: AbortController;
  helper: NativeChild | null;
  fixture: NativeChild | null;
  stopped: Promise<void>;
};

let active: RunOwner | null = null;

function result(
  input: z.infer<typeof nativeCommandSchema>,
  owner: RunOwner | null,
): z.infer<typeof nativeResultSchema> {
  return {
    workerPid: process.pid,
    uid: process.getuid?.() ?? -1,
    operation: input,
    events: [...(owner?.fixture?.events ?? []), ...(owner?.helper?.events ?? [])],
    helperPid: owner?.helper?.process.pid ?? null,
    fixturePid: owner?.fixture?.process.pid ?? null,
    helperExited: owner?.helper?.exited ?? true,
    fixtureExited: owner?.fixture?.exited ?? true,
  };
}

async function runNative(
  input: z.infer<typeof nativeCommandSchema>,
  context: ExperimentalHostRpcContext,
): Promise<z.infer<typeof nativeResultSchema>> {
  if (input.command === "shutdown") {
    const closing = active;
    closing?.cancellation.abort();
    await closing?.stopped;

    return result(input, closing);
  }

  if (active) throw new Error("A bounded native proof already owns this worker.");

  if (process.platform !== "darwin" || process.getuid?.() !== 501)
    throw new Error("Native probe requires the selected Mac console user.");
  const cancellation = new AbortController();
  let stoppedResolve: (() => void) | undefined;

  const owner: RunOwner = {
    cancellation,
    helper: null,
    fixture: null,
    stopped: new Promise((resolveStopped) => {
      stoppedResolve = resolveStopped;
    }),
  };

  active = owner;

  const signal = AbortSignal.any([
    context.signal,
    context.lifecycle.signal,
    cancellation.signal,
    AbortSignal.timeout(45_000),
  ]);

  try {
    const config = nativeConfig();
    const executable = await verifiedApp(false, config);
    signal.throwIfAborted();
    const output = join(config.artifactDirectory, "probe-output");
    await mkdir(output, { recursive: true, mode: 0o700 });

    if ((await realpath(output)) !== output || dirname(output) !== config.artifactDirectory)
      throw new Error("Native proof output path mismatch.");
    let target: { pid: number; windowId: number; x: number; y: number } | undefined;

    if (input.command === "probe") {
      owner.fixture = new NativeChild(await verifiedApp(true, config), [], signal);
      const event = await owner.fixture.wait((message) => message.event === "fixture");
      target = z
        .object({
          pid: z.number().int().positive(),
          windowId: z.number().int().positive(),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .parse(event);

      if (target.pid !== owner.fixture.process.pid)
        throw new Error("Native fixture process identity mismatch.");
    }

    owner.helper = new NativeChild(executable, ["--probe-output", output], signal);
    await owner.helper.wait((event) => event.event === "status");
    await owner.helper.request(input, target);
  } finally {
    await Promise.all([owner.helper?.stop(), owner.fixture?.stop()]);

    if (active === owner) active = null;
    stoppedResolve?.();
  }

  return result(input, owner);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { native: runNative },
  dispose: async () => {
    const closing = active;
    closing?.cancellation.abort();
    await closing?.stopped;
  },
});
