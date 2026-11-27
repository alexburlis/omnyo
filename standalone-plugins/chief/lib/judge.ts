import { z } from "zod";
import { many, one, type Sql } from "./db.ts";
import type { TriageSubmission } from "./inputs.ts";
import type { ProposalSubmission } from "./rules.ts";

export const judgeKindSchema = z.enum(["triage", "distill", "eval"]);

export type JudgeKind = z.infer<typeof judgeKindSchema>;

export type JudgeSubmission = TriageSubmission | ProposalSubmission;

const kindRowSchema = z.object({ kind: judgeKindSchema });

const threadRowSchema = z.object({ thread_id: z.string() });

export interface ChiefHome {
  threadId: string;
  projectId: string;
  environmentId: string;
}

export interface JudgeModel {
  providerId: string;
  model: string;
}

interface Waiter {
  kind: JudgeKind;
  resolve(value: JudgeSubmission): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export const JUDGE_TIMEOUT_MS = 180_000;

export interface JudgeSpawn {
  projectId: string;
  environmentId: string;
  parentThreadId: string;
  title: string;
  providerId: string;
  model: string;
  kind: JudgeKind;
  prompt: string;
}

export interface JudgeHost {
  spawn(args: JudgeSpawn): Promise<string>;
  stop(threadId: string): Promise<void>;
  remove(threadId: string): Promise<void>;
  warn(message: string): void;
}

export class Judges {
  private readonly waiters = new Map<string, Waiter>();
  private readonly early = new Map<string, JudgeSubmission>();

  private readonly host: JudgeHost;
  private readonly db: Sql;
  private readonly home: () => Promise<ChiefHome>;
  private readonly model: () => JudgeModel;
  private readonly timeoutMs: number;

  constructor(
    host: JudgeHost,
    db: Sql,
    home: () => Promise<ChiefHome>,
    model: () => JudgeModel,
    timeoutMs: number = JUDGE_TIMEOUT_MS,
  ) {
    this.host = host;
    this.db = db;
    this.home = home;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  accepts(threadId: string, kinds: readonly JudgeKind[]): boolean {
    const row = one(
      kindRowSchema,
      this.db
        .prepare("SELECT kind FROM judges WHERE thread_id = ? AND status = 'running'")
        .get(threadId),
    );

    return row !== undefined && kinds.includes(row.kind);
  }

  isJudge(threadId: string): boolean {
    return (
      this.db.prepare("SELECT 1 AS found FROM judges WHERE thread_id = ?").get(threadId) !==
      undefined
    );
  }

  async run(
    kind: JudgeKind,
    prompt: string,
    itemKeys: readonly string[],
    jobId: string | null,
  ): Promise<JudgeSubmission> {
    const home = await this.home();
    const { providerId, model } = this.model();

    const threadId = await this.host.spawn({
      projectId: home.projectId,
      environmentId: home.environmentId,
      parentThreadId: home.threadId,
      title: `Chief ${kind} judge`,
      providerId,
      model,
      kind,
      prompt,
    });

    this.db
      .prepare(
        "INSERT INTO judges (thread_id, kind, job_id, item_keys, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
      )
      .run(threadId, kind, jobId, JSON.stringify(itemKeys), Date.now());

    try {
      const value = await new Promise<JudgeSubmission>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The judge did not answer within three minutes.")),
          this.timeoutMs,
        );

        this.waiters.set(threadId, { kind, resolve, reject, timer });

        const early = this.early.get(threadId);

        if (early !== undefined) {
          resolve(early);
          this.early.delete(threadId);
        }
      });

      this.finish(threadId, "recorded", null);

      return value;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The judge failed.";

      this.finish(threadId, "failed", message);
      throw new Error(message);
    } finally {
      const waiter = this.waiters.get(threadId);

      if (waiter) clearTimeout(waiter.timer);
      this.waiters.delete(threadId);
      await this.retire(threadId);
    }
  }

  submit(threadId: string, value: JudgeSubmission): void {
    const waiter = this.waiters.get(threadId);

    if (waiter) waiter.resolve(value);
    else this.early.set(threadId, value);
  }

  fail(threadId: string, reason: string): void {
    this.waiters.get(threadId)?.reject(new Error(reason));
  }

  async recover(): Promise<void> {
    const rows = many(
      threadRowSchema,
      this.db
        .prepare("SELECT thread_id FROM judges WHERE status IN ('running', 'recorded', 'failed')")
        .all(),
    );

    await Promise.all(
      rows.map(async (row) => {
        this.finish(row.thread_id, "failed", "Interrupted by a plugin restart.");
        await this.retire(row.thread_id);
      }),
    );
  }

  dispose(): void {
    for (const [threadId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("The Chief plugin stopped."));
      this.waiters.delete(threadId);
    }
  }

  private finish(threadId: string, status: "recorded" | "failed", error: string | null): void {
    this.db
      .prepare(
        "UPDATE judges SET status = ?, error = COALESCE(?, error), ended_at = ? WHERE thread_id = ? AND status = 'running'",
      )
      .run(status, error, Date.now(), threadId);
  }

  private async retire(threadId: string): Promise<void> {
    try {
      await this.host.stop(threadId);
    } catch (cause) {
      this.host.warn(`Chief judge ${threadId} did not stop cleanly: ${String(cause)}`);
    }

    try {
      await this.host.remove(threadId);
      this.db.prepare("UPDATE judges SET status = 'retired' WHERE thread_id = ?").run(threadId);
    } catch (cause) {
      this.host.warn(`Chief judge ${threadId} could not be deleted: ${String(cause)}`);
    }
  }
}
