import { and, desc, eq, gt } from "drizzle-orm";
import { events, type DbConnection } from "@omnyo/db";
import {
  threadEventPlanStepsItemSchema,
  type InboxRunningProgress,
  type ThreadEventItemType,
  type ThreadEventType,
} from "@omnyo/domain";
import { sliceUtf16Head } from "@omnyo/text-utils";
import { z } from "zod";

const NOTE_MAX_LENGTH = 200;

const agentMessageDataSchema = z.object({
  item: z.object({ type: z.literal("agentMessage"), text: z.string() }),
});

const commandDataSchema = z.object({
  item: z.object({
    type: z.literal("commandExecution"),
    presentation: z.object({ title: z.string().optional() }).optional(),
  }),
});

const planStepsDataSchema = z.object({ item: threadEventPlanStepsItemSchema });

export interface TurnProgress {
  note: string | null;
  progress: InboxRunningProgress | null;
}

export function progressNote(text: string): string | null {
  const line = text
    .split("\n")
    .map((part) =>
      part
        .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((part) => part.length > 0);

  if (line === undefined) return null;

  return line.length <= NOTE_MAX_LENGTH
    ? line
    : `${sliceUtf16Head(line, NOTE_MAX_LENGTH - 1).trimEnd()}…`;
}

function parsed<T>(schema: z.ZodType<T>, data: string | undefined): T | null {
  if (data === undefined) return null;
  const result = schema.safeParse(JSON.parse(data));

  return result.success ? result.data : null;
}

function latestData(
  db: DbConnection,
  threadId: string,
  type: ThreadEventType,
  itemKind: ThreadEventItemType,
  after: number,
): { data: string; sequence: number } | undefined {
  return db
    .select({ data: events.data, sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, type),
        eq(events.itemKind, itemKind),
        gt(events.sequence, after),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
}

export function readTurnProgress(
  db: DbConnection,
  threadId: string,
): TurnProgress {
  const turnStart =
    db
      .select({ sequence: events.sequence })
      .from(events)
      .where(
        and(eq(events.threadId, threadId), eq(events.type, "turn/started")),
      )
      .orderBy(desc(events.sequence))
      .limit(1)
      .get()?.sequence ?? -1;

  const message = parsed(
    agentMessageDataSchema,
    latestData(db, threadId, "item/completed", "agentMessage", turnStart)?.data,
  );

  const command = parsed(
    commandDataSchema,
    latestData(db, threadId, "item/started", "commandExecution", turnStart)
      ?.data,
  );

  const commandTitle = command?.item.presentation?.title?.trim() ?? "";

  const note =
    (message === null ? null : progressNote(message.item.text)) ??
    (commandTitle.length === 0
      ? null
      : progressNote(`Running ${commandTitle}`));

  const planRow = latestData(db, threadId, "item/completed", "planSteps", -1);
  const plan = parsed(planStepsDataSchema, planRow?.data);
  const steps = plan?.item.steps ?? [];

  const done = steps.filter(
    (step) => step.status === "completed" || step.status === "failed",
  ).length;

  const current =
    planRow !== undefined &&
    steps.length > 0 &&
    (planRow.sequence > turnStart || done < steps.length);

  return {
    note,
    progress: current ? { done, total: steps.length } : null,
  };
}
