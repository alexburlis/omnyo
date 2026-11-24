import type { ConstructedThreadEventInput } from "@omnyo/db";
import {
  threadEventSchema,
  type RecordedThreadExecutionOptions,
  type ThreadEventItem,
} from "@omnyo/domain";
import type {
  NativeHistoryItem,
  NativeHistoryTurn,
} from "@omnyo/server-contract";
import { z } from "zod";
import { createClientTurnRequestId } from "./thread-events.js";

interface NativeImportTurnsArgs {
  cwd: string;
  sourceProviderThreadId: string;
  turns: readonly NativeHistoryTurn[];
}

interface BuildNativeImportHistoryRowsArgs extends NativeImportTurnsArgs {
  execution: RecordedThreadExecutionOptions;
  threadId: string;
}

interface BuildRowsArgs extends NativeImportTurnsArgs {
  execution: RecordedThreadExecutionOptions | null;
  threadId: string;
}

const PREFLIGHT_THREAD_ID = "native-import-preflight";

const toolArgumentsObjectSchema = z.record(z.string(), z.unknown());

function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { input: raw };
  }

  const object = toolArgumentsObjectSchema.safeParse(parsed);

  return object.success && !Array.isArray(parsed)
    ? object.data
    : { input: raw };
}

function toThreadEventItem(
  item: NativeHistoryItem,
  args: { cwd: string; id: string },
): ThreadEventItem {
  switch (item.type) {
    case "agentMessage":
      return { type: "agentMessage", id: args.id, text: item.text };
    case "commandExecution":
      return {
        type: "commandExecution",
        id: args.id,
        command: item.command,
        cwd: item.cwd ?? args.cwd,
        status:
          item.exitCode === null || item.exitCode === 0
            ? "completed"
            : "failed",
        approvalStatus: null,
        aggregatedOutput: item.output,
        ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: args.id,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          ...(change.diff === null ? {} : { diff: change.diff }),
        })),
        status: "completed",
        approvalStatus: null,
      };
    case "toolCall":
      return {
        type: "toolCall",
        id: args.id,
        tool: item.tool,
        ...(item.server === null ? {} : { server: item.server }),
        ...(item.arguments === null
          ? {}
          : { arguments: parseToolArguments(item.arguments) }),
        status: item.error === null ? "completed" : "failed",
        ...(item.result === null ? {} : { result: item.result }),
        ...(item.error === null ? {} : { error: item.error }),
      };
  }
}

function assertValidHistoryRow(
  row: ConstructedThreadEventInput,
  threadId: string,
): void {
  const result = threadEventSchema.safeParse({
    ...row.data,
    scope: row.scope,
    threadId,
    type: row.type,
  });

  if (!result.success) {
    throw new Error(
      `Imported history row ${row.type} is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
}

function buildRows(args: BuildRowsArgs): ConstructedThreadEventInput[] {
  const rows: ConstructedThreadEventInput[] = [];
  const usedItemIds = new Set<string>();
  const providerThreadId = args.sourceProviderThreadId;
  let clock = 0;

  const at = (timestamp: number): number => {
    clock = Math.max(clock, timestamp);

    return clock;
  };

  args.turns.forEach((turn, turnIndex) => {
    const turnNumber = turnIndex + 1;
    const turnId = `imp-${turnNumber}`;
    const scope = { kind: "turn" as const, turnId };
    const requestId = createClientTurnRequestId();
    const startedAt = at(turn.startedAt);

    if (args.execution !== null) {
      rows.push({
        type: "client/turn/requested",
        scope: { kind: "thread" },
        createdAt: startedAt,
        data: {
          direction: "outbound",
          requestId,
          source: "tell",
          initiator: "user",
          senderThreadId: null,
          input: [{ type: "text", text: turn.userText, mentions: [] }],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: args.execution,
        },
      });
    }

    rows.push(
      {
        type: "turn/started",
        scope,
        createdAt: startedAt,
        data: { providerThreadId },
      },
      {
        type: "turn/input/accepted",
        scope,
        createdAt: startedAt,
        data: { providerThreadId, clientRequestId: requestId },
      },
    );

    const completedAt = at(turn.completedAt);

    turn.items.forEach((item, itemIndex) => {
      const id = usedItemIds.has(item.id)
        ? `imp-${turnNumber}-${itemIndex + 1}`
        : item.id;

      usedItemIds.add(id);
      rows.push({
        type: "item/completed",
        scope,
        createdAt: completedAt,
        data: {
          providerThreadId,
          item: toThreadEventItem(item, { cwd: args.cwd, id }),
        },
      });
    });

    rows.push({
      type: "turn/completed",
      scope,
      createdAt: completedAt,
      data: { providerThreadId: null, status: turn.status },
    });
  });

  for (const row of rows) {
    assertValidHistoryRow(row, args.threadId);
  }

  return rows;
}

export function assertNativeImportTurnsValid(
  args: NativeImportTurnsArgs,
): void {
  buildRows({ ...args, execution: null, threadId: PREFLIGHT_THREAD_ID });
}

export function buildNativeImportHistoryRows(
  args: BuildNativeImportHistoryRowsArgs,
): ConstructedThreadEventInput[] {
  return buildRows(args);
}
