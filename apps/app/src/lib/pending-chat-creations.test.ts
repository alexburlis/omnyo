// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import type { InboxSnapshot } from "@omnyo/domain";
import { QueryClient } from "@tanstack/react-query";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import type { SendThreadMessageMutationRequest } from "@/hooks/mutations/mutation-request-types";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { reserveComposerSend } from "./composer-send-queue";
import {
  createPendingChat,
  getPendingChatSnapshot,
  isRecentPendingChatHandoff,
  pendingChatHandoffComposerHeight,
  resolvePendingThreadDraftScope,
  retirePendingChatSurface,
  submitPendingChatMessage,
  reservePendingChatSubmission,
  takePendingChatHandoff,
} from "./pending-chat-creations";

const REQUEST: NewThreadComposerSubmission = {
  projectId: "project-pending",
  providerId: "codex",
  model: "original-model",
  reasoningLevel: "high",
  permissionMode: "full",
  environment: { type: "reuse", environmentId: "environment-original" },
  executionInputSources: { providerId: "explicit", model: "explicit" },
  input: [{ type: "text", text: "initial prompt", mentions: [] }],
};

const renderer = () => null;

beforeEach(() => window.sessionStorage.clear());

describe("pending chat creation", () => {
  it("preserves unknown restored descriptor work when a new chat publishes without resending the old request", async () => {
    vi.resetModules();

    const saved = {
      id: "pending_saved_opaque",
      projectId: "project-pending",
      realThreadId: "real-saved",
      futureWork: {
        requestId: "opaque-unconsumed-request",
        nested: ["keep exact data"],
      },
    };

    window.sessionStorage.setItem(
      "omnyo.pending-chats.v1",
      JSON.stringify([saved]),
    );
    const owner = await import("./pending-chat-creations");
    expect(owner.getPendingChatSnapshot(saved.id)?.realThreadId).toBe(
      saved.realThreadId,
    );
    const creation = createDeferredPromise<ThreadResponse>();
    const create = vi.fn(() => creation.promise);
    const send = vi.fn();

    const pending = owner.createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create,
      send,
      renderer,
      prepare: async () => {},
    });

    const descriptors: unknown = JSON.parse(
      window.sessionStorage.getItem("omnyo.pending-chats.v1")!,
    );

    expect(descriptors).toEqual(expect.arrayContaining([saved]));
    expect(send).not.toHaveBeenCalled();
    creation.resolve(
      makeThreadResponse({ id: "real-new-only", projectId: REQUEST.projectId }),
    );
    await pending.completion;
    expect(create).toHaveBeenCalledTimes(1);

    const after: unknown = JSON.parse(
      window.sessionStorage.getItem("omnyo.pending-chats.v1")!,
    );

    expect(after).toEqual(expect.arrayContaining([saved]));
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a reserved voice followup before typed and real-route sends through the alias", async () => {
    const queueOwner = {};
    const creation = createDeferredPromise<ThreadResponse>();
    const delivered: string[] = [];

    const send = vi.fn(async (request: SendThreadMessageMutationRequest) => {
      if (request.sendReservation === undefined)
        throw new Error("Missing reservation");
      await request.sendReservation.run(async () => {
        await request.prepareInput?.();
        const first = request.input[0];

        if (first?.type === "text") delivered.push(first.text);
      });
    });

    const pending = createPendingChat({
      queueOwner,
      request: REQUEST,
      create: () => creation.promise,
      send,
      renderer,
      prepare: async () => {},
    });

    const voiceReservation = reservePendingChatSubmission(pending.id);

    const typed = submitPendingChatMessage(pending.id, {
      ...REQUEST,
      input: [{ type: "text", text: "typed second", mentions: [] }],
    });

    creation.resolve(
      makeThreadResponse({
        id: "real-ordered-chat",
        projectId: REQUEST.projectId,
      }),
    );
    await pending.completion;

    const real = reserveComposerSend(queueOwner, "real-ordered-chat").run(
      async () => {
        delivered.push("real third");
      },
    );

    await reserveComposerSend(queueOwner, "other-chat").run(async () => {
      delivered.push("independent");
    });
    expect(delivered).toEqual(["independent"]);

    const voice = submitPendingChatMessage(pending.id, {
      ...REQUEST,
      input: [{ type: "text", text: "voice first", mentions: [] }],
      sendReservation: voiceReservation,
    });

    expect(
      getPendingChatSnapshot(pending.id)?.messages.map(
        (message) => message.input[0],
      ),
    ).toEqual([
      REQUEST.input[0],
      { type: "text", text: "voice first", mentions: [] },
      { type: "text", text: "typed second", mentions: [] },
    ]);
    await Promise.all([voice, typed, real]);
    expect(delivered).toEqual([
      "independent",
      "voice first",
      "typed second",
      "real third",
    ]);
    expect(
      send.mock.calls.every(([request]) => request.id === "real-ordered-chat"),
    ).toBe(true);
  });

  it("accepts the initial prompt and two followups before creation settles, then reserves real sends in acceptance order", async () => {
    const creation = createDeferredPromise<ThreadResponse>();
    const preparing = createDeferredPromise<void>();
    const firstSend = createDeferredPromise<void>();
    const secondSend = createDeferredPromise<void>();
    const create = vi.fn(() => creation.promise);

    const send = vi
      .fn()
      .mockReturnValueOnce(firstSend.promise)
      .mockReturnValueOnce(secondSend.promise);

    const pending = createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create,
      send,
      renderer,
      prepare: () => preparing.promise,
    });

    expect(
      resolvePendingThreadDraftScope({
        kind: "thread",
        projectId: REQUEST.projectId,
        threadId: pending.id,
      }),
    ).toEqual({
      kind: "thread",
      projectId: REQUEST.projectId,
      threadId: pending.id,
    });

    const first = submitPendingChatMessage(pending.id, {
      ...REQUEST,
      input: [{ type: "text", text: "followup one", mentions: [] }],
    });

    const second = submitPendingChatMessage(pending.id, {
      ...REQUEST,
      input: [{ type: "text", text: "followup two", mentions: [] }],
    });

    expect(
      getPendingChatSnapshot(pending.id)?.messages.map(
        (message) => message.input[0],
      ),
    ).toEqual([
      REQUEST.input[0],
      { type: "text", text: "followup one", mentions: [] },
      { type: "text", text: "followup two", mentions: [] },
    ]);
    expect(send).not.toHaveBeenCalled();

    creation.resolve(
      makeThreadResponse({
        id: "real-created-chat",
        projectId: REQUEST.projectId,
      }),
    );
    await pending.completion;
    await Promise.resolve();
    expect(
      send.mock.calls.map(([request]) => ({
        id: request.id,
        text: request.input[0].text,
        model: request.model,
      })),
    ).toEqual([
      {
        id: "real-created-chat",
        text: "followup one",
        model: "original-model",
      },
      {
        id: "real-created-chat",
        text: "followup two",
        model: "original-model",
      },
    ]);
    expect(getPendingChatSnapshot(pending.id)?.status).toBe("opening");
    expect(getPendingChatSnapshot(pending.id)?.messages).toHaveLength(3);
    firstSend.resolve();
    secondSend.resolve();
    await Promise.all([first, second]);
    preparing.resolve();
    await Promise.resolve();
    expect(getPendingChatSnapshot(pending.id)?.status).toBe("ready");
    retirePendingChatSurface(pending.id);
    expect(getPendingChatSnapshot(pending.id)?.messages).toEqual([]);
    expect(getPendingChatSnapshot(pending.id)?.realThreadId).toBe(
      "real-created-chat",
    );
    expect(
      window.sessionStorage.getItem("omnyo.pending-chats.v1"),
    ).not.toContain("initial prompt");
  });

  it("hands a started chat to its real thread exactly once", async () => {
    const pending = createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create: async () =>
        makeThreadResponse({
          id: "real-handoff-chat",
          projectId: REQUEST.projectId,
        }),
      send: vi.fn(),
      renderer,
      prepare: async () => {},
    });

    await pending.completion;

    expect(takePendingChatHandoff("real-handoff-chat")).toBe(false);

    retirePendingChatSurface(pending.id);

    expect(takePendingChatHandoff("real-other-chat")).toBe(false);
    expect(takePendingChatHandoff("real-handoff-chat")).toBe(true);
    expect(takePendingChatHandoff("real-handoff-chat")).toBe(false);
  });

  it("reports a recent handoff for about a second after the starting chat retires", async () => {
    const pending = createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create: async () =>
        makeThreadResponse({
          id: "real-recent-chat",
          projectId: REQUEST.projectId,
        }),
      send: vi.fn(),
      renderer,
      prepare: async () => {},
    });

    await pending.completion;

    expect(isRecentPendingChatHandoff("real-recent-chat")).toBe(false);

    const retiredFrom = performance.now();
    retirePendingChatSurface(pending.id);
    const retiredBy = performance.now();

    expect(isRecentPendingChatHandoff("real-recent-chat")).toBe(true);
    expect(isRecentPendingChatHandoff("real-other-chat")).toBe(false);
    expect(takePendingChatHandoff("real-recent-chat")).toBe(true);
    expect(isRecentPendingChatHandoff("real-recent-chat")).toBe(true);
    expect(
      isRecentPendingChatHandoff("real-recent-chat", retiredFrom + 999),
    ).toBe(true);
    expect(
      isRecentPendingChatHandoff("real-recent-chat", retiredBy + 1_000),
    ).toBe(false);

    retirePendingChatSurface(pending.id);

    expect(
      isRecentPendingChatHandoff("real-recent-chat", retiredBy + 1_000),
    ).toBe(false);
  });

  it("hands the starting chat's composer height to the real chat within the handoff window without consuming it", async () => {
    const pending = createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create: async () =>
        makeThreadResponse({
          id: "real-measured-chat",
          projectId: REQUEST.projectId,
        }),
      send: vi.fn(),
      renderer,
      prepare: async () => {},
    });

    await pending.completion;

    expect(pendingChatHandoffComposerHeight("real-measured-chat")).toBeNull();

    retirePendingChatSurface(pending.id, { composerHeight: 126 });
    const retiredBy = performance.now();

    expect(pendingChatHandoffComposerHeight("real-measured-chat")).toBe(126);
    expect(pendingChatHandoffComposerHeight("real-measured-chat")).toBe(126);
    expect(pendingChatHandoffComposerHeight("real-other-chat")).toBeNull();
    expect(
      pendingChatHandoffComposerHeight("real-measured-chat", retiredBy + 1_000),
    ).toBeNull();

    retirePendingChatSurface(pending.id, { composerHeight: 300 });

    expect(pendingChatHandoffComposerHeight("real-measured-chat")).toBe(126);
  });

  it("keeps rejected creation and followups recoverable without starting another creation", async () => {
    const creation = createDeferredPromise<ThreadResponse>();
    const create = vi.fn(() => creation.promise);
    const send = vi.fn();

    const pending = createPendingChat({
      queueOwner: {},
      request: REQUEST,
      create,
      send,
      renderer,
      prepare: async () => {},
    });

    const followup = submitPendingChatMessage(pending.id, {
      ...REQUEST,
      input: [{ type: "text", text: "kept followup", mentions: [] }],
    });

    const results = Promise.allSettled([pending.completion, followup]);
    creation.reject(new Error("connection lost"));
    expect((await results).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(
      getPendingChatSnapshot(pending.id)?.messages.every(
        (message) => message.status === "failed",
      ),
    ).toBe(true);
    expect(
      resolvePendingThreadDraftScope({
        kind: "thread",
        projectId: REQUEST.projectId,
        threadId: pending.id,
      }),
    ).toEqual({ kind: "new-thread" });
    expect(create).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("restores compact aliases after reload and marks unresolved destinations interrupted without replay", async () => {
    window.sessionStorage.setItem(
      "bb.pending-chats.v1",
      JSON.stringify([
        {
          id: "pending_resolved",
          projectId: "project-a",
          realThreadId: "real-a",
        },
        {
          id: "pending_unresolved",
          projectId: "project-b",
          realThreadId: null,
        },
      ]),
    );
    vi.resetModules();
    const reloaded = await import("./pending-chat-creations");
    expect(reloaded.getPendingChatSnapshot("pending_unresolved")?.status).toBe(
      "interrupted",
    );
    expect(
      reloaded.getPendingChatSnapshot("pending_resolved")?.realThreadId,
    ).toBe("real-a");
    expect(reloaded.getPendingThreadDraftTransfers()).toEqual([
      {
        from: {
          kind: "thread",
          projectId: "project-a",
          threadId: "pending_resolved",
        },
        to: { kind: "thread", projectId: "project-a", threadId: "real-a" },
      },
      {
        from: {
          kind: "thread",
          projectId: "project-b",
          threadId: "pending_unresolved",
        },
        to: { kind: "new-thread" },
      },
    ]);
  });
});

function emptyInbox(): InboxSnapshot {
  return {
    revision: "rev",
    generatedAt: 0,
    inbox: [],
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      needsYou: 0,
      inbox: 0,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

describe("pending chats in the Inbox", () => {
  function startChat(
    request: NewThreadComposerSubmission,
    creation: Promise<ThreadResponse>,
  ) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, emptyInbox());

    const pending = createPendingChat({
      queueOwner: queryClient,
      request,
      create: () => creation,
      send: vi.fn(),
      renderer,
      prepare: async () => {},
    });

    return {
      pending,
      lists: () => {
        const snapshot = readPredictedInboxSnapshot(queryClient);

        return {
          running: snapshot?.running.map((entry) => entry.threadId),
          waiting: snapshot?.waiting.map((entry) => entry.threadId),
          counts: snapshot?.counts,
        };
      },
    };
  }

  it("shows a starting chat as running at once, under its real id once created", async () => {
    const creation = createDeferredPromise<ThreadResponse>();
    const { pending, lists } = startChat(REQUEST, creation.promise);

    expect(lists()).toMatchObject({
      running: [pending.id],
      waiting: [],
      counts: { running: 1 },
    });

    creation.resolve(
      makeThreadResponse({ id: "real-inbox-chat", projectId: "p" }),
    );
    await pending.completion;

    expect(lists().running).toEqual(["real-inbox-chat"]);
  });

  it("removes the starting chat when creation fails", async () => {
    const creation = createDeferredPromise<ThreadResponse>();
    const { pending, lists } = startChat(REQUEST, creation.promise);

    creation.reject(new Error("offline"));
    await expect(pending.completion).rejects.toThrow("offline");

    expect(lists()).toMatchObject({ running: [], waiting: [] });
  });

  it("shows a chat scheduled for later as waiting for its send time", () => {
    const sendAt = Date.now() + 3_600_000;
    const creation = createDeferredPromise<ThreadResponse>();

    const { pending, lists } = startChat(
      { ...REQUEST, sendAt },
      creation.promise,
    );

    expect(lists()).toMatchObject({
      running: [],
      waiting: [pending.id],
      counts: { waiting: 1, nextBackAt: sendAt },
    });
  });

  it("does not show a chat saved as a draft as running", () => {
    const creation = createDeferredPromise<ThreadResponse>();

    const { lists } = startChat(
      {
        ...REQUEST,
        pluginSubmission: { pluginId: "drafts", data: { kind: "draft" } },
        expectedPluginWait: {
          kind: "plugin",
          pluginId: "drafts",
          reason: "Draft",
        },
      },
      creation.promise,
    );

    expect(lists()).toMatchObject({ running: [], waiting: [] });
  });

  it("keeps the held hint out of the create request and forwards it with follow-ups", async () => {
    const create = vi.fn(async () =>
      makeThreadResponse({ id: "real-held-chat", projectId: "p" }),
    );

    const send = vi.fn(async () => {});

    const expectedPluginWait = {
      kind: "plugin" as const,
      pluginId: "drafts",
      reason: "Draft",
    };

    const pending = createPendingChat({
      queueOwner: {},
      request: { ...REQUEST, expectedPluginWait },
      create,
      send,
      renderer,
      prepare: async () => {},
    });

    await pending.completion;
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPluginWait }),
      { onStaged: undefined, pendingChatId: pending.id },
    );

    await submitPendingChatMessage(pending.id, {
      ...REQUEST,
      expectedPluginWait,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "real-held-chat", expectedPluginWait }),
    );
  });
});
