// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadQueuedMessage } from "@omnyo/domain";
import { makeThreadQueuedMessage } from "@omnyo/test-helpers/domain-fixtures";
import {
  ActionHistoryProvider,
  useActionHistory,
} from "@/components/layout/ActionHistoryProvider";
import { useQueuedMessageActions } from "./useQueuedMessageActions";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";
import { queuedInputToDraft } from "@omnyo/client-core";
import { OmnyoHttpError } from "@/lib/sdk";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  delete: vi.fn(),
  restore: vi.fn(),
  reorder: vi.fn(),
  groupBoundary: vi.fn(),
  update: vi.fn(),
  toastSuccess: vi.fn(),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useDeleteThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.delete,
  }),
  useRestoreThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.restore,
  }),
  useReorderThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.reorder,
  }),
  useSetThreadQueuedMessageGroupBoundary: () => ({
    isPending: false,
    mutateAsync: mocks.groupBoundary,
  }),
  useSendThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.send,
  }),
  useUpdateThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.update,
  }),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    success: mocks.toastSuccess,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
  },
}));

function queued(
  id: string,
  overrides: Partial<ThreadQueuedMessage> = {},
): ThreadQueuedMessage {
  return makeThreadQueuedMessage({
    id,
    threadId: "thr_1",
    content: [{ type: "text", text: id, mentions: [] }],
    ...overrides,
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return <ActionHistoryProvider>{children}</ActionHistoryProvider>;
}

function renderActions(queuedMessages: readonly ThreadQueuedMessage[]) {
  return renderHook(
    () => ({
      actions: useQueuedMessageActions({
        threadId: "thr_1",
        queuedMessages,
        sendProcessingPersistence: "clear-on-settle",
        inlineEditingQueuedMessage: null,
        dismissInlineQueuedMessageEditor: () => {},
        activeComposerDraftInput: [],
      }),
      history: useActionHistory(),
    }),
    { wrapper },
  );
}

describe("useQueuedMessageActions history", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.restore.mockResolvedValue(queued("qmsg_b"));
  });

  it("keeps a newer queued editor open when an earlier save finishes", async () => {
    const message = queued("qmsg_a");
    const dismiss = vi.fn();
    let finishSave: ((value: ThreadQueuedMessage) => void) | undefined;
    mocks.update.mockReturnValue(
      new Promise<ThreadQueuedMessage>((resolve) => {
        finishSave = resolve;
      }),
    );

    const makeEdit = (editSessionId: number): InlineQueuedMessageEditState => ({
      draft: queuedInputToDraft(message.content),
      editSessionId,
      expectedUpdatedAt: message.updatedAt,
      model: message.model,
      ownerThreadId: message.threadId,
      permissionMode: message.permissionMode,
      queuedMessageId: message.id,
      queuedMessageIndex: 0,
      reasoningLevel: message.reasoningLevel,
      serviceTier: message.serviceTier,
    });

    const { result, rerender } = renderHook(
      ({ edit }) =>
        useQueuedMessageActions({
          threadId: "thr_1",
          queuedMessages: [message],
          sendProcessingPersistence: "clear-on-settle",
          inlineEditingQueuedMessage: edit,
          dismissInlineQueuedMessageEditor: dismiss,
          activeComposerDraftInput: message.content,
        }),
      { wrapper, initialProps: { edit: makeEdit(1) } },
    );

    let saving: Promise<void> | undefined;
    act(() => {
      saving = result.current.handleSaveInlineQueuedMessage();
    });
    rerender({ edit: makeEdit(2) });
    await act(async () => {
      finishSave?.(message);
      await saving;
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("stays quiet when the server already sent or removed the queued message", async () => {
    mocks.send.mockRejectedValue(
      new OmnyoHttpError({
        status: 404,
        code: "invalid_request",
        message: "Queued message not found",
        body: { code: "invalid_request", message: "Queued message not found" },
      }),
    );
    const { result } = renderActions([queued("qmsg_a")]);
    await act(async () => {
      await result.current.actions.sendQueuedMessageById({
        guard: "exists",
        messageId: "qmsg_a",
        mode: "auto",
      });
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("never sends placeholder ids or uses them as reorder neighbors", async () => {
    const placeholder = "optimistic-queued-pending";
    const { result } = renderActions([queued("qmsg_a"), queued(placeholder)]);
    await act(async () => {
      await result.current.actions.sendQueuedMessageById({
        guard: "none",
        messageId: placeholder,
        mode: "steer",
      });
      result.current.actions.handleDeleteQueuedMessage(placeholder);
      result.current.actions.handleReorderQueuedMessage({
        queuedMessageId: "qmsg_a",
        previousQueuedMessageId: placeholder,
        nextQueuedMessageId: null,
      });
      result.current.actions.handleSetQueuedMessageGroupBoundary({
        expectedGroupedPrefixQueuedMessageIds: ["qmsg_a"],
        groupBoundaryQueuedMessageId: placeholder,
      });
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.reorder).not.toHaveBeenCalled();
    expect(mocks.groupBoundary).not.toHaveBeenCalled();
  });

  it("restores a deleted scheduled message on undo and deletes it again on redo", async () => {
    mocks.delete.mockResolvedValue("deleted");

    const { result } = renderActions([
      queued("qmsg_a"),
      queued("qmsg_b", { sendAt: 4_000_000_000_000 }),
    ]);

    act(() => result.current.actions.handleDeleteQueuedMessage("qmsg_b"));
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Scheduled message deleted",
      expect.objectContaining({
        undo: expect.any(Function),
      }),
    );

    await act(() => result.current.history.undo());
    expect(mocks.restore).toHaveBeenCalledWith({
      id: "thr_1",
      queuedMessageId: "qmsg_b",
    });

    await act(() => result.current.history.redo());
    expect(mocks.delete).toHaveBeenCalledTimes(2);
  });

  it("withdraws the Undo entry and toast when the message was already gone", async () => {
    mocks.delete.mockResolvedValue("missing");
    const { result } = renderActions([queued("qmsg_a")]);

    act(() => result.current.actions.handleDeleteQueuedMessage("qmsg_a"));
    await waitFor(() =>
      expect(mocks.toastDismiss).toHaveBeenCalledWith(
        "queued-message-deleted-qmsg_a",
      ),
    );
    expect(result.current.history.canUndo).toBe(false);
  });

  it("shows the deleted toast before the server answers and restores only after the delete lands", async () => {
    let finishDelete!: (outcome: "deleted") => void;

    mocks.delete.mockReturnValue(
      new Promise<"deleted">((resolve) => {
        finishDelete = resolve;
      }),
    );

    const { result } = renderActions([queued("qmsg_a")]);

    act(() => result.current.actions.handleDeleteQueuedMessage("qmsg_a"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Queued message deleted",
      expect.objectContaining({ id: "queued-message-deleted-qmsg_a" }),
    );
    expect(result.current.history.canUndo).toBe(true);

    let undoing!: Promise<unknown>;
    act(() => {
      undoing = result.current.history.undo();
    });
    await Promise.resolve();
    expect(mocks.restore).not.toHaveBeenCalled();

    await act(async () => {
      finishDelete("deleted");
      await undoing;
    });
    expect(mocks.restore).toHaveBeenCalledWith({
      id: "thr_1",
      queuedMessageId: "qmsg_a",
    });
  });

  it("withdraws the Undo entry when the delete fails", async () => {
    mocks.delete.mockRejectedValue(new Error("offline"));
    const { result } = renderActions([queued("qmsg_a")]);

    act(() => result.current.actions.handleDeleteQueuedMessage("qmsg_a"));
    expect(mocks.toastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(mocks.toastDismiss).toHaveBeenCalled());
    expect(result.current.history.canUndo).toBe(false);
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("moves a reordered message back between its original neighbors and lead group", async () => {
    mocks.reorder.mockResolvedValue([]);

    const { result } = renderActions([
      queued("qmsg_a", { groupWithNext: true }),
      queued("qmsg_b"),
      queued("qmsg_c"),
    ]);

    const request = {
      queuedMessageId: "qmsg_c",
      previousQueuedMessageId: null,
      nextQueuedMessageId: "qmsg_a",
    };

    act(() => result.current.actions.handleReorderQueuedMessage(request));
    await waitFor(() => expect(result.current.history.canUndo).toBe(true));

    await act(() => result.current.history.undo());
    expect(mocks.reorder).toHaveBeenLastCalledWith({
      id: "thr_1",
      queuedMessageId: "qmsg_c",
      previousQueuedMessageId: "qmsg_b",
      nextQueuedMessageId: null,
      groupBoundaryQueuedMessageId: "qmsg_b",
    });

    await act(() => result.current.history.redo());
    expect(mocks.reorder).toHaveBeenLastCalledWith({ ...request, id: "thr_1" });
  });

  it("restores the previous lead group when grouping is undone", async () => {
    mocks.groupBoundary.mockResolvedValue([]);
    const { result } = renderActions([queued("qmsg_a"), queued("qmsg_b")]);

    act(() =>
      result.current.actions.handleSetQueuedMessageGroupBoundary({
        expectedGroupedPrefixQueuedMessageIds: ["qmsg_a", "qmsg_b"],
        groupBoundaryQueuedMessageId: "qmsg_b",
      }),
    );
    await waitFor(() =>
      expect(result.current.history.peek("undo")?.label).toBe(
        "Group queued messages",
      ),
    );

    await act(() => result.current.history.undo());
    expect(mocks.groupBoundary).toHaveBeenLastCalledWith({
      id: "thr_1",
      expectedGroupedPrefixQueuedMessageIds: ["qmsg_a"],
      groupBoundaryQueuedMessageId: "qmsg_a",
    });
  });
});
