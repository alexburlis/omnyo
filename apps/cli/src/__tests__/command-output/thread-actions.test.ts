import { describe, expect, it, vi } from "vitest";
import * as domain from "@omnyo/domain";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  readlineMocks,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

interface RetryRequest {
  param: { id: string };
  json: { turnRequestId: string | null; sendAt: number | null; reason: string };
}

describe("omnyo thread action command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each([true, false])(
    "omnyo thread update --title-if-untitled reports whether it applied: %s",
    async (applied) => {
      const currentTitle = applied
        ? "Short generated title"
        : "My manual title";

      const update = vi.fn(async () => ({
        id: "thread-title-1",
        title: currentTitle,
        experimental_titleApplied: applied,
      }));

      stubServerApi({ "v1.threads.:id.$patch": update });

      await runCommand(
        [
          "thread",
          "update",
          "thread-title-1",
          "--title",
          "Short generated title",
          "--title-if-untitled",
        ],
        register,
      );

      expect(update).toHaveBeenCalledWith({
        param: { id: "thread-title-1" },
        json: expect.objectContaining({
          title: "Short generated title",
          experimental_titleIfUntitled: true,
        }),
      });
      expect(collectLogLines(vi.mocked(console.log))).toContain(
        applied
          ? "Thread thread-title-1 titled"
          : "Thread thread-title-1 title unchanged",
      );
      expect(collectLogLines(vi.mocked(console.log))).toContain(
        `Title: ${currentTitle}`,
      );
    },
  );

  it("omnyo thread update --title-if-untitled fails visibly without a server confirmation", async () => {
    stubServerApi({
      "v1.threads.:id.$patch": async () => ({
        id: "thread-title-unknown",
        title: "Current title",
      }),
    });

    await expect(
      runCommand(
        [
          "thread",
          "update",
          "thread-title-unknown",
          "--title",
          "Short generated title",
          "--title-if-untitled",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: The server did not confirm the title change. Check the chat title before retrying.",
    );
    expect(collectLogLines(vi.mocked(console.log))).not.toContain(
      "Thread thread-title-unknown title unchanged",
    );
  });

  it("omnyo thread archive sends the thread id from args", async () => {
    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-archive-1"],
    }));

    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "thread-archive-1"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived",
    );
  });

  it("omnyo thread archive reports related threads when cascading", async () => {
    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-child-1", "thread-archive-1"],
    }));

    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "thread-archive-1"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived (1 related thread also archived)",
    );
  });

  it("omnyo thread archive --self resolves from OMNYO_THREAD_ID", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-archive-2");

    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-archive-2"],
    }));

    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "--self"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-2" },
    });
  });

  it("omnyo thread archive prefixes failures with thread context", async () => {
    const archivePost = vi.fn(async () => {
      throw new Error("HTTP 404: missing");
    });

    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await expect(
      runCommand(["thread", "archive", "thread-archive-1"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to archive thread thread-archive-1: HTTP 404: missing",
    );
    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
  });

  it("omnyo thread unarchive --self resolves from OMNYO_THREAD_ID", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-unarchive-1");
    const unarchivePost = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.unarchive.$post": unarchivePost });

    await runCommand(["thread", "unarchive", "--self"], register);

    expect(unarchivePost).toHaveBeenCalledWith({
      param: { id: "thread-unarchive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unarchive-1 unarchived",
    );
  });

  it("omnyo thread edit-message targets the latest editable message by default", async () => {
    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));

    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      ["thread", "edit-message", "thread-edit-1", "--message", "Replacement"],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-1" },
      json: {
        operationId: expect.any(String),
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-edit-1 message replaced; workspace changes were kept",
    );
  });

  it("omnyo thread edit-message preserves an agent caller when targeting another thread", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-agent-caller");

    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));

    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      [
        "thread",
        "edit-message",
        "thread-edit-target",
        "--message",
        "Replacement",
        "--expected-request-sequence",
        "41",
      ],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-target" },
      json: expect.objectContaining({
        senderThreadId: "thread-agent-caller",
      }),
    });
  });

  it("omnyo thread edit-message accepts an explicit stale-edit guard", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-edit-self");

    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));

    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      [
        "thread",
        "edit-message",
        "--self",
        "--message",
        "Replacement",
        "--expected-request-sequence",
        "41",
        "--json",
      ],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-self" },
      json: expect.objectContaining({ expectedRequestSequence: 41 }),
    });
    expect(
      JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n")),
    ).toMatchObject({
      threadId: "thread-edit-self",
      ok: true,
      requestSequence: 43,
    });
  });

  it("omnyo thread edit-message rejects a partially numeric request sequence", async () => {
    const submitEdit = vi.fn();
    stubServerApi({ "v1.threads.:id.edit-message.$post": submitEdit });

    await expect(
      runCommand(
        [
          "thread",
          "edit-message",
          "thread-edit-1",
          "--message",
          "Replacement",
          "--expected-request-sequence",
          "41abc",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(submitEdit).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: --expected-request-sequence must be a non-negative integer.",
    );
  });

  it("omnyo thread pin sends the thread id from args", async () => {
    const pinnedThread = fixtures.makeThread({
      id: "thread-pin-1",
      projectId: "proj-1",
      providerId: "codex",
      pinnedAt: 1,
    });

    const pinPost = vi.fn(async () => pinnedThread);
    stubServerApi({ "v1.threads.:id.pin.$post": pinPost });

    await runCommand(["thread", "pin", "thread-pin-1"], register);

    expect(pinPost).toHaveBeenCalledWith({
      param: { id: "thread-pin-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-pin-1 pinned",
    );
  });

  it("omnyo thread unpin --self resolves from OMNYO_THREAD_ID", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-unpin-1");

    const unpinnedThread = fixtures.makeThread({
      id: "thread-unpin-1",
      projectId: "proj-1",
      providerId: "codex",
      pinnedAt: null,
    });

    const unpinPost = vi.fn(async () => unpinnedThread);
    stubServerApi({ "v1.threads.:id.unpin.$post": unpinPost });

    await runCommand(["thread", "unpin", "--self"], register);

    expect(unpinPost).toHaveBeenCalledWith({
      param: { id: "thread-unpin-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unpin-1 unpinned",
    );
  });

  it("omnyo thread shelve sends the thread id from args", async () => {
    const shelvedThread = fixtures.makeThread({
      id: "thread-shelve-1",
      projectId: "proj-1",
      providerId: "codex",
      shelvedAt: 1,
    });

    const shelvePost = vi.fn(async () => shelvedThread);
    stubServerApi({ "v1.threads.:id.shelve.$post": shelvePost });

    await runCommand(["thread", "shelve", "thread-shelve-1"], register);

    expect(shelvePost).toHaveBeenCalledWith({
      param: { id: "thread-shelve-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-shelve-1 shelved",
    );
  });

  it("omnyo thread unshelve --self resolves from OMNYO_THREAD_ID", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-unshelve-1");

    const unshelvedThread = fixtures.makeThread({
      id: "thread-unshelve-1",
      projectId: "proj-1",
      providerId: "codex",
      shelvedAt: null,
    });

    const unshelvePost = vi.fn(async () => unshelvedThread);
    stubServerApi({ "v1.threads.:id.unshelve.$post": unshelvePost });

    await runCommand(["thread", "unshelve", "--self"], register);

    expect(unshelvePost).toHaveBeenCalledWith({
      param: { id: "thread-unshelve-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unshelve-1 unshelved",
    );
  });

  it.each([
    {
      code: "shelve_requires_top_level",
      message: "Only top-level threads can be shelved",
    },
    {
      code: "thread_archived",
      message: "Archived threads cannot be shelved",
    },
  ])(
    "omnyo thread shelve prints the server refusal $code",
    async ({ code, message }) => {
      stubServerApi({
        "v1.threads.:id.shelve.$post": async () =>
          new Response(JSON.stringify({ code, message }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
      });

      await expect(
        runCommand(["thread", "shelve", "thread-refused-1"], register),
      ).rejects.toThrow("process.exit:1");

      expect(collectLogLines(vi.mocked(console.error))).toEqual([
        `Error: HTTP 409: ${message}`,
      ]);
    },
  );

  it("omnyo thread delete prompts before deleting", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-1",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      title: "Delete me",
      createdAt: 1,
      updatedAt: 1,
    });

    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });
    readlineMocks.question.mockResolvedValue("yes");

    await runCommand(["thread", "delete", "thread-delete-1"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
    });
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
      json: { childThreadsConfirmed: false },
    });
    expect(readlineMocks.question).toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-1 deleted",
    );
  });

  it("omnyo thread delete cancels when confirmation is declined", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-2",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });

    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });
    readlineMocks.question.mockResolvedValue("no");

    await runCommand(["thread", "delete", "thread-delete-2"], register);

    expect(deleteFn).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-2 deletion cancelled",
    );
  });

  it("omnyo thread delete --yes skips confirmation (requires explicit id)", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-3",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });

    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });

    await runCommand(
      ["thread", "delete", "thread-delete-3", "--yes"],
      register,
    );

    expect(readlineMocks.question).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-3" },
      json: { childThreadsConfirmed: false },
    });
  });

  it("omnyo thread delete forwards explicit child-thread confirmation", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-children",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });

    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });

    await runCommand(
      [
        "thread",
        "delete",
        "thread-delete-children",
        "--yes",
        "--confirm-child-threads",
      ],
      register,
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-children" },
      json: { childThreadsConfirmed: true },
    });
  });

  it.each([
    ["stop", "stop", "stopped"],
    ["compact", "compact", "context compaction requested"],
    ["clear", "context.clear", "context cleared"],
    ["cancel-plan", "plan.cancel", "exited Plan mode"],
    ["clear-goal", "goal.clear", "cleared its Goal"],
  ])(
    "omnyo thread %s posts its action without reading the thread first",
    async (command, route, output) => {
      const post = vi.fn(async () => ({ ok: true }));
      stubServerApi({ [`v1.threads.:id.${route}.$post`]: post });

      await runCommand(["thread", command, "thread-action"], register);

      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith({ param: { id: "thread-action" } });
      expect(collectLogLines(vi.mocked(console.log))).toContain(
        `Thread thread-action ${output}`,
      );
    },
  );

  it("omnyo thread retry defaults the turn and the reason at the boundary", async () => {
    const retryPost = vi.fn(async () => ({
      ok: true,
      delivery: "sent",
      turnRequestId: "creq_2222222222",
      attempt: 2,
    }));

    stubServerApi({ "v1.threads.:id.retry.$post": retryPost });

    await runCommand(["thread", "retry", "thread-retry-1"], register);

    expect(retryPost).toHaveBeenCalledWith({
      param: { id: "thread-retry-1" },
      json: { turnRequestId: null, sendAt: null, reason: "Retry" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-retry-1 retrying turn creq_2222222222 (attempt 2)",
    );
  });

  it("omnyo thread retry names the turn, the instant and the reason when asked", async () => {
    const retryPost = vi.fn(async (_request: RetryRequest) => ({
      ok: true,
      delivery: "queued",
      turnRequestId: "creq_3333333333",
      attempt: 3,
      queuedMessageId: "queued_1",
      waitingOn: { kind: "time" },
      sendAt: 1,
    }));

    stubServerApi({ "v1.threads.:id.retry.$post": retryPost });

    await runCommand(
      [
        "thread",
        "retry",
        "thread-retry-2",
        "--turn",
        "creq_3333333333",
        "--send-at",
        "10m",
        "--reason",
        "Rate limited",
      ],
      register,
    );

    const call = retryPost.mock.calls[0]?.[0];
    expect(call?.param).toEqual({ id: "thread-retry-2" });
    expect(call?.json.turnRequestId).toBe("creq_3333333333");
    expect(call?.json.reason).toBe("Rate limited");

    expect(call?.json.sendAt).toBeGreaterThan(Date.now());
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "retry of turn creq_3333333333 (attempt 3) queued",
    );
  });
});
