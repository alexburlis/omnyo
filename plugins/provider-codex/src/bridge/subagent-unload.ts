import { z } from "zod";
import type { CodexAppServerConnection } from "./app-server-connection.js";

export const SUBAGENT_UNLOAD_DELAY_SECS = 0;

export const SUBAGENT_UNLOAD_WAIT_LIMIT_MS = 3000;

const SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS = 10_000;

const loadedThreadsSchema = z
  .object({ data: z.array(z.string()) })
  .passthrough();

const threadReadSchema = z
  .object({
    thread: z
      .object({
        id: z.string(),
        parentThreadId: z.string().nullable().optional(),
        status: z.object({ type: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const unsubscribeSchema = z
  .object({ status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]) })
  .passthrough();

const resumeSchema = z.object({}).passthrough();

const backgroundTerminalsSchema = z
  .object({ data: z.array(z.object({}).passthrough()) })
  .passthrough();

const threadNotificationSchema = z
  .object({ threadId: z.string() })
  .passthrough();

const statusChangedSchema = z
  .object({
    threadId: z.string(),
    status: z.object({ type: z.string() }).passthrough(),
  })
  .passthrough();

type LoadedThread = z.infer<typeof threadReadSchema>["thread"];

export interface SubAgentUnloadHost {
  mainThreadId(): string | null;
  connection(): CodexAppServerConnection | null;
  isSubAgentOpen(threadId: string): boolean;
  warn(message: string): void;
}

interface PendingUnload {
  since: number;
  closed: Promise<void>;
  resolve(): void;
}

export class SubAgentUnloader {
  private sweeping: Promise<void> | null = null;
  private sweepAgain = false;
  private subAgentsSeen = false;
  private holds = 0;
  private mainTurnEpoch = 0;
  private readonly pending = new Map<string, PendingUnload>();

  constructor(private readonly host: SubAgentUnloadHost) {}

  observe(method: string, params: unknown): void {
    const thread = threadNotificationSchema.safeParse(params);
    const mainThreadId = this.host.mainThreadId();
    const threadId = thread.success ? thread.data.threadId : null;

    if (method === "thread/closed") {
      if (threadId !== null) this.settle(threadId);

      return;
    }

    if (threadId !== null && mainThreadId !== null && threadId !== mainThreadId)
      this.subAgentsSeen = true;

    if (method === "turn/started" && threadId === mainThreadId)
      this.mainTurnEpoch += 1;

    const status = statusChangedSchema.safeParse(params);

    const working =
      method === "turn/started" ||
      (method === "thread/status/changed" &&
        status.success &&
        status.data.status.type === "active");

    if (threadId !== null && working && this.pending.has(threadId)) {
      this.resubscribe(threadId);

      return;
    }

    if (!this.subAgentsSeen) return;

    if (
      method === "turn/completed" ||
      (method === "thread/status/changed" &&
        status.success &&
        status.data.status.type !== "active")
    )
      this.sweep();
  }

  hold(): () => void {
    this.holds += 1;

    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
    };
  }

  async settled(): Promise<void> {
    const deadline = Date.now() + SUBAGENT_UNLOAD_WAIT_LIMIT_MS;

    while (Date.now() < deadline) {
      if (this.sweeping !== null) {
        await Promise.race([this.sweeping, delay(deadline - Date.now())]);
        continue;
      }

      if (this.pending.size === 0) return;

      await Promise.race([
        Promise.all([...this.pending.values()].map((entry) => entry.closed)),
        delay(deadline - Date.now()),
      ]);
    }

    for (const threadId of this.pending.keys()) this.settle(threadId);
  }

  private sweep(): void {
    if (this.sweeping !== null) {
      this.sweepAgain = true;

      return;
    }

    this.sweeping = this.unloadFinishedSubAgents()
      .catch((error: unknown) => {
        this.host.warn(
          `codex could not unload finished sub-agents: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.sweeping = null;

        if (this.sweepAgain) {
          this.sweepAgain = false;
          this.sweep();
        }
      });
  }

  private async unloadFinishedSubAgents(): Promise<void> {
    const connection = this.host.connection();
    const mainThreadId = this.host.mainThreadId();
    const epoch = this.mainTurnEpoch;

    if (connection === null || connection.exited || mainThreadId === null)
      return;

    const loaded = await connection.request({
      method: "thread/loaded/list",
      params: {},
      resultSchema: loadedThreadsSchema,
      timeoutMs: SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS,
    });

    if (!loaded.data.includes(mainThreadId)) return;

    const threads = await Promise.all(
      loaded.data
        .filter((threadId) => !this.pending.has(threadId))
        .map((threadId) => this.read(connection, threadId)),
    );

    const main = threads.find((thread) => thread.id === mainThreadId);

    if (main === undefined || main.status.type === "active") return;

    const subAgents = threads.filter(
      (thread) =>
        thread.id !== mainThreadId && typeof thread.parentThreadId === "string",
    );

    if (subAgents.length === 0 && this.pending.size === 0) {
      this.subAgentsSeen = false;

      return;
    }

    if (subAgents.some((thread) => thread.status.type === "active")) return;

    const running = new Set<string>();

    for (const subAgent of subAgents)
      if (await this.hasBackgroundTerminal(connection, subAgent.id))
        running.add(subAgent.id);

    const keep = keptForUnfinishedWork(
      subAgents,
      mainThreadId,
      (threadId) => running.has(threadId) || this.host.isSubAgentOpen(threadId),
    );

    for (const subAgent of subAgents) {
      if (keep.has(subAgent.id)) continue;

      if (this.holds > 0 || this.mainTurnEpoch !== epoch) return;

      const result = await connection.request({
        method: "thread/unsubscribe",
        params: { threadId: subAgent.id },
        resultSchema: unsubscribeSchema,
        timeoutMs: SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS,
      });

      if (result.status === "unsubscribed") this.track(subAgent.id);
    }
  }

  private async hasBackgroundTerminal(
    connection: CodexAppServerConnection,
    threadId: string,
  ): Promise<boolean> {
    const result = await connection.request({
      method: "thread/backgroundTerminals/list",
      params: { threadId, limit: 1 },
      resultSchema: backgroundTerminalsSchema,
      timeoutMs: SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS,
    });

    return result.data.length > 0;
  }

  private async read(
    connection: CodexAppServerConnection,
    threadId: string,
  ): Promise<LoadedThread> {
    const result = await connection.request({
      method: "thread/read",
      params: { threadId, includeTurns: false },
      resultSchema: threadReadSchema,
      timeoutMs: SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS,
    });

    return result.thread;
  }

  private resubscribe(threadId: string): void {
    this.settle(threadId);

    const connection = this.host.connection();

    if (connection === null || connection.exited) return;

    connection
      .request({
        method: "thread/resume",
        params: { threadId, excludeTurns: true },
        resultSchema: resumeSchema,
        timeoutMs: SUBAGENT_UNLOAD_REQUEST_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        this.host.warn(
          `codex could not reattach re-engaged sub-agent ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private track(threadId: string): void {
    let resolve = () => {};

    const closed = new Promise<void>((done) => {
      resolve = done;
    });

    this.pending.set(threadId, { since: Date.now(), closed, resolve });
  }

  private settle(threadId: string): void {
    const entry = this.pending.get(threadId);

    if (entry === undefined) return;
    this.pending.delete(threadId);
    entry.resolve();
  }
}

function keptForUnfinishedWork(
  subAgents: LoadedThread[],
  mainThreadId: string,
  hasWork: (threadId: string) => boolean,
): Set<string> {
  const parents = new Map(
    subAgents.map((thread) => [thread.id, thread.parentThreadId ?? null]),
  );

  const keep = new Set<string>();

  for (const subAgent of subAgents) {
    if (!hasWork(subAgent.id)) continue;

    for (
      let threadId: string | null = subAgent.id;
      threadId !== null && threadId !== mainThreadId && !keep.has(threadId);
      threadId = parents.get(threadId) ?? null
    )
      keep.add(threadId);
  }

  return keep;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
