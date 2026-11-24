// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  emptyPromptDraftState,
  serializePromptDraftStorage,
} from "@omnyo/client-core";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
});

it("keeps both source stores recoverable after a quota failure and resumes the same tab", async () => {
  const draft = { ...emptyPromptDraftState(), text: "Retained input" };
  sessionStorage.setItem("bb.composer-submission-tab.v1", "stable-tab");

  const raw = JSON.stringify([
    {
      id: "stable-request",
      scope: { kind: "new-thread" },
      draft: serializePromptDraftStorage(draft),
    },
  ]);

  localStorage.setItem("bb.composer-submissions.v1.stable-tab", raw);
  const original = Storage.prototype.setItem;

  const failure = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage)
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      original.call(this, key, value);
    });

  const journal = await import("./composer-submission-journal");
  expect(() => journal.recoverInterruptedComposerSubmissions(() => {})).toThrow(
    /quota/i,
  );
  expect(localStorage.getItem("bb.composer-submissions.v1.stable-tab")).toBe(
    raw,
  );
  expect(sessionStorage.getItem("bb.composer-submission-tab.v1")).toBe(
    "stable-tab",
  );
  failure.mockRestore();
  const restore = vi.fn();
  expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
    recovered: 1,
    failed: 0,
  });
  expect(restore).toHaveBeenCalledWith({ kind: "new-thread" }, draft);
});

it("preserves a legacy tab identity and recovers its unsent snapshot once", async () => {
  const draft = { ...emptyPromptDraftState(), text: "Unsent fixture" };
  window.sessionStorage.setItem("bb.composer-submission-tab.v1", "stable-tab");
  window.localStorage.setItem(
    "bb.composer-submissions.v1.stable-tab",
    JSON.stringify([
      {
        id: "stable-request",
        scope: { kind: "new-thread" },
        draft: serializePromptDraftStorage(draft),
      },
    ]),
  );
  const journal = await import("./composer-submission-journal");
  const restored = vi.fn();
  expect(journal.recoverInterruptedComposerSubmissions(restored)).toEqual({
    recovered: 1,
    failed: 0,
  });
  expect(restored).toHaveBeenCalledWith({ kind: "new-thread" }, draft);
  expect(
    window.sessionStorage.getItem("omnyo.composer-submission-tab.v1"),
  ).toBe("stable-tab");
  expect(journal.recoverInterruptedComposerSubmissions(restored)).toEqual({
    recovered: 0,
    failed: 0,
  });
});

it("refuses competing tab identities instead of selecting another submission journal", async () => {
  window.sessionStorage.setItem("bb.composer-submission-tab.v1", "old-tab");
  window.sessionStorage.setItem(
    "omnyo.composer-submission-tab.v1",
    "other-tab",
  );
  const journal = await import("./composer-submission-journal");
  expect(() => journal.recoverInterruptedComposerSubmissions(() => {})).toThrow(
    /conflict/i,
  );
  expect(window.sessionStorage.getItem("bb.composer-submission-tab.v1")).toBe(
    "old-tab",
  );
});

it("migrates pending destinations without creation or message replay", async () => {
  const descriptors = JSON.stringify([
    {
      id: "pending_stable",
      projectId: "project-stable",
      realThreadId: "thread-stable",
    },
  ]);

  window.sessionStorage.setItem("bb.pending-chats.v1", descriptors);
  const pending = await import("./pending-chat-creations");
  expect(pending.getPendingChatSnapshot("pending_stable")).toMatchObject({
    id: "pending_stable",
    projectId: "project-stable",
    realThreadId: "thread-stable",
    request: null,
    messages: [],
    status: "ready",
  });
  expect(window.sessionStorage.getItem("omnyo.pending-chats.v1")).toBe(
    descriptors,
  );
  expect(() => pending.reservePendingChatSubmission("pending_stable")).toThrow(
    /interrupted/i,
  );
});

it("refuses competing pending destinations and preserves both copies", async () => {
  const legacy = JSON.stringify([
    {
      id: "pending_stable",
      projectId: "project-stable",
      realThreadId: "old-thread",
    },
  ]);

  const canonical = JSON.stringify([
    {
      id: "pending_stable",
      projectId: "project-stable",
      realThreadId: "new-thread",
    },
  ]);

  window.sessionStorage.setItem("bb.pending-chats.v1", legacy);
  window.sessionStorage.setItem("omnyo.pending-chats.v1", canonical);
  const pending = await import("./pending-chat-creations");
  expect(() => pending.getPendingChatSnapshot("pending_stable")).toThrow(
    /conflict/i,
  );
  expect(window.sessionStorage.getItem("bb.pending-chats.v1")).toBe(legacy);
  expect(window.sessionStorage.getItem("omnyo.pending-chats.v1")).toBe(
    canonical,
  );
});

it("retains the recovery journal until its destination draft persists and retries without duplication", async () => {
  const journal = await import("./composer-submission-journal");
  const drafts = await import("@/hooks/usePromptDraftStorage");

  const scope = {
    kind: "new-thread",
  } satisfies import("@/hooks/usePromptDraftStorage").PromptDraftScope;

  const draft = {
    ...emptyPromptDraftState(),
    text: "Durable recovery fixture",
  };

  drafts
    .getPromptDraftAccessor(scope)
    .setDraft({ ...emptyPromptDraftState(), text: "Earlier draft" });
  journal.beginComposerSubmission({ scope, draft });
  const original = Storage.prototype.setItem;

  const failure = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("omnyo.promptbox.contents"))
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      original.call(this, key, value);
    });

  const restore = (
    destination: import("@/hooks/usePromptDraftStorage").PromptDraftScope,
    input: typeof draft,
  ) =>
    drafts.restoreFailedPromptDraft(destination, input, {
      requirePersistence: true,
    });

  expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
    recovered: 0,
    failed: 1,
  });
  failure.mockRestore();
  expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
    recovered: 1,
    failed: 0,
  });
  expect(drafts.getPromptDraftAccessor(scope).getCurrent().text).toBe(
    `Earlier draft\n\n${draft.text}`,
  );
  expect(journal.recoverInterruptedComposerSubmissions(restore)).toEqual({
    recovered: 0,
    failed: 0,
  });
});
