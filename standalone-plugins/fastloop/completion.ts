import { randomUUID } from "node:crypto";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";

const inputSchema = z.strictObject({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  threadId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  summary: z
    .string()
    .min(1)
    .max(3500)
    .refine((value) => Buffer.byteLength(value) <= 3500),
});

export const completionRecordSchema = inputSchema.extend({
  receiptId: z.string().uuid(),
  checkpoint: z.number().int().nonnegative().nullable(),
  state: z.enum(["queued", "sending", "uncertain", "delivered", "suppressed"]),
});

export type CompletionInput = z.infer<typeof inputSchema>;

export type CompletionRecord = z.infer<typeof completionRecordSchema>;

export type ReceiptEvent = { sequence: number; requestId: string } & (
  | { kind: "requested"; texts: string[] }
  | { kind: "accepted" | "rejected" }
);

export interface CompletionPort {
  suppress(runId: string): Promise<void>;
  isSuppressed(runId: string): Promise<boolean>;
  load(runId: string): Promise<CompletionRecord | undefined>;
  save(entry: CompletionRecord): Promise<void>;
  entries(): Promise<CompletionRecord[]>;
  thread(
    threadId: string,
    signal: AbortSignal,
  ): Promise<{ id: string; projectId: string | null; archived: boolean }>;
  checkpoint(threadId: string, signal: AbortSignal): Promise<number>;
  queued(threadId: string, signal: AbortSignal): Promise<string[]>;
  events(threadId: string, after: number, signal: AbortSignal): Promise<ReceiptEvent[]>;
  send(threadId: string, text: string): Promise<boolean>;
}

const prefix = "fastloop.completion.v1.";

const suppressionPrefix = "fastloop.completion.stop.v1.";

export function createCompletionPort(api: PluginApi): CompletionPort {
  const load = async (runId: string) => {
    const value = await api.storage.kv.get<unknown>(prefix + runId);

    return value === undefined ? undefined : completionRecordSchema.parse(value);
  };

  return {
    suppress: (runId) => api.storage.kv.set(suppressionPrefix + runId, { runId, stopped: true }),
    async isSuppressed(runId) {
      const value = await api.storage.kv.get<unknown>(suppressionPrefix + runId);

      if (value === undefined) return false;
      const entry = z.strictObject({ runId: z.string(), stopped: z.literal(true) }).parse(value);

      if (entry.runId !== runId) throw new Error("COMPLETION_CONTEXT_CONFLICT");

      return true;
    },
    load,
    save: (entry) => api.storage.kv.set(prefix + entry.runId, entry),
    async entries() {
      const entries: CompletionRecord[] = [];

      for (const key of await api.storage.kv.list(prefix)) {
        const entry = await load(key.slice(prefix.length));

        if (entry) entries.push(entry);
      }

      return entries;
    },
    async thread(threadId, signal) {
      const thread = await api.sdk.threads.get({ threadId, signal });

      return { id: thread.id, projectId: thread.projectId, archived: thread.archivedAt !== null };
    },
    async checkpoint(threadId, signal) {
      const events = await api.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        signal,
      });

      return events[0]?.seq ?? 0;
    },
    async queued(threadId, signal) {
      const messages = await api.sdk.threads.queuedMessages.list({ threadId, signal });

      return messages
        .filter((item) => item.threadId === threadId)
        .flatMap((item) =>
          item.content.filter((part) => part.type === "text").map((part) => part.text),
        );
    },
    async events(threadId, after, signal) {
      const events = await api.sdk.threads.events.list({
        threadId,
        afterSeq: String(after),
        order: "asc",
        limit: "100",
        types: ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"],
        signal,
      });

      return events.map((event): ReceiptEvent => {
        if (event.threadId !== threadId) throw new Error("COMPLETION_THREAD_MISMATCH");

        if (event.type === "client/turn/requested")
          return {
            sequence: event.seq,
            kind: "requested",
            requestId: event.data.requestId,
            texts: event.data.input.filter((part) => part.type === "text").map((part) => part.text),
          };

        if (event.type === "turn/input/accepted")
          return { sequence: event.seq, kind: "accepted", requestId: event.data.clientRequestId };

        if (event.type === "client/turn/rejected")
          return { sequence: event.seq, kind: "rejected", requestId: event.data.requestId };
        throw new Error("COMPLETION_EVENT_UNSUPPORTED");
      });
    },
    async send(threadId, text) {
      const result = await api.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });

      return result.ok;
    },
  };
}

function marker(entry: CompletionRecord): string {
  return `FastLoop receipt: ${entry.receiptId}.`;
}

export class CompletionOutbox {
  private tail = Promise.resolve();
  private readonly abort = new AbortController();
  private draining?: Promise<void>;
  private readonly suppressed = new Set<string>();

  constructor(private readonly port: CompletionPort) {}

  private exclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  enqueue(input: CompletionInput): Promise<void> {
    const value = inputSchema.parse(input);

    if (this.abort.signal.aborted) return Promise.reject(new Error("COMPLETION_CLOSED"));

    return this.exclusive(async () => {
      if (this.abort.signal.aborted) throw new Error("COMPLETION_CLOSED");
      const prior = await this.port.load(value.runId);

      if (prior) {
        if (
          prior.threadId !== value.threadId ||
          prior.projectId !== value.projectId ||
          prior.summary !== value.summary
        )
          throw new Error("COMPLETION_CONTEXT_CONFLICT");

        return;
      }

      const entry: CompletionRecord = {
        ...value,
        receiptId: randomUUID(),
        checkpoint: null,
        state: (await this.isSuppressed(value.runId)) ? "suppressed" : "queued",
      };

      await this.port.save(entry);

      if (await this.isSuppressed(value.runId))
        await this.port.save({ ...entry, state: "suppressed" });
    });
  }

  drain(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();

    if (this.draining) return this.draining;

    const task = this.exclusive(async () => {
      for (const entry of await this.port.entries()) {
        if (this.abort.signal.aborted) return;

        if (entry.state === "delivered" || entry.state === "suppressed") continue;
        await this.deliver(entry);
      }
    });

    this.draining = task;
    void task.then(
      () => {
        if (this.draining === task) this.draining = undefined;
      },
      () => {
        if (this.draining === task) this.draining = undefined;
      },
    );

    return task;
  }

  private async bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let rejectWait: (() => void) | undefined;

    const interrupted = new Promise<never>((_, reject) => {
      rejectWait = () => reject(new Error("COMPLETION_WAIT_INTERRUPTED"));
      signal.addEventListener("abort", rejectWait, { once: true });
    });

    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      if (rejectWait) signal.removeEventListener("abort", rejectWait);
    }
  }

  private async reconcile(entry: CompletionRecord, signal: AbortSignal): Promise<boolean> {
    const receipt = marker(entry);
    const queued = await this.bounded(this.port.queued(entry.threadId, signal), signal);

    if (queued.some((text) => text.endsWith(receipt))) return true;

    if (entry.checkpoint === null) return false;
    let after = entry.checkpoint;
    const requested = new Set<string>();
    const accepted = new Set<string>();

    for (let page = 0; page < 10; page++) {
      const events = await this.bounded(this.port.events(entry.threadId, after, signal), signal);

      for (const event of events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= after)
          throw new Error("COMPLETION_CURSOR_INVALID");
        after = event.sequence;

        if (event.kind === "requested" && event.texts.some((text) => text.endsWith(receipt)))
          requested.add(event.requestId);

        if (event.kind === "accepted") accepted.add(event.requestId);
      }

      if ([...requested].some((id) => accepted.has(id))) return true;

      if (events.length < 100) return false;
    }

    return false;
  }

  private async deliver(entry: CompletionRecord): Promise<void> {
    if (await this.isSuppressed(entry.runId)) return;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]);
    const context = await this.bounded(this.port.thread(entry.threadId, signal), signal);

    if (
      context.id !== entry.threadId ||
      context.archived ||
      context.projectId !== entry.projectId
    ) {
      await this.port.save({ ...entry, state: "suppressed" });

      return;
    }

    if (entry.state !== "queued") {
      const delivered = await this.reconcile(entry, signal);
      await this.port.save({ ...entry, state: delivered ? "delivered" : "uncertain" });

      return;
    }

    const checkpoint = await this.bounded(this.port.checkpoint(entry.threadId, signal), signal);
    const sending: CompletionRecord = { ...entry, checkpoint, state: "sending" };
    await this.port.save(sending);

    if (signal.aborted) return;

    const current = await this.port.load(entry.runId);

    if (await this.isSuppressed(entry.runId)) {
      await this.port.save({ ...sending, state: "suppressed" });

      return;
    }

    if (current?.state !== "sending" || current.receiptId !== entry.receiptId) return;

    try {
      const confirmed = await this.bounded(
        this.port.send(
          entry.threadId,
          `[FastLoop completion] ${entry.summary}\nRun: ${entry.runId}. ${marker(entry)}`,
        ),
        signal,
      );

      await this.port.save({ ...sending, state: confirmed ? "delivered" : "uncertain" });

      if (await this.isSuppressed(entry.runId))
        await this.port.save({ ...sending, state: "uncertain" });
    } catch {
      await this.port.save({ ...sending, state: "uncertain" });
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.tail;
  }

  status(runId: string): Promise<CompletionRecord | undefined> {
    return this.port.load(inputSchema.shape.runId.parse(runId));
  }

  async suppress(runId: string): Promise<void> {
    const id = inputSchema.shape.runId.parse(runId);
    this.suppressed.add(id);
    await this.port.suppress(id);
    const entry = await this.port.load(id);

    if (!entry || entry.state === "delivered" || entry.state === "suppressed") return;
    await this.port.save({
      ...entry,
      state: entry.state === "queued" ? "suppressed" : "uncertain",
    });
  }

  private async isSuppressed(runId: string): Promise<boolean> {
    if (this.suppressed.has(runId)) return true;

    return (await this.port.isSuppressed(runId)) || this.suppressed.has(runId);
  }
}
