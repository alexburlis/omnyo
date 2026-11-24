import { sql } from "drizzle-orm";
import { events, pluginKv, threads, type DbConnection } from "@omnyo/db";
import { z } from "zod";

const reportText = z.string().trim().min(1).max(400);

const outcomeReceiptSchema = z.object({
  turnId: z.string().min(1),
  requestSeq: z.number().int().positive(),
  report: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("complete"),
      outcome: reportText,
      evidence: reportText,
    }),
    z.object({
      status: z.literal("open"),
      blocker: reportText,
      next: reportText,
    }),
  ]),
});

type OutcomeReceipt = z.infer<typeof outcomeReceiptSchema>;

interface CompletionContext {
  threadId: string;
  requestSeq: number;
  completionSeq: number;
}

interface Continuation {
  threadId: string;
  title: string;
}

export function readWorkContinuations(
  db: DbConnection,
  sourceIds: readonly string[],
): Map<string, Continuation> {
  if (sourceIds.length === 0) return new Map();

  const rows = db.all<{
    sourceId: string;
    threadId: string;
    title: string;
  }>(sql`
    WITH candidates AS (
      SELECT
        source.id AS sourceId,
        continuation.id AS threadId,
        COALESCE(continuation.title, continuation.title_fallback, 'Untitled chat') AS title,
        ROW_NUMBER() OVER (
          PARTITION BY source.id ORDER BY continuation.created_at DESC, continuation.id DESC
        ) AS position
      FROM json_each(${JSON.stringify(sourceIds)}) AS requested
      JOIN ${threads} AS source ON source.id = requested.value
      JOIN ${threads} AS continuation ON continuation.source_thread_id = source.id
        AND continuation.project_id = source.project_id
        AND continuation.origin_kind = 'handoff'
        AND continuation.visibility = 'visible'
        AND continuation.deleted_at IS NULL
        AND continuation.created_at >= MAX(
          COALESCE(source.last_message_at, source.created_at), source.status_changed_at
        )
      WHERE source.status NOT IN ('active', 'starting', 'stopping')
    )
    SELECT sourceId, threadId, title FROM candidates WHERE position = 1
  `);

  return new Map(
    rows.map(({ sourceId, threadId, title }) => [
      sourceId,
      { threadId, title },
    ]),
  );
}

function parseOutcomeReceipt(value: string): OutcomeReceipt | null {
  try {
    return outcomeReceiptSchema.safeParse(JSON.parse(value)).data ?? null;
  } catch {
    return null;
  }
}

export function readBoundCompletionReports(
  db: DbConnection,
  inputs: readonly CompletionContext[],
): Map<string, OutcomeReceipt["report"]> {
  if (inputs.length === 0) return new Map();

  const rows = db.all<{
    threadId: string;
    requestSeq: number;
    completionSeq: number;
    turnId: string;
    value: string;
  }>(sql`
    SELECT outcome.thread_id AS threadId,
      json_extract(requested.value, '$.requestSeq') AS requestSeq,
      outcome.sequence AS completionSeq, outcome.turn_id AS turnId, receipt.value
    FROM json_each(${JSON.stringify(inputs)}) AS requested
    JOIN ${pluginKv} AS receipt ON receipt.plugin_id = 'omnyo--composer-predictions'
      AND receipt.key = 'completion-report:v1:' || json_extract(requested.value, '$.threadId')
    JOIN ${events} AS outcome ON outcome.thread_id = json_extract(requested.value, '$.threadId')
      AND outcome.sequence = json_extract(requested.value, '$.completionSeq')
      AND outcome.type = 'turn/completed'
      AND outcome.scope_kind = 'turn'
      AND outcome.parent_tool_call_id IS NULL
      AND json_valid(outcome.data)
      AND json_extract(outcome.data, '$.status') = 'completed'
      AND json_extract(outcome.data, '$.parentToolCallId') IS NULL
  `);

  const reports = new Map<string, OutcomeReceipt["report"]>();

  for (const row of rows) {
    const receipt = parseOutcomeReceipt(row.value);

    if (
      receipt !== null &&
      receipt.turnId === row.turnId &&
      receipt.requestSeq === row.requestSeq &&
      row.requestSeq < row.completionSeq
    )
      reports.set(row.threadId, receipt.report);
  }

  return reports;
}
