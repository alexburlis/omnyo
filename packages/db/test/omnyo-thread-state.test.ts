import { describe, expect, it } from "vitest";
import { parseStoredThreadEvent, threadScope } from "@omnyo/domain";
import {
  createConnection,
  createProject,
  createThread,
  insertEvents,
  listLatestThreadStateEventRowsByThreadIds,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";

describe("Omnyo historical provider state", () => {
  it("selects the latest state across exact historical and current kinds without rewriting rows", () => {
    const db = createConnection(":memory:");

    try {
      migrate(db);
      const host = upsertHost(db, noopNotifier, { name: "owner" });

      const { project } = createProject(db, noopNotifier, {
        name: "project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/work/unchanged",
        },
      });

      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "stable-provider",
      });

      const input = [
        [
          1,
          "bb/session-options",
          {
            options: [
              {
                id: "mode",
                label: "User bb label",
                type: "boolean",
                value: false,
              },
            ],
          },
        ],
        [
          2,
          "core/session-options",
          {
            options: [
              {
                id: "mode",
                label: "User bb label",
                type: "boolean",
                value: true,
              },
            ],
          },
        ],
        [
          3,
          "bb/session-options",
          {
            options: [
              {
                id: "mode",
                label: "Latest bb label",
                type: "boolean",
                value: false,
              },
            ],
          },
        ],
        [4, "bb/foreign-state", { text: "Opaque bb user payload" }],
      ] as const;

      insertEvents(
        db,
        noopNotifier,
        input.map(([sequence, kind, payload]) => ({
          threadId: thread.id,
          sequence,
          type: "thread/extensionState/updated",
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          providerThreadId: "provider-stable",
          scope: threadScope(),
          data: JSON.stringify({ kind, payload }),
        })),
      );

      const before = db.$client
        .prepare("SELECT id, data, sequence FROM events ORDER BY sequence")
        .all();

      const selected = listLatestThreadStateEventRowsByThreadIds(db, {
        threadIds: [thread.id],
        kind: "core/session-options",
      });

      expect(selected.map((row) => row.sequence)).toEqual([3]);
      const row = selected[0];

      if (!row) throw new Error("Missing state");
      expect(
        parseStoredThreadEvent({
          type: row.type,
          threadId: row.threadId,
          providerThreadId: row.providerThreadId,
          scope: threadScope(),
          data: JSON.parse(row.data),
        }),
      ).toMatchObject({
        kind: "core/session-options",
        providerThreadId: "provider-stable",
        payload: {
          options: [{ id: "mode", label: "Latest bb label", value: false }],
        },
      });
      expect(
        listLatestThreadStateEventRowsByThreadIds(db, {
          threadIds: [thread.id],
          kind: "core/session-options",
          beforeSequence: 3,
        }).map((entry) => entry.sequence),
      ).toEqual([2]);
      expect(
        listLatestThreadStateEventRowsByThreadIds(db, {
          threadIds: [thread.id],
          kind: "core/foreign-state",
        }),
      ).toEqual([]);
      expect(
        db.$client
          .prepare("SELECT id, data, sequence FROM events ORDER BY sequence")
          .all(),
      ).toEqual(before);
    } finally {
      db.$client.close();
    }
  });
});
