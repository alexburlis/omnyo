import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  deriveStoredEventItemFields,
  insertEvents,
  noopNotifier,
  updateThread,
  type DbConnection,
} from "../../../packages/db/src/index.ts";
import {
  encodeClientTurnRequestIdNumber,
  parseStoredThreadEvent,
  threadScope,
  turnScope,
  type JsonObject,
  type ThreadEventType,
} from "../../../packages/domain/src/index.ts";
import { initDb } from "../../../apps/server/src/db.ts";
import { createHistoryFixture, FIXTURE_RECIPE } from "./fixture.mts";

export const CALIBRATED_RECIPE = {
  ...FIXTURE_RECIPE,
  version: 2,
  commands: 18_432,
  outputRepeats: 90,
  deltaRepeats: 11,
  usageEveryCommands: 4,
  nestedDepth: 3,
  appendedCompletedTurns: 24,
  hashMethod:
    "SHA256(previous fixture content hash followed by deterministic appended event tuples)",
};

function writer({
  db,
  fixture,
  startSequence,
  previousHash,
}: {
  db: DbConnection;
  fixture: ReturnType<typeof createHistoryFixture>;
  startSequence: number;
  previousHash: string;
}) {
  const thread = fixture.histories.find(
    (history) => history.kind === "completed",
  );

  assert.ok(thread);
  const hash = createHash("sha256").update(previousHash);
  let sequence = startSequence;
  let bytes = 0;
  let lifecycleBytes = 0;
  let batch: Array<Parameters<typeof insertEvents>[2][number]> = [];
  const byType = new Map<string, { events: number; bytes: number }>();

  function flush() {
    if (batch.length === 0) return;
    assert.equal(
      insertEvents(db, noopNotifier, batch).insertedCount,
      batch.length,
    );
    batch = [];
  }

  function emit(
    type: ThreadEventType,
    turnId: string | null,
    data: JsonObject,
  ) {
    sequence += 1;
    const scope = turnId === null ? threadScope() : turnScope(turnId);

    const providerThreadId =
      turnId === null ? null : "inert-completed-provider";

    const parsed = parseStoredThreadEvent({
      type,
      scope,
      data,
      providerThreadId,
      threadId: thread.threadId,
    });

    const serialized = JSON.stringify(data);
    const size = Buffer.byteLength(serialized);
    bytes += size;

    if (type === "item/started" || type === "item/completed")
      lifecycleBytes += size;
    const previous = byType.get(type) ?? { events: 0, bytes: 0 };
    byType.set(type, {
      events: previous.events + 1,
      bytes: previous.bytes + size,
    });
    hash.update(
      JSON.stringify(["completed", sequence, type, turnId, serialized]) + "\n",
    );
    batch.push({
      threadId: thread.threadId,
      environmentId: fixture.environmentId,
      providerThreadId,
      scope,
      sequence,
      type,
      ...deriveStoredEventItemFields(parsed),
      data: serialized,
      createdAt: FIXTURE_RECIPE.epochMs + sequence,
    });

    if (batch.length >= 256) flush();
  }

  function start(turnId: string, requestIndex: number) {
    const requestId = encodeClientTurnRequestIdNumber({ value: requestIndex });
    emit("client/turn/requested", null, {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: { method: "turn/start", params: {} },
      requestId,
      senderThreadId: null,
      input: [
        {
          type: "text",
          text: `Inert calibrated turn ${requestIndex} α🦊漢`,
          mentions: [],
        },
      ],
      target: { kind: "thread-start" },
      execution: {
        model: "inert-model",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    });
    emit("turn/started", turnId, {});
    emit("turn/input/accepted", turnId, { clientRequestId: requestId });
  }

  function command(
    turnId: string,
    id: string,
    output: string,
    delta: string,
    parentToolCallId?: string,
  ) {
    const item = {
      type: "commandExecution",
      id,
      command: `inert calibrated ${id}`,
      cwd: "/inert-history-fixture",
      approvalStatus: null,
    };

    const parentedItem =
      parentToolCallId === undefined ? item : { ...item, parentToolCallId };

    const deltaData =
      parentToolCallId === undefined
        ? { itemId: id, delta }
        : { itemId: id, delta, parentToolCallId };

    emit("item/started", turnId, {
      item: { ...parentedItem, status: "pending" },
    });
    emit("item/commandExecution/outputDelta", turnId, deltaData);
    emit("item/completed", turnId, {
      item: {
        ...parentedItem,
        status: "completed",
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 1,
      },
    });
  }

  return {
    emit,
    start,
    command,
    finish: () => {
      flush();

      return {
        maxSeq: sequence,
        events: sequence - startSequence,
        bytes,
        lifecycleBytes,
        byType: Object.fromEntries(byType),
        contentSHA256: hash.digest("hex"),
      };
    },
  };
}

export function createCalibratedHistoryFixture(
  databasePath: string,
  smoke = false,
) {
  const seed = createHistoryFixture(databasePath, true);
  const thread = seed.histories.find((history) => history.kind === "completed");
  assert.ok(thread);
  const db = initDb(databasePath);

  try {
    const events = writer({
      db,
      fixture: seed,
      startSequence: thread.maxSeq,
      previousHash: seed.contentSHA256,
    });

    const root = "calibrated-giant-root";
    const child = "calibrated-giant-child";
    const grandchild = "calibrated-giant-grandchild";
    const parent = "calibrated-root-delegate";
    const nestedParent = "calibrated-child-delegate";

    const rootAgent = {
      type: "toolCall",
      id: parent,
      tool: "Agent",
      arguments: {
        prompt: "Inert child fixture",
        subagent_type: "general-purpose",
      },
      status: "pending",
    };

    const childAgent = {
      type: "toolCall",
      id: nestedParent,
      parentToolCallId: parent,
      tool: "Agent",
      arguments: {
        prompt: "Inert grandchild fixture",
        subagent_type: "general-purpose",
      },
      status: "pending",
    };

    events.start(root, 1000);
    events.emit("item/started", root, { item: rootAgent });
    events.emit("turn/started", child, { parentToolCallId: parent });
    events.emit("item/started", child, { item: childAgent });
    events.emit("turn/started", grandchild, { parentToolCallId: nestedParent });
    const commands = smoke ? 32 : CALIBRATED_RECIPE.commands;

    const output = FIXTURE_RECIPE.unicodeOutputLine.repeat(
      CALIBRATED_RECIPE.outputRepeats,
    );

    const delta = FIXTURE_RECIPE.unicodeOutputLine.repeat(
      CALIBRATED_RECIPE.deltaRepeats,
    );

    for (let index = 0; index < commands; index += 1) {
      const depth = Math.floor((index * 3) / commands);
      const turn = depth === 0 ? root : depth === 1 ? child : grandchild;

      const parentId =
        depth === 0 ? undefined : depth === 1 ? parent : nestedParent;

      events.command(
        turn,
        `calibrated-command-${index}`,
        output,
        delta,
        parentId,
      );

      if (index % CALIBRATED_RECIPE.usageEveryCommands === 0) {
        const breakdown = {
          cachedInputTokens: 0,
          inputTokens: index + 10,
          outputTokens: index + 5,
          reasoningOutputTokens: 0,
          totalTokens: index * 2 + 15,
        };

        events.emit("thread/tokenUsage/updated", turn, {
          tokenUsage: {
            total: breakdown,
            last: breakdown,
            modelContextWindow: 200_000,
          },
        });
      }
    }

    events.emit("turn/completed", grandchild, {
      status: "completed",
      parentToolCallId: nestedParent,
    });
    events.emit("item/completed", child, {
      item: {
        ...childAgent,
        status: "completed",
        result: "Inert grandchild completion",
      },
    });
    events.emit("turn/completed", child, {
      status: "completed",
      parentToolCallId: parent,
    });
    events.emit("item/completed", root, {
      item: {
        ...rootAgent,
        status: "completed",
        result: "Inert child completion",
      },
    });
    events.emit("turn/completed", root, { status: "completed" });
    const appended = events.finish();
    const totalBytes = seed.eventDataBytes + appended.bytes;

    const stored = z
      .object({ events: z.number().int(), bytes: z.number().int() })
      .parse(
        db.$client
          .prepare(
            "SELECT count(*) AS events, sum(octet_length(data)) AS bytes FROM events",
          )
          .get(),
      );

    assert.equal(stored.events, seed.events + appended.events);
    assert.equal(stored.bytes, totalBytes);

    if (!smoke) {
      assert.ok(appended.events >= 59_000 && appended.events <= 61_000);
      assert.ok(
        totalBytes >= 100 * 1024 * 1024 && totalBytes <= 125 * 1024 * 1024,
      );
      assert.ok(
        appended.lifecycleBytes / appended.bytes > 0.85 &&
          appended.lifecycleBytes / appended.bytes < 0.9,
      );
    }

    db.$client.pragma("wal_checkpoint(TRUNCATE)");

    return {
      ...seed,
      recipe: CALIBRATED_RECIPE,
      smoke,
      contentSHA256: appended.contentSHA256,
      events: seed.events + appended.events,
      eventDataBytes: totalBytes,
      calibration: {
        events: appended.events,
        lifecycleByteShare: appended.lifecycleBytes / appended.bytes,
        byType: appended.byType,
        seedContentSHA256: seed.contentSHA256,
      },
      histories: seed.histories.map((history) =>
        history.kind === "completed"
          ? {
              ...history,
              rootTurnId: root,
              childTurnId: child,
              commands: history.commands + commands,
              maxSeq: appended.maxSeq,
              events: history.events + appended.events,
              dataBytes: history.dataBytes + appended.bytes,
              latestCommandId: `calibrated-command-${commands - 1}`,
            }
          : history,
      ),
    };
  } finally {
    db.$client.close();
  }
}

export function appendCalibratedTurns(
  databasePath: string,
  fixture: ReturnType<typeof createCalibratedHistoryFixture>,
) {
  const thread = fixture.histories.find(
    (history) => history.kind === "completed",
  );

  assert.ok(thread);
  const db = initDb(databasePath);

  try {
    const events = writer({
      db,
      fixture,
      startSequence: thread.maxSeq,
      previousHash: fixture.contentSHA256,
    });

    for (
      let index = 0;
      index < CALIBRATED_RECIPE.appendedCompletedTurns;
      index += 1
    ) {
      const turn = `calibrated-after-turn-${index}`;
      events.start(turn, 2000 + index);
      events.command(
        turn,
        `calibrated-after-command-${index}`,
        `Inert new turn ${index} α🦊漢`,
        "Inert delta",
      );
      events.emit("turn/completed", turn, { status: "completed" });
    }

    events.start("calibrated-after-open", 3000);
    events.command(
      "calibrated-after-open",
      "calibrated-after-open-command",
      "Inert active result α🦊漢",
      "Inert delta",
    );
    const appended = events.finish();
    updateThread(db, noopNotifier, thread.threadId, { status: "active" });
    db.$client.pragma("wal_checkpoint(TRUNCATE)");

    return {
      ...fixture,
      events: fixture.events + appended.events,
      eventDataBytes: fixture.eventDataBytes + appended.bytes,
      contentSHA256: appended.contentSHA256,
      histories: fixture.histories.map((history) =>
        history.kind === "completed"
          ? {
              ...history,
              events: history.events + appended.events,
              dataBytes: history.dataBytes + appended.bytes,
              maxSeq: appended.maxSeq,
              commands:
                history.commands + CALIBRATED_RECIPE.appendedCompletedTurns + 1,
              latestCommandId: "calibrated-after-open-command",
            }
          : history,
      ),
    };
  } finally {
    db.$client.close();
  }
}
