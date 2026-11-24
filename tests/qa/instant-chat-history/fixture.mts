import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";
import {
  createProject,
  createThread,
  createEnvironment,
  deriveStoredEventItemFields,
  insertEvents,
  noopNotifier,
  upsertHost,
} from "../../../packages/db/src/index.ts";
import {
  encodeClientTurnRequestIdNumber,
  parseStoredThreadEvent,
  threadScope,
  turnScope,
  type ThreadEventType,
  type JsonObject,
} from "../../../packages/domain/src/index.ts";
import { initDb } from "../../../apps/server/src/db.ts";

export const FIXTURE_RECIPE = {
  version: 1,
  completedEventDataBytes: 101 * 1024 * 1024,
  openEventDataBytes: 9 * 1024 * 1024,
  unicodeOutputLine: "Inert fixture α🦊漢 output; no command is executed.\n",
  outputRepeats: 256,
  nestedCommands: 32,
  epochMs: 1_700_000_000_000,
};

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

export function createHistoryFixture(databasePath: string, smoke = false) {
  const db = initDb(databasePath);

  try {
    const host = upsertHost(db, noopNotifier, {
      name: "Inert history fixture",
    });

    const { project } = createProject(db, noopNotifier, {
      name: "Inert history fixture",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/inert-history-fixture",
      },
    });

    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/inert-history-fixture",
      status: "ready",
      isGitRepo: false,
      providerOwnsPath: false,
    });

    const contentHash = createHash("sha256");
    const histories = [];

    const output = FIXTURE_RECIPE.unicodeOutputLine.repeat(
      FIXTURE_RECIPE.outputRepeats,
    );

    for (const kind of ["completed", "open"] as const) {
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        title: `Inert ${kind} history`,
        status: kind === "completed" ? "idle" : "active",
      });

      let sequence = 0;
      let dataBytes = 0;
      let commands = 0;
      let batch: Array<Parameters<typeof insertEvents>[2][number]> = [];

      function flush() {
        if (batch.length === 0) return;
        const inserted = insertEvents(db, noopNotifier, batch);
        assert.equal(inserted.insertedCount, batch.length);
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
          turnId === null ? null : `inert-${kind}-provider`;

        const parsed = parseStoredThreadEvent({
          type,
          scope,
          data,
          providerThreadId,
          threadId: thread.id,
        });

        const serialized = JSON.stringify(data);
        dataBytes += Buffer.byteLength(serialized);
        contentHash.update(
          JSON.stringify([kind, sequence, type, turnId, serialized]) + "\n",
        );
        batch.push({
          threadId: thread.id,
          environmentId: environment.id,
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

      const root = `${kind}-root`;

      const requestId = encodeClientTurnRequestIdNumber({
        value: kind === "completed" ? 1 : 2,
      });

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
            text: `Inert ${kind} Unicode α🦊漢 history`,
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
      emit("turn/started", root, {});
      emit("turn/input/accepted", root, { clientRequestId: requestId });

      function command(
        turnId: string,
        index: number,
        parentToolCallId?: string,
      ) {
        const id = `${kind}-command-${index}`;

        const item = {
          type: "commandExecution",
          id,
          command: `inert fixture ${index}`,
          cwd: "/inert-history-fixture",
          approvalStatus: null,
        };

        const parentedItem =
          parentToolCallId === undefined ? item : { ...item, parentToolCallId };

        emit("item/started", turnId, {
          item: { ...parentedItem, status: "pending" },
        });
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

      const target = smoke
        ? 16 * 1024
        : kind === "completed"
          ? FIXTURE_RECIPE.completedEventDataBytes
          : FIXTURE_RECIPE.openEventDataBytes;

      while (dataBytes < target) command(root, commands++);
      const parentToolCallId = `${kind}-delegate`;

      const agent = {
        type: "toolCall",
        id: parentToolCallId,
        tool: "Agent",
        arguments: {
          prompt: "Inert nested fixture",
          subagent_type: "general-purpose",
        },
        status: "pending",
      };

      emit("item/started", root, { item: agent });
      const child = `${kind}-child`;
      emit("turn/started", child, { parentToolCallId });

      for (
        let index = 0;
        index < (smoke ? 1 : FIXTURE_RECIPE.nestedCommands);
        index += 1
      )
        command(child, commands++, parentToolCallId);

      if (kind === "completed") {
        emit("turn/completed", child, {
          status: "completed",
          parentToolCallId,
        });
        emit("item/completed", root, {
          item: {
            ...agent,
            status: "completed",
            result: "Inert nested completion",
          },
        });
        emit("turn/completed", root, { status: "completed" });
      }

      flush();
      histories.push({
        kind,
        threadId: thread.id,
        rootTurnId: root,
        childTurnId: child,
        events: sequence,
        dataBytes,
        commands,
        maxSeq: sequence,
        latestCommandId: `${kind}-command-${commands - 1}`,
      });
    }

    const eventDataBytes = histories.reduce(
      (sum, history) => sum + history.dataBytes,
      0,
    );

    if (!smoke) assert.ok(eventDataBytes >= 100 * 1024 * 1024);

    const stored = z
      .object({ events: z.number().int(), bytes: z.number().int() })
      .parse(
        db.$client
          .prepare(
            "SELECT count(*) AS events, sum(octet_length(data)) AS bytes FROM events",
          )
          .get(),
      );

    assert.equal(stored.bytes, eventDataBytes);
    db.$client.pragma("wal_checkpoint(TRUNCATE)");

    return {
      recipe: FIXTURE_RECIPE,
      smoke,
      projectId: project.id,
      environmentId: environment.id,
      hostId: host.id,
      histories,
      events: stored.events,
      eventDataBytes,
      contentSHA256: contentHash.digest("hex"),
    };
  } finally {
    db.$client.close();
  }
}
