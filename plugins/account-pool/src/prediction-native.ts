import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  experimental_killPortableProcess,
  experimental_spawnPortableProcess,
} from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";

const maxMessageBytes = 8 * 1024 * 1024;

type JsonValue = z.output<z.ZodJSONSchema>;

const nativeMessageSchema = z.object({
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
  error: z
    .object({ code: z.number().int(), message: z.string().optional() })
    .optional(),
});

export interface NativeNotification {
  method: string;
  params: JsonValue;
}

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
}

export const WORKFLOW_POOL_MODEL_PROVIDER = "omnyo-account-pool";

const isolatedEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|SystemRoot|SYSTEMROOT|WINDIR|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/u.test(
        name,
      ),
    ),
  );

export class NativeSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<
    (notification: NativeNotification) => void
  >();
  private readonly exited: Promise<void>;
  private readonly abort: () => void;
  private sequence = 0;
  private buffer = "";
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private didExit = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly signal: AbortSignal,
    private readonly input: Writable,
    output: Readable,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.didExit = true;

        if (this.closing === null)
          this.fail(
            new Error("Native Codex exited before prediction completed"),
          );
        resolve();
      });
    });

    child.once("error", () =>
      this.fail(new Error("Native Codex could not start")),
    );
    input.on("error", () =>
      this.fail(new Error("Native Codex connection closed")),
    );
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.receive(chunk));

    this.abort = () => this.fail(new Error("Prediction canceled"));
    signal.addEventListener("abort", this.abort, { once: true });

    if (signal.aborted) this.abort();
  }

  static open(
    command: string,
    cwd: string,
    signal: AbortSignal,
    route: { baseUrl: string; capability: string },
    codexHome: string,
  ): Promise<NativeSession> {
    const provider = `model_providers.${WORKFLOW_POOL_MODEL_PROVIDER}`;

    return NativeSession.start(
      {
        command,
        args: [
          "app-server",
          "-c",
          "features.plugins=false",
          "-c",
          "features.hooks=false",
          "-c",
          "features.apps=false",
          "-c",
          `model_provider=${JSON.stringify(WORKFLOW_POOL_MODEL_PROVIDER)}`,
          "-c",
          `${provider}.name="OpenAI"`,
          "-c",
          `${provider}.base_url=${JSON.stringify(route.baseUrl)}`,
          "-c",
          `${provider}.wire_api="responses"`,
          "-c",
          `${provider}.requires_openai_auth=false`,
          "-c",
          `${provider}.supports_websockets=false`,
          "-c",
          `${provider}.env_http_headers.x-omnyo-workflow-token="OMNYO_WORKFLOW_CAPABILITY"`,
        ],
        cwd,
        env: {
          ...isolatedEnvironment(),
          CODEX_HOME: codexHome,
          HOME: codexHome,
          USERPROFILE: codexHome,
          OMNYO_WORKFLOW_CAPABILITY: route.capability,
        },
      },
      signal,
      "omnyo_workflow_text",
    );
  }

  private static async start(
    options: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
    signal: AbortSignal,
    clientName: string,
  ): Promise<NativeSession> {
    if (signal.aborted) throw new Error("Prediction canceled");

    const child = experimental_spawnPortableProcess({
      ...options,
      stdio: ["pipe", "pipe", "ignore"],
    });

    if (child.stdin === null || child.stdout === null) {
      experimental_killPortableProcess(child, "SIGKILL");
      throw new Error("Native Codex did not attach its input and output");
    }

    const session = new NativeSession(child, signal, child.stdin, child.stdout);

    try {
      await session.request(
        "initialize",
        {
          clientInfo: { name: clientName, version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
        z.json(),
      );
      session.write({ method: "initialized", params: {} });

      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  request<Schema extends z.ZodType>(
    method: string,
    params: JsonValue,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    if (this.failure !== null) return Promise.reject(this.failure);

    if (this.closing !== null)
      return Promise.reject(new Error("Native Codex session closed"));

    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          const result = schema.safeParse(value);

          if (!result.success) {
            const error = new Error("Native Codex returned an invalid message");
            reject(error);
            this.fail(error);

            return;
          }

          resolve(result.data);
        },
        reject,
      });
      this.write({ id, method, params });
    });
  }

  onNotification(
    listener: (notification: NativeNotification) => void,
  ): () => void {
    if (this.closing === null) this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;

    this.signal.removeEventListener("abort", this.abort);
    this.listeners.clear();
    const error = this.failure ?? new Error("Native Codex session closed");

    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    this.closing = this.stop();

    return this.closing;
  }

  private async stop(): Promise<void> {
    if (this.didExit) return;
    this.input.end();

    const terminate = setTimeout(() => {
      if (!this.didExit)
        experimental_killPortableProcess(this.child, "SIGTERM");
    }, 1000);

    const kill = setTimeout(() => {
      if (!this.didExit)
        experimental_killPortableProcess(this.child, "SIGKILL");
    }, 2000);

    try {
      await this.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
      this.buffer = "";
    }
  }

  private write(message: JsonValue): void {
    if (this.failure !== null || this.closing !== null) return;
    const line = JSON.stringify(message);

    if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
      this.fail(new Error("Native Codex returned an invalid message"));

      return;
    }

    try {
      this.input.write(`${line}\n`);
    } catch {
      this.fail(new Error("Native Codex connection closed"));
    }
  }

  private receive(chunk: string): void {
    if (this.failure !== null || this.closing !== null) return;
    this.buffer += chunk;

    if (Buffer.byteLength(this.buffer, "utf8") > maxMessageBytes) {
      this.fail(new Error("Native Codex returned an invalid message"));

      return;
    }

    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);

      if (line.trim() !== "") this.dispatch(line);

      if (this.failure !== null || this.closing !== null) return;
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: z.output<typeof nativeMessageSchema>;

    try {
      message = nativeMessageSchema.parse(JSON.parse(line));
    } catch {
      this.fail(new Error("Native Codex returned an invalid message"));

      return;
    }

    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this.write({
          id: message.id,
          error: {
            code: -32000,
            message: "Composer predictions cannot approve or execute tools",
          },
        });

        return;
      }

      const notification = {
        method: message.method,
        params: message.params ?? null,
      };

      for (const listener of this.listeners) {
        try {
          listener(notification);
        } catch {
          this.fail(new Error("Native Codex notification handler failed"));

          return;
        }
      }

      return;
    }

    if (message.id === undefined) {
      this.fail(new Error("Native Codex returned an invalid message"));

      return;
    }

    const id = z.number().int().safeParse(message.id);

    if (!id.success) return;
    const pending = this.pending.get(id.data);

    if (pending === undefined) return;
    this.pending.delete(id.data);

    if (message.error !== undefined) {
      pending.reject(
        new Error(`Native Codex request failed (${message.error.code})`),
      );
    } else if (message.result !== undefined) {
      pending.resolve(message.result);
    } else {
      const error = new Error("Native Codex returned an invalid message");
      pending.reject(error);
      this.fail(error);
    }
  }

  private fail(error: Error): void {
    if (this.failure !== null || this.closing !== null) return;
    this.failure = error;
    void this.close();
  }
}
