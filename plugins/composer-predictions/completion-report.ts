import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { PredictionState } from "./contract";

const text = z.string().trim().min(1).max(400);

const reportSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("complete"), outcome: text, evidence: text })
    .strict(),
  z.object({ status: z.literal("open"), blocker: text, next: text }).strict(),
]);

const receiptSchema = z.object({
  turnId: z.string().min(1),
  requestSeq: z.number().int().positive(),
  report: reportSchema,
});

const toolName = "report_chat_outcome";

type ThreadEvents = PluginApi["sdk"]["threads"]["events"];

type ThreadEvent = Awaited<ReturnType<ThreadEvents["list"]>>[number];

type CompletedTurn = Extract<ThreadEvent, { type: "turn/completed" }>;

function key(threadId: string) {
  return `completion-report:v1:${threadId}`;
}

export function registerCompletionReports(api: PluginApi) {
  async function latestRequest(threadId: string, signal: AbortSignal) {
    const [request] = await api.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
      signal,
    });

    return request?.type === "client/turn/requested" &&
      request.data.maintenance === undefined
      ? request
      : null;
  }

  api.agents.registerTool({
    name: toolName,
    description:
      "Record this chat's outcome separately from the reply for Omnyo's archive assessment.",
    instructions:
      "Before a final reply, report the whole requested outcome and its concrete evidence, or the material blocker and next action. Use the tool for bookkeeping and answer the user normally. Keep private content and credentials out of the report.",
    presentation: { suppress: true },
    parameters: z.strictObject({ report: reportSchema }),
    async execute({ report }, { threadId, signal }) {
      const [started, completed, [accepted], request] = await Promise.all([
        api.sdk.threads.events.list({
          threadId,
          types: ["turn/started"],
          order: "desc",
          limit: "20",
          signal,
        }),
        api.sdk.threads.events.list({
          threadId,
          types: ["turn/completed"],
          order: "desc",
          limit: "20",
          signal,
        }),
        api.sdk.threads.events.list({
          threadId,
          types: ["turn/input/accepted"],
          order: "desc",
          limit: "1",
          signal,
        }),
        latestRequest(threadId, signal),
      ]);

      const current = started.find(
        (event) =>
          event.type === "turn/started" && !event.data.parentToolCallId,
      );

      const turn = current?.scope.kind === "turn" ? current.scope.turnId : null;

      if (
        current === undefined ||
        turn === null ||
        request === null ||
        accepted?.type !== "turn/input/accepted" ||
        accepted.scope.kind !== "turn" ||
        accepted.scope.turnId !== turn ||
        accepted.seq <= request.seq ||
        accepted.data.clientRequestId !== request.data.requestId ||
        completed.some(
          (event) =>
            event.seq > current.seq &&
            event.scope.kind === "turn" &&
            event.scope.turnId === turn,
        )
      )
        throw new Error("No active chat turn for this report");
      signal.throwIfAborted();
      await api.storage.kv.set(key(threadId), {
        turnId: turn,
        requestSeq: request.seq,
        report,
      });

      return "Recorded.";
    },
  });
  api.agents.configure(({ thread }) => ({
    skills: [],
    tools:
      thread.parentThreadId === null &&
      thread.experimental_visibility === "visible"
        ? [toolName]
        : [],
  }));

  return {
    async readiness(
      threadId: string,
      completed: CompletedTurn,
      signal: AbortSignal,
    ): Promise<PredictionState["archiveReadiness"]> {
      if (
        completed.scope.kind !== "turn" ||
        completed.data.status !== "completed"
      )
        return null;

      const receipt = receiptSchema.safeParse(
        await api.storage.kv.get(key(threadId)),
      ).data;

      if (!receipt || receipt.turnId !== completed.scope.turnId) return null;
      const request = await latestRequest(threadId, signal);

      if (request?.seq !== receipt.requestSeq || request.seq >= completed.seq)
        return null;
      const { report } = receipt;

      return report.status === "complete"
        ? {
            ready: true,
            reason: `${report.evidence} (reported by the agent)`,
            recap: report.outcome,
            waitingOn: null,
            ask: null,
          }
        : {
            ready: false,
            reason: report.blocker,
            recap: report.next,
            waitingOn: null,
            ask: null,
          };
    },
    forget: (threadId: string) => api.storage.kv.delete(key(threadId)),
  };
}
