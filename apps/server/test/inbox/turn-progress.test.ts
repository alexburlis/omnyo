import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  events,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import type { ThreadEventItemType, ThreadEventType } from "@omnyo/domain";
import {
  progressNote,
  readTurnProgress,
} from "../../src/services/inbox/turn-progress.js";

function fixture() {
  const db: DbConnection = createConnection(":memory:");

  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "progress-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "progress-project",
    source: { type: "local_path", hostId: host.id, path: "/inert/progress" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  let sequence = 0;

  const add = (
    type: ThreadEventType,
    itemKind: ThreadEventItemType | null,
    item: Record<string, unknown> | null,
  ) => {
    sequence += 1;
    db.insert(events)
      .values({
        id: `event-${sequence}`,
        threadId: thread.id,
        sequence,
        scopeKind: "turn",
        turnId: "turn",
        type,
        itemId: item === null ? null : `item-${sequence}`,
        itemKind,
        data: JSON.stringify(item === null ? {} : { item }),
        createdAt: sequence,
      })
      .run();
  };

  const message = (text: string) =>
    add("item/completed", "agentMessage", {
      type: "agentMessage",
      id: `m${sequence}`,
      text,
    });

  const command = (title: string) =>
    add("item/started", "commandExecution", {
      type: "commandExecution",
      id: `c${sequence}`,
      command: title,
      presentation: { title },
    });

  const plan = (statuses: readonly ("pending" | "active" | "completed")[]) =>
    add("item/completed", "planSteps", {
      type: "planSteps",
      id: `p${sequence}`,
      status: "completed",
      steps: statuses.map((status, index) => ({
        step: `Step ${index + 1}`,
        status,
      })),
    });

  const turn = () => add("turn/started", null, null);

  return { db, threadId: thread.id, message, command, plan, turn };
}

describe("running chat progress", () => {
  it("shows the agent's latest note from the current turn, not an earlier one", () => {
    const chat = fixture();

    chat.turn();
    chat.message("Old turn note.");
    chat.turn();
    chat.message("**Checking the server log** before the fix.\nMore detail.");

    expect(readTurnProgress(chat.db, chat.threadId)).toEqual({
      note: "Checking the server log before the fix.",
      progress: null,
    });
  });

  it("falls back to the running command when the turn has no note yet", () => {
    const chat = fixture();

    chat.turn();
    chat.message("Old turn note.");
    chat.turn();
    chat.command("pnpm test");

    expect(readTurnProgress(chat.db, chat.threadId).note).toBe(
      "Running pnpm test",
    );
  });

  it("counts finished todo steps and drops a finished list from an earlier turn", () => {
    const chat = fixture();

    chat.turn();
    chat.plan(["completed", "active", "pending"]);
    expect(readTurnProgress(chat.db, chat.threadId).progress).toEqual({
      done: 1,
      total: 3,
    });

    chat.turn();
    expect(readTurnProgress(chat.db, chat.threadId).progress).toEqual({
      done: 1,
      total: 3,
    });

    chat.plan(["completed", "completed", "completed"]);
    expect(readTurnProgress(chat.db, chat.threadId).progress).toEqual({
      done: 3,
      total: 3,
    });

    chat.turn();
    expect(readTurnProgress(chat.db, chat.threadId)).toEqual({
      note: null,
      progress: null,
    });
  });

  it("trims a note to its first readable line", () => {
    expect(progressNote("\n\n## Plan\n- step")).toBe("Plan");
    expect(progressNote("See [the log](https://x.test) `now`")).toBe(
      "See the log now",
    );
    expect(progressNote("   \n  ")).toBeNull();
    expect(progressNote("x".repeat(400))?.length).toBe(200);
  });
});
