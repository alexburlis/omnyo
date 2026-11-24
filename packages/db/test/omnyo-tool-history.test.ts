import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parseStoredThreadEvent, turnScope } from "@omnyo/domain";
import {
  createConnection,
  events,
  createProject,
  createThread,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "../src/index.js";

it("projects only finite owned V1 tool identities without rewriting history or user values", () => {
  const db = createConnection(":memory:");

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "owner" });

    const { project } = createProject(db, noopNotifier, {
      name: "project",
      source: { type: "local_path", hostId: host.id, path: "/work/stable" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "stable-provider",
    });

    const pairs = [
      ["bb_workflow_run", "omnyo_workflow_run"],
      ["bb_workflow_result", "omnyo_workflow_result"],
    ] as const;

    const inputs = [
      ...pairs.flatMap(([tool, current]) =>
        ["pending", "completed"].map((status) => ({
          tool,
          current,
          status,
          server: "bb",
        })),
      ),
      {
        tool: "bb_workflow_run",
        current: "bb_workflow_run",
        status: "pending",
        server: "foreign",
      },
      {
        tool: "bb_custom",
        current: "bb_custom",
        status: "pending",
        server: "bb",
      },
    ];

    insertEvents(
      db,
      noopNotifier,
      inputs.map((input, index) => ({
        threadId: thread.id,
        sequence: index + 1,
        type: "item/started" as const,
        itemId: `stable-call-${index}`,
        itemKind: "toolCall" as const,
        parentToolCallId: null,
        providerThreadId: "stable-provider-thread",
        scope: turnScope("stable-turn"),
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: `stable-call-${index}`,
            tool: input.tool,
            server: input.server,
            status: input.status,
            arguments: { text: "User bb_workflow_run remains verbatim" },
            presentation: {
              label: {
                pending: "Original bb label",
                completed: "Original bb label",
              },
              icon: { glyph: "Workflow" },
            },
          },
        }),
      })),
    );

    const before = db.$client
      .prepare("SELECT id, data, sequence FROM events ORDER BY sequence")
      .all();

    for (const [index, input] of inputs.entries()) {
      const row = db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.sequence, index + 1))
        .get();

      if (row === undefined) throw new Error("Missing owned history fixture");
      const stored = JSON.parse(row.data);

      const event = parseStoredThreadEvent({
        type: "item/started",
        threadId: thread.id,
        providerThreadId: "stable-provider-thread",
        scope: turnScope("stable-turn"),
        data: stored,
      });

      expect(event).toMatchObject({
        item: {
          id: `stable-call-${index}`,
          tool: input.current,
          server: input.current === input.tool ? input.server : "omnyo",
          status: input.status,
          arguments: { text: "User bb_workflow_run remains verbatim" },
          presentation: {
            label: {
              pending: "Original bb label",
              completed: "Original bb label",
            },
          },
        },
      });
    }

    expect(
      db.$client
        .prepare("SELECT id, data, sequence FROM events ORDER BY sequence")
        .all(),
    ).toEqual(before);
  } finally {
    db.$client.close();
  }
});
