import { createHash } from "node:crypto";
import { z } from "zod";
import { bindingSchema, idSchema, type ContextBinding, type JsonPayload } from "./contracts.js";
import { PayloadError } from "./package-payload.js";
import { bindingFingerprint } from "./routing.js";

const stateSchema = z.enum(["accepted", "running", "completed", "cancelled", "interrupted"]);

const acceptedSchema = z.object({ runId: idSchema, sessionId: idSchema, state: stateSchema });

const recordSchema = z.strictObject({
  requestId: idSchema,
  binding: bindingSchema,
  phase: z.enum(["pending", "accepted", "terminal", "not_admitted"]),
  runId: idSchema.optional(),
  sessionId: idSchema.optional(),
  state: stateSchema.optional(),
  detached: z.boolean(),
  stopped: z.boolean(),
  released: z.boolean(),
  updatedAt: z.number(),
});

type Record = z.infer<typeof recordSchema>;

const jobSchema = z.object({
  runId: idSchema,
  state: stateSchema,
  result: z
    .object({
      sessionId: idSchema,
      verdict: z.enum(["PASSED", "FAILED", "INCONCLUSIVE", "BLOCKED", "CANCELLED"]),
      checks: z.array(z.object({ checkId: idSchema, status: z.string() })),
      evidence: z.array(z.object({ id: idSchema })),
    })
    .optional(),
});

const final = (state: string) => ["completed", "cancelled", "interrupted"].includes(state);

const prefix = "fastloop.admission.v1.";

export interface LifecyclePort {
  load(key: string): Promise<JsonPayload | undefined>;
  save(key: string, value: JsonPayload): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  latest(threadId: string, signal: AbortSignal): Promise<number>;
  interruptions(
    threadId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<{ seq: number; reason: string }[]>;
  invoke(
    method: "submission" | "result" | "releaseClient",
    binding: ContextBinding,
    payload: JsonPayload,
  ): Promise<JsonPayload>;
  remember(binding: ContextBinding, accepted: z.infer<typeof acceptedSchema>): Promise<void>;
  suppressCompletion(runId: string): Promise<void>;
  completion(input: {
    runId: string;
    threadId: string;
    projectId: string;
    summary: string;
  }): Promise<void>;
}

export class ThreadLifecycle {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private closing?: Promise<void>;
  readonly faults = new Map<string, string>();
  constructor(private readonly port: LifecyclePort) {}
  private key(binding: ContextBinding, requestId: string): string {
    return (
      prefix +
      createHash("sha256")
        .update(bindingFingerprint(binding) + "\n" + requestId)
        .digest("hex")
    );
  }
  private cursorKey(threadId: string): string {
    return `fastloop.thread-cursor.v1.${threadId}`;
  }
  private save(record: Record): Promise<void> {
    return this.port.save(this.key(record.binding, record.requestId), recordSchema.parse(record));
  }
  private async records(threadId?: string): Promise<Record[]> {
    const keys = await this.port.keys(prefix);

    if (keys.length > 1000) throw new PayloadError("ADMISSION_INDEX_BOUND_EXCEEDED");
    const records: Record[] = [];

    for (const key of keys) {
      const record = recordSchema.parse(await this.port.load(key));

      if (!threadId || record.binding.threadId === threadId) records.push(record);
    }

    return records;
  }
  private serialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    this.tails.set(
      threadId,
      result.then(
        () => {},
        () => {},
      ),
    );

    return result;
  }
  private async resolve(record: Record): Promise<void> {
    if (!record.runId) {
      const found = await this.port.invoke("submission", record.binding, {
        requestId: record.requestId,
      });

      if (found === null) return;
      const accepted = acceptedSchema.parse(found);
      record.runId = accepted.runId;
      record.sessionId = accepted.sessionId;
      record.state = accepted.state;
      record.phase = "accepted";
      await this.save(record);
      await this.port.remember(record.binding, accepted);
    }
  }
  private async observe(record: Record): Promise<JsonPayload | undefined> {
    await this.resolve(record);

    if (!record.runId) return;
    const value = await this.port.invoke("result", record.binding, { runId: record.runId });
    const job = jobSchema.parse(value);

    if (job.runId !== record.runId || (job.result && job.result.sessionId !== record.sessionId))
      throw new PayloadError("RUN_CONTEXT_MISMATCH");
    record.state = job.state;
    record.updatedAt = Date.now();

    if (final(job.state)) {
      if (!job.result) throw new PayloadError("TERMINAL_RESULT_REQUIRED");
      record.phase = "terminal";
      await this.save(record);

      if (record.detached && !record.stopped) {
        const evidence = job.result.evidence
          .map((item) => item.id)
          .filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
          .slice(0, 8);

        await this.port.completion({
          runId: record.runId,
          threadId: record.binding.threadId,
          projectId: record.binding.projectId,
          summary: `${job.result.verdict}. Checks: ${job.result.checks.length}. Evidence: ${evidence.join(", ") || "none"}. Read the bound result before continuing.`,
        });
      }
    } else await this.save(record);

    return value;
  }
  private async releaseRecords(records: Record[]): Promise<void> {
    const released = new Set<string>();

    for (const record of records) {
      if (record.runId) await this.port.suppressCompletion(record.runId);

      if (record.released && ["terminal", "not_admitted"].includes(record.phase)) continue;
      record.stopped = true;
      record.detached = false;
      await this.save(record);
      const key = bindingFingerprint(record.binding);

      if (!released.has(key)) {
        await this.port.invoke("releaseClient", record.binding, {});
        released.add(key);
      }

      record.released = true;
      await this.save(record);
      await this.resolve(record);

      if (record.runId) await this.observe(record);
      else {
        record.phase = "not_admitted";
        await this.save(record);
      }

      await this.port.invoke("releaseClient", record.binding, {});
    }
  }
  private async reconcileLocked(threadId: string): Promise<void> {
    const cursorValue = await this.port.load(this.cursorKey(threadId));

    if (cursorValue === undefined) return;
    let cursor = z.number().int().nonnegative().parse(cursorValue);

    for (let page = 0; page < 10; page++) {
      const events = await this.port.interruptions(threadId, cursor, this.abort.signal);

      if (!events.length) return;

      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= cursor)
          throw new PayloadError("THREAD_EVENT_ORDER_INVALID");

        if (event.reason === "manual-stop") await this.releaseRecords(await this.records(threadId));
        cursor = event.seq;
        await this.port.save(this.cursorKey(threadId), cursor);
      }

      if (events.length < 100) return;
    }

    throw new PayloadError("THREAD_EVENT_BACKLOG_EXCEEDED");
  }
  async prepare(binding: ContextBinding, payload: JsonPayload, signal: AbortSignal): Promise<void> {
    if (this.closing) throw new PayloadError("PLUGIN_DISPOSING");
    const { requestId } = z.object({ requestId: idSchema }).parse(payload);
    await this.serialized(binding.threadId, async () => {
      signal.throwIfAborted();
      await this.reconcileLocked(binding.threadId);

      if ((await this.port.load(this.cursorKey(binding.threadId))) === undefined) {
        const cursor = await this.port.latest(binding.threadId, signal);
        await this.port.save(this.cursorKey(binding.threadId), cursor);
      }

      const key = this.key(binding, requestId);

      if ((await this.port.load(key)) === undefined)
        await this.save({
          requestId,
          binding,
          phase: "pending",
          detached: false,
          stopped: false,
          released: false,
          updatedAt: Date.now(),
        });
      signal.throwIfAborted();
    });
  }
  async accepted(
    binding: ContextBinding,
    payload: JsonPayload,
    result: JsonPayload,
  ): Promise<void> {
    const { requestId } = z.object({ requestId: idSchema }).parse(payload);
    await this.serialized(binding.threadId, async () => {
      const record = recordSchema.parse(await this.port.load(this.key(binding, requestId)));
      const accepted = acceptedSchema.parse(result);
      record.runId = accepted.runId;
      record.sessionId = accepted.sessionId;
      record.state = accepted.state;
      record.phase = "accepted";
      await this.save(record);

      if (record.stopped) await this.releaseRecords([record]);
      await this.reconcileLocked(binding.threadId);
    });
  }
  async detached(binding: ContextBinding, requestId: string): Promise<string | undefined> {
    return this.serialized(binding.threadId, async () => {
      const record = recordSchema.parse(await this.port.load(this.key(binding, requestId)));
      record.detached = !record.stopped;
      await this.save(record);

      try {
        await this.observe(record);

        return undefined;
      } catch (error) {
        const code = error instanceof PayloadError ? error.code : "THREAD_OBSERVATION_FAILED";
        this.faults.set(binding.threadId, code);

        return code;
      }
    });
  }
  async admissionFailed(
    binding: ContextBinding,
    requestId: string,
    aborted: boolean,
  ): Promise<void> {
    await this.serialized(binding.threadId, async () => {
      const record = recordSchema.parse(await this.port.load(this.key(binding, requestId)));

      if (aborted) {
        await this.releaseRecords([record]);

        return;
      }

      record.detached = true;
      await this.save(record);
      await this.observe(record);
    });
  }
  async hint(threadId: string): Promise<void> {
    if (this.closing) return;
    await this.serialized(threadId, async () => {
      await this.reconcileLocked(threadId);

      for (const record of await this.records(threadId))
        if (record.phase === "pending" || record.phase === "accepted") await this.observe(record);
    }).catch((error) => {
      this.faults.set(
        threadId,
        error instanceof PayloadError ? error.code : "THREAD_LIFECYCLE_FAILED",
      );
    });
  }
  async stop(threadId: string): Promise<void> {
    await this.serialized(threadId, async () => {
      await this.releaseRecords(await this.records(threadId));
    });
  }

  async refresh(): Promise<void> {
    for (const threadId of new Set((await this.records()).map((record) => record.binding.threadId)))
      await this.hint(threadId);
  }

  async recover(): Promise<void> {
    const records = await this.records();

    for (const threadId of new Set(records.map((record) => record.binding.threadId))) {
      await this.serialized(threadId, async () => {
        const abandoned = (await this.records(threadId)).filter(
          (record) =>
            !record.detached && record.phase !== "terminal" && record.phase !== "not_admitted",
        );

        await this.releaseRecords(abandoned);

        for (const record of await this.records(threadId))
          if (record.phase === "terminal" && record.detached && !record.stopped)
            await this.observe(record);
      });
      await this.hint(threadId);
    }
  }

  async index(
    threadId: string,
  ): Promise<
    { runId: string; sessionId: string; state: z.infer<typeof stateSchema>; updatedAt: number }[]
  > {
    const results = [];

    for (const record of await this.records(threadId))
      if (record.runId && record.sessionId && record.state)
        results.push({
          runId: record.runId,
          sessionId: record.sessionId,
          state: record.state,
          updatedAt: record.updatedAt,
        });

    return results.slice(-100);
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      const records = await this.records();

      for (const threadId of new Set(records.map((record) => record.binding.threadId)))
        await this.stop(threadId);
      const released = new Set<string>();

      for (const record of records) {
        const key = bindingFingerprint(record.binding);

        if (released.has(key)) continue;
        await this.port.invoke("releaseClient", record.binding, {});
        released.add(key);
      }

      this.abort.abort();
    })();

    return this.closing;
  }
}
