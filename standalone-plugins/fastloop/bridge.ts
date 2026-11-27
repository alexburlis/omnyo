import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { childBridgeSource } from "./child-bridge.js";
import { type JsonPayload } from "./contracts.js";
import { PayloadError } from "./package-payload.js";

const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.string(), ok: z.literal(true), result: z.json() }),
  z.strictObject({
    id: z.string(),
    ok: z.literal(false),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
  }),
]);

const readySchema = z.discriminatedUnion("ready", [
  z.strictObject({ ready: z.literal(true), node: z.string().regex(/^24\./) }),
  z.strictObject({ ready: z.literal(false), code: z.string() }),
]);

export type BridgeMethod = "submit" | "submission" | "result" | "events" | "artifact" | "cancel";

type Pending = {
  resolve(value: JsonPayload): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class SdkBridge {
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private stopped = false;
  private closePromise?: Promise<void>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  static async connect(options: {
    nodeExecutable: string;
    sdkPath: string;
    projectRoot: string;
    clientId: string;
    dataRoot?: string;
    archive?: boolean;
    onExit(): void;
  }): Promise<SdkBridge> {
    const child = spawn(
      options.nodeExecutable,
      [
        "--input-type=module",
        "-e",
        childBridgeSource,
        options.sdkPath,
        options.projectRoot,
        options.clientId,
        options.dataRoot ?? "",
        options.archive ? "archive" : "live",
      ],
      {
        cwd: options.archive ? options.dataRoot : options.projectRoot,
        env: {
          HOME: homedir(),
          PATH: `${dirname(options.nodeExecutable)}:/usr/bin:/bin`,
          TMPDIR: process.env.TMPDIR,
          USER: process.env.USER,
          LANG: "en_US.UTF-8",
          OPENAI_API_KEY: options.archive ? undefined : process.env.OPENAI_API_KEY,
          OPENAI_PLANNER_MODEL: options.archive ? undefined : process.env.OPENAI_PLANNER_MODEL,
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      },
    );

    const bridge = new SdkBridge(child);
    let initialized = false;
    const ready = Promise.withResolvers<void>();

    const timer = setTimeout(() => {
      ready.reject(new PayloadError("RUNTIME_BRIDGE_STARTUP_TIMEOUT"));
      child.kill("SIGTERM");
    }, 10000);

    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bridge.buffer += chunk;

      if (Buffer.byteLength(bridge.buffer) > 16 * 1024 * 1024) {
        bridge.fail("RUNTIME_BRIDGE_OUTPUT_EXCEEDED");
        child.kill("SIGTERM");

        return;
      }

      let index;

      while ((index = bridge.buffer.indexOf("\n")) >= 0) {
        const line = bridge.buffer.slice(0, index);
        bridge.buffer = bridge.buffer.slice(index + 1);

        try {
          const value: unknown = JSON.parse(line);

          if (!initialized) {
            const parsed = readySchema.parse(value);

            if (!parsed.ready) throw new PayloadError(parsed.code);
            initialized = true;
            clearTimeout(timer);
            ready.resolve();
          } else bridge.receive(responseSchema.parse(value));
        } catch (error) {
          clearTimeout(timer);
          ready.reject(
            error instanceof PayloadError
              ? error
              : new PayloadError("RUNTIME_BRIDGE_PROTOCOL_INVALID"),
          );
          bridge.fail("RUNTIME_BRIDGE_PROTOCOL_INVALID");
          child.kill("SIGTERM");
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      ready.reject(new PayloadError("RUNTIME_BRIDGE_PROCESS_FAILED"));
      bridge.fail("RUNTIME_BRIDGE_PROCESS_FAILED");
    });
    child.on("exit", () => {
      clearTimeout(timer);
      ready.reject(new PayloadError("RUNTIME_BRIDGE_EXITED"));
      bridge.fail("RUNTIME_BRIDGE_EXITED");
      options.onExit();
    });
    await ready.promise;

    return bridge;
  }
  private receive(response: z.infer<typeof responseSchema>): void {
    const pending = this.pending.get(response.id);

    if (!pending) throw new PayloadError("RUNTIME_BRIDGE_RESPONSE_UNKNOWN");
    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) pending.resolve(response.result);
    else pending.reject(new PayloadError(response.code));
  }
  private fail(code: string): void {
    this.stopped = true;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PayloadError(code));
    }

    this.pending.clear();
  }
  private send(method: BridgeMethod | "close", payload: JsonPayload): Promise<JsonPayload> {
    if (this.stopped) return Promise.reject(new PayloadError("RUNTIME_CLIENT_CLOSED"));

    if (this.pending.size >= 64) return Promise.reject(new PayloadError("RUNTIME_BRIDGE_BUSY"));
    const id = randomUUID();
    const line = JSON.stringify({ id, method, payload }) + "\n";

    if (Buffer.byteLength(line) > 1048576)
      return Promise.reject(new PayloadError("RUNTIME_BRIDGE_INPUT_EXCEEDED"));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PayloadError("RUNTIME_BRIDGE_REQUEST_TIMEOUT"));
      }, 12500);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, (error) => {
        if (error) this.fail("RUNTIME_BRIDGE_WRITE_FAILED");
      });
    });
  }
  request(method: BridgeMethod, payload: JsonPayload): Promise<JsonPayload> {
    return this.send(method, payload);
  }
  close(): Promise<void> {
    this.closePromise ??= this.send("close", {}).then(() => {
      this.stopped = true;
      this.child.stdin.end();
    });

    return this.closePromise;
  }
}
