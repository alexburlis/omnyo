import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { DbConnection } from "@omnyo/db";
import { ApiError } from "../../errors.js";

export const historyCacheRecordSchema = z.object({
  key: z.string(),
  threadId: z.string(),
  sourceIdentity: z.string(),
  rewriteEpoch: z.string(),
  kind: z.enum(["outline", "root", "page"]),
  body: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  sequence: z.number().int().nonnegative(),
});

export const historyCacheWriteSchema = z.object({
  threadId: z.string(),
  historyEpoch: z.string(),
  rewriteEpoch: z.string(),
  records: z.array(historyCacheRecordSchema).max(1024),
});

export type HistoryCacheWrite = z.infer<typeof historyCacheWriteSchema>;

export const historyCacheCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("put"),
    write: historyCacheWriteSchema,
  }),
  z.object({
    id: z.string(),
    kind: z.literal("purge"),
    threadIds: z.array(z.string()).max(1024),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("touch"),
    keys: z.array(z.string()).max(1024),
  }),
]);

export const historyCacheAdmissionSchema = z.enum([
  "stored",
  "unchanged",
  "stale",
  "expired",
  "capacity",
]);

export type HistoryCacheAdmission = z.infer<typeof historyCacheAdmissionSchema>;

const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("cache-result"),
    id: z.string(),
    ok: z.boolean(),
    admissions: z.array(historyCacheAdmissionSchema),
  }),
]);

interface CacheWriter {
  ready: Promise<void>;
  put(write: HistoryCacheWrite): Promise<HistoryCacheAdmission[]>;
  purge(threadId: string): Promise<void>;
  touch(keys: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

const writers = new WeakMap<DbConnection, CacheWriter>();

export function startTimelineWorker(
  databasePath: string,
  mode: "read" | "write",
): Worker {
  const workerData = { databasePath, mode };

  if (!import.meta.url.endsWith(".ts"))
    return new Worker(new URL("./timeline-worker.js", import.meta.url), {
      workerData,
      execArgv: [],
      env: {},
    });

  const api = import.meta.resolve("tsx/esm/api");
  const entry = new URL("./timeline-worker.ts", import.meta.url).href;
  const bootstrap = `const{parentPort}=require('node:worker_threads');(async()=>{const{register}=await import(${JSON.stringify(api)});register();await import(${JSON.stringify(entry)});})().catch(()=>{parentPort.postMessage({type:'boot-error'});});`;

  return new Worker(bootstrap, {
    eval: true,
    workerData,
    execArgv: ["--conditions=source"],
    env: {},
  });
}

function unavailable() {
  return new ApiError(
    503,
    "history_cache_unavailable",
    "Chat history cache is unavailable. Try again.",
    true,
  );
}

function createWriter(db: DbConnection): CacheWriter {
  type Command =
    | { kind: "put"; write: HistoryCacheWrite }
    | { kind: "purge"; threadIds: string[] }
    | { kind: "touch"; keys: string[] };

  interface Subscriber {
    resolve: (admissions: HistoryCacheAdmission[]) => void;
    reject: (error: Error) => void;
  }

  interface Job {
    id: string;
    command: Command;
    subscribers: Subscriber[];
    bytes: number;
  }

  const worker = startTimelineWorker(db.$client.name, "write");
  const queue: Job[] = [];
  let active: Job | null = null;
  let queuedBytes = 0;
  let closed = false;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function settle(
    job: Job,
    error?: Error,
    admissions: HistoryCacheAdmission[] = [],
  ) {
    for (const subscriber of job.subscribers) {
      if (error === undefined) subscriber.resolve(admissions);
      else subscriber.reject(error);
    }
  }

  function fail() {
    if (closed) return;
    closed = true;
    writers.delete(db);
    readyReject(unavailable());

    if (active !== null) settle(active, unavailable());
    active = null;

    for (const job of queue.splice(0)) settle(job, unavailable());
    queuedBytes = 0;
    void worker.terminate();
  }

  function drain() {
    if (closed || active !== null) return;
    const job = queue.shift();

    if (job === undefined) {
      worker.unref();

      return;
    }

    queuedBytes -= job.bytes;
    active = job;
    worker.ref();
    worker.postMessage({ id: job.id, ...job.command });
  }

  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on("message", (message: unknown) => {
    const parsed = replySchema.safeParse(message);

    if (!parsed.success) return fail();

    if (parsed.data.type === "ready") {
      readyResolve();
      drain();

      return;
    }

    const job = active;

    if (job === null || job.id !== parsed.data.id) return fail();
    active = null;
    settle(
      job,
      parsed.data.ok ? undefined : unavailable(),
      parsed.data.admissions,
    );
    drain();
  });

  async function request(command: Command) {
    await ready;

    if (closed) throw unavailable();

    if (command.kind === "purge") {
      const ids = new Set(command.threadIds);

      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const job = queue[index]!;

        if (job.command.kind === "put" && ids.has(job.command.write.threadId)) {
          queue.splice(index, 1);
          queuedBytes -= job.bytes;
          settle(job);
        }
      }
    }

    let job =
      command.kind === "touch"
        ? queue.find(
            (candidate) =>
              candidate.command.kind === "touch" &&
              new Set([...candidate.command.keys, ...command.keys]).size <=
                1024,
          )
        : command.kind === "purge"
          ? queue.find(
              (candidate) =>
                candidate.command.kind === "purge" &&
                candidate.command.threadIds.length + command.threadIds.length <=
                  1024,
            )
          : queue.find(
              (candidate) =>
                candidate.command.kind === "put" &&
                candidate.command.write.threadId === command.write.threadId &&
                candidate.command.write.historyEpoch ===
                  command.write.historyEpoch &&
                candidate.command.write.rewriteEpoch ===
                  command.write.rewriteEpoch,
            );

    if (
      job !== undefined &&
      job.command.kind === "touch" &&
      command.kind === "touch"
    )
      job.command.keys = [...new Set([...job.command.keys, ...command.keys])];
    else if (
      job !== undefined &&
      job.command.kind === "purge" &&
      command.kind === "purge"
    )
      job.command.threadIds = [
        ...new Set([...job.command.threadIds, ...command.threadIds]),
      ];
    else if (
      job !== undefined &&
      job.command.kind === "put" &&
      command.kind === "put"
    ) {
      const records = new Map(
        job.command.write.records.map((record) => [record.key, record]),
      );

      for (const record of command.write.records) {
        const previous = records.get(record.key);

        if (previous === undefined || previous.sequence < record.sequence)
          records.set(record.key, record);
      }

      const bytes = [...records.values()].reduce(
        (total, record) => total + Buffer.byteLength(record.body),
        0,
      );

      if (queuedBytes - job.bytes + bytes > 64 * 1024 * 1024)
        throw unavailable();
      queuedBytes += bytes - job.bytes;
      job.bytes = bytes;
      job.command.write.records = [...records.values()];
    } else {
      const bytes =
        command.kind === "put"
          ? command.write.records.reduce(
              (total, record) => total + Buffer.byteLength(record.body),
              0,
            )
          : 0;

      if (queue.length >= 32 || queuedBytes + bytes > 64 * 1024 * 1024)
        throw unavailable();
      job = { id: randomUUID(), command, subscribers: [], bytes };
      queuedBytes += bytes;

      if (command.kind === "purge") queue.unshift(job);
      else queue.push(job);
    }

    const shared = job;

    return new Promise<HistoryCacheAdmission[]>((resolve, reject) => {
      shared.subscribers.push({ resolve, reject });
      drain();
    });
  }

  return {
    ready,
    put: (write) => request({ kind: "put", write }),
    purge: async (threadId) => {
      await request({ kind: "purge", threadIds: [threadId] });
    },
    touch: async (keys) => {
      await request({ kind: "touch", keys: [...keys] });
    },
    async close() {
      fail();
      await worker.terminate();
    },
  };
}

function writer(db: DbConnection): CacheWriter {
  let current = writers.get(db);

  if (current === undefined) {
    current = createWriter(db);
    writers.set(db, current);
  }

  return current;
}

export async function ensureHistoryCache(db: DbConnection): Promise<void> {
  if (!db.$client.memory) await writer(db).ready;
}

export async function persistHistoryCache(
  db: DbConnection,
  write: HistoryCacheWrite,
): Promise<HistoryCacheAdmission[]> {
  if (!db.$client.memory && write.records.length > 0)
    return writer(db).put(write);

  return [];
}

export async function touchHistoryCache(
  db: DbConnection,
  keys: readonly string[],
): Promise<void> {
  if (!db.$client.memory && keys.length > 0) await writer(db).touch(keys);
}

export async function purgeHistoryCacheThread(
  db: DbConnection,
  threadId: string,
): Promise<void> {
  if (!db.$client.memory) await writer(db).purge(threadId);
}

export async function closeHistoryCacheWriter(db: DbConnection): Promise<void> {
  const current = writers.get(db);
  writers.delete(db);
  await current?.close();
}
