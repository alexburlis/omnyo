import { z } from "zod";
import {
  closeAutomationRun,
  setAutomationRunThread,
  setAutomationRunTurnRequest,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import type { AgentRunApi } from "./run.js";

const requestSchema = z.object({
  seq: z.number(),
  createdAt: z.number(),
  data: z.object({
    requestId: z.string(),
    retryOfRequestId: z.string().optional(),
  }),
});

const requestsSchema = z.array(requestSchema);

const threadSchema = z.object({
  deletedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  status: z.enum([
    "pending",
    "idle",
    "active",
    "starting",
    "stopping",
    "error",
  ]),
});

const conflictSchema = z.object({
  status: z.literal(409),
  code: z.enum(["retry_already_queued", "no_failed_turn"]),
});

function requestChain(request: z.infer<typeof requestSchema>): string {
  return request.data.retryOfRequestId ?? request.data.requestId;
}

async function readRequest(
  api: AgentRunApi,
  threadId: string,
  order: "asc" | "desc",
): Promise<z.infer<typeof requestSchema> | null> {
  return (
    requestsSchema.parse(
      await api.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order,
        limit: "1",
      }),
    )[0] ?? null
  );
}

export async function automationRunOwnsLatestRequest(
  api: AgentRunApi,
  run: AutomationRunRow,
): Promise<boolean> {
  if (run.turnRequestId === null || run.threadId === null) return true;
  const latest = await readRequest(api, run.threadId, "desc");

  return latest !== null && requestChain(latest) === run.turnRequestId;
}

export async function recoverAutomationAgentRun(
  api: AgentRunApi,
  db: Db,
  args: {
    automation: AutomationRow;
    run: AutomationRunRow;
    failedRun: AutomationRunRow;
  },
): Promise<void> {
  const threadId = args.failedRun.threadId;

  if (threadId === null)
    throw new Error("Automation retry has no original thread");
  setAutomationRunThread(db, { runId: args.run.id, threadId });
  let originalRequestId = args.failedRun.turnRequestId;

  if (originalRequestId === null) {
    const first = await readRequest(api, threadId, "asc");

    if (
      args.automation.targetThreadId !== null ||
      first === null ||
      first.createdAt < args.failedRun.startedAt ||
      args.failedRun.finishedAt === null ||
      first.createdAt > args.failedRun.finishedAt
    ) {
      throw new Error(
        "Cannot recover automation: its original turn request is unavailable",
      );
    }

    originalRequestId = requestChain(first);
    setAutomationRunTurnRequest(db, {
      runId: args.failedRun.id,
      turnRequestId: originalRequestId,
    });
  }

  setAutomationRunTurnRequest(db, {
    runId: args.run.id,
    turnRequestId: originalRequestId,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const thread = threadSchema.parse(await api.sdk.threads.get({ threadId }));
    const latest = await readRequest(api, threadId, "desc");

    if (latest === null || requestChain(latest) !== originalRequestId) {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "skipped",
        skipReason:
          "superseded: the original thread has a different turn request",
        threadId,
        now: Date.now(),
      });

      return;
    }

    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "skipped",
        skipReason: "interrupted: the original retry thread is unavailable",
        threadId,
        now: Date.now(),
      });

      return;
    }

    if (thread.status === "idle") {
      closeAutomationRun(db, {
        runId: args.run.id,
        status: "succeeded",
        threadId,
        now: Date.now(),
      });

      return;
    }

    if (thread.status !== "error") return;

    try {
      await api.sdk.threads.retry({
        threadId,
        turnRequestId: latest.data.requestId,
        reason: "Scheduled automation recovery",
      });

      return;
    } catch (error) {
      const conflict = conflictSchema.safeParse(error);

      if (!conflict.success) throw error;

      if (conflict.data.code === "retry_already_queued") return;

      if (attempt !== 0) throw error;
    }
  }
}
