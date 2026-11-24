// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import type { ThreadResponse } from "@omnyo/server-contract";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import {
  attachmentUploadTargetKey,
  usePendingAttachmentUploads,
} from "@/components/promptbox/usePendingAttachmentUploads";
import type { NewThreadComposerSubmission } from "@/components/promptbox/NewThreadComposer";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { useRootComposePlacement } from "@/lib/root-compose-selection";
import { DEFAULT_THREAD_CREATION_PLACEMENT } from "@/lib/thread-creation-placement";
import { getPendingChatSnapshot } from "@/lib/pending-chat-creations";
import { resolvePendingThreadDraftScope } from "@/lib/pending-chat-creations";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { usePendingChatSubmission } from "./usePendingChatSubmission";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  navigate: vi.fn(),
  onUnopenedFailure: vi.fn(),
  isFocused: true,
  navigateAfterCreate: true,
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCreateThread: () => ({ mutateAsync: mocks.create }),
  useSendThreadMessage: () => ({ mutateAsync: mocks.send }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  prefetchThreadOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/root-compose-create-preference", () => ({
  useNavigateToThreadAfterCreatePreference: () => [mocks.navigateAfterCreate],
}));

vi.mock("./thread-detail/PendingThreadChat", () => ({
  PendingThreadChat: () => null,
}));

vi.mock("./thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: { preload: vi.fn().mockResolvedValue(undefined) },
}));

const REQUEST: NewThreadComposerSubmission = {
  projectId: "project-a",
  providerId: "codex",
  model: "model-a",
  reasoningLevel: "high",
  permissionMode: "full",
  environment: { type: "reuse", environmentId: "environment-a" },
  executionInputSources: { model: "explicit" },
  input: [{ type: "text", text: "first task", mentions: [] }],
};

const draft = getPromptDraftAccessor({ kind: "new-thread" });

function renderSubmission() {
  const { wrapper } = createQueryClientTestHarness();

  return renderHook(
    ({ projectId }) => {
      const submission = usePendingChatSubmission({
        projectId,
        isActiveSurface: mocks.isFocused,
        open: mocks.navigate,
        onUnopenedFailure: mocks.onUnopenedFailure,
      });

      const [placement, setPlacement] = useRootComposePlacement();

      return { ...submission, placement, setPlacement };
    },
    { initialProps: { projectId: REQUEST.projectId }, wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  draft.setDraft({ text: "", mentions: [], attachments: [] });
  mocks.isFocused = true;
  mocks.navigateAfterCreate = true;
});

afterEach(cleanup);

describe("usePendingChatSubmission", () => {
  it("recovers unsent pending text and files after creation fails while its view is unmounted", async () => {
    const remote = createDeferredPromise<ThreadResponse>();
    const upload = createDeferredPromise<PromptDraftAttachment>();
    mocks.create.mockReturnValue(remote.promise);
    const { result, unmount } = renderSubmission();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSubmit(REQUEST);
    });
    const pendingId = mocks.navigate.mock.calls[0]?.[0].threadId;

    const scope = {
      kind: "thread" as const,
      projectId: REQUEST.projectId,
      threadId: pendingId,
    };

    const origin = getPromptDraftAccessor(scope);

    const source = renderHook(() =>
      usePendingAttachmentUploads(
        attachmentUploadTargetKey(REQUEST.projectId, origin.storageKey),
      ),
    );

    const recovered = renderHook(() =>
      usePendingAttachmentUploads(
        attachmentUploadTargetKey(REQUEST.projectId, draft.storageKey),
      ),
    );

    const file = new File(["pending file"], "pending.txt");
    let uploading!: Promise<PromptDraftAttachment[]>;
    act(() => {
      origin.setTextAndMentions("unsent followup", []);
      draft.setTextAndMentions("newer root draft", []);
      uploading = source.result.current.startUploads([file], {
        upload: () => upload.promise,
        onUploaded: (attachment) =>
          getPromptDraftAccessor(
            resolvePendingThreadDraftScope(scope),
          ).addAttachment(attachment),
        rejectionReason: () => null,
      });
      unmount();
    });
    const rejection = expect(pending).rejects.toThrow("create failed");
    await act(async () => {
      remote.reject(new Error("create failed"));
      await rejection;
    });
    expect(draft.getCurrent().text).toBe("newer root draft\n\nunsent followup");
    expect(origin.getCurrent().text).toBe("");
    expect(recovered.result.current.pendingUploads[0]?.file).toBe(file);

    act(() => recovered.result.current.pendingUploads[0]?.cancel?.());
    await act(async () => {
      upload.reject(new Error("cancelled"));
      await uploading;
    });
    expect(recovered.result.current.pendingUploads).toHaveLength(0);
  });

  it("opens the provisional chat while uploads wait and strips local jobs before create transport", async () => {
    const upload =
      createDeferredPromise<NewThreadComposerSubmission["input"]>();

    const remote = createDeferredPromise<ThreadResponse>();
    mocks.create.mockReturnValue(remote.promise);
    const { result } = renderSubmission();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSubmit({
        ...REQUEST,
        capturedUploads: {
          files: [new File(["sample"], "sample.txt")],
          wait: vi.fn(),
          restore: vi.fn(),
        },
        prepareInput: () => upload.promise,
      });
    });

    expect(mocks.navigate).toHaveBeenCalledWith({
      projectId: REQUEST.projectId,
      threadId: expect.stringMatching(/^pending_/),
    });
    await act(async () => {});
    expect(mocks.create).not.toHaveBeenCalled();

    const preparedInput: NewThreadComposerSubmission["input"] = [
      { type: "text", text: "prepared attachment input", mentions: [] },
    ];

    await act(async () => upload.resolve(preparedInput));
    expect(mocks.create).toHaveBeenCalledWith({
      ...REQUEST,
      input: preparedInput,
      ...DEFAULT_THREAD_CREATION_PLACEMENT,
      outbox: {
        onStaged: undefined,
        pendingChatId: expect.stringMatching(/^pending_/u),
      },
    });
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty("prepareInput");
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty(
      "capturedUploads",
    );
    await act(async () => {
      remote.resolve(
        makeThreadResponse({
          id: "created-after-upload",
          projectId: REQUEST.projectId,
        }),
      );
      await pending;
    });
  });

  it("opens a real provisional chat synchronously while spawn remains unresolved", async () => {
    const remote = createDeferredPromise<ThreadResponse>();
    mocks.create.mockReturnValue(remote.promise);
    const { result } = renderSubmission();
    act(() =>
      result.current.setPlacement({ sectionId: "section-a", pinned: true }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSubmit({ ...REQUEST, sendAt: 123 });
    });

    const destination = mocks.navigate.mock.calls[0]?.[0];
    expect(destination).toEqual({
      projectId: REQUEST.projectId,
      threadId: expect.stringMatching(/^pending_/),
    });
    expect(
      getPendingChatSnapshot(destination.threadId)?.messages[0]?.input,
    ).toEqual(REQUEST.input);
    expect(result.current.placement).toEqual(DEFAULT_THREAD_CREATION_PLACEMENT);
    await act(async () => {});
    expect(mocks.create).toHaveBeenCalledWith({
      ...REQUEST,
      sendAt: 123,
      sectionId: "section-a",
      pinned: true,
      outbox: {
        onStaged: undefined,
        pendingChatId: expect.stringMatching(/^pending_/u),
      },
    });
    act(() =>
      result.current.setPlacement({ sectionId: "next-section", pinned: false }),
    );
    await act(async () => {
      remote.resolve(
        makeThreadResponse({ id: "created-a", projectId: REQUEST.projectId }),
      );
      await pending;
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(result.current.placement).toEqual({
      sectionId: "next-section",
      pinned: false,
    });
  });

  it.each(["project", "focus", "draft", "preference", "unmount"])(
    "does not hijack the view for an old callback after a %s change",
    async (change) => {
      const remote = createDeferredPromise<ThreadResponse>();
      mocks.create.mockReturnValue(remote.promise);
      const { result, rerender, unmount } = renderSubmission();
      const capturedSubmit = result.current.handleSubmit;
      act(() => {
        if (change === "focus") mocks.isFocused = false;

        if (change === "preference") mocks.navigateAfterCreate = false;

        if (change === "draft") draft.setTextAndMentions("next task", []);
        rerender({
          projectId: change === "project" ? "project-b" : REQUEST.projectId,
        });

        if (change === "unmount") unmount();
      });
      let pending!: Promise<void>;
      act(() => {
        pending = (
          change === "preference" ? result.current.handleSubmit : capturedSubmit
        )(REQUEST);
      });
      await act(async () => {
        remote.resolve(
          makeThreadResponse({ id: "created-a", projectId: REQUEST.projectId }),
        );
        await pending;
      });
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );

  it("keeps a newer placement when a captured transcript submits later", async () => {
    const remote = createDeferredPromise<ThreadResponse>();
    mocks.create.mockReturnValue(remote.promise);
    const { result } = renderSubmission();
    act(() =>
      result.current.setPlacement({ sectionId: "voice-section", pinned: true }),
    );
    const capturedSubmit = result.current.handleSubmit;
    act(() =>
      result.current.setPlacement({ sectionId: "next-section", pinned: false }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = capturedSubmit(REQUEST);
    });
    await act(async () => {});
    expect(mocks.create).toHaveBeenCalledWith({
      ...REQUEST,
      sectionId: "voice-section",
      pinned: true,
      outbox: {
        onStaged: undefined,
        pendingChatId: expect.stringMatching(/^pending_/u),
      },
    });
    expect(result.current.placement).toEqual({
      sectionId: "next-section",
      pinned: false,
    });
    await act(async () => {
      remote.resolve(
        makeThreadResponse({ id: "created-a", projectId: REQUEST.projectId }),
      );
      await pending;
    });
  });

  it("reports a failed chat that never opened so its frame can say so", async () => {
    const remote = createDeferredPromise<ThreadResponse>();
    mocks.navigateAfterCreate = false;
    mocks.create.mockReturnValue(remote.promise);

    const { result } = renderSubmission();
    let pending!: Promise<void>;

    act(() => {
      pending = result.current.handleSubmit(REQUEST);
    });

    const rejection = expect(pending).rejects.toThrow("create failed");

    await act(async () => {
      remote.reject(new Error("create failed"));
      await rejection;
    });

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.onUnopenedFailure).toHaveBeenCalledOnce();
  });

  it("leaves a failed chat to its opened view", async () => {
    const remote = createDeferredPromise<ThreadResponse>();
    mocks.create.mockReturnValue(remote.promise);

    const { result } = renderSubmission();
    let pending!: Promise<void>;

    act(() => {
      pending = result.current.handleSubmit(REQUEST);
    });

    const rejection = expect(pending).rejects.toThrow("create failed");

    await act(async () => {
      remote.reject(new Error("create failed"));
      await rejection;
    });

    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.onUnopenedFailure).not.toHaveBeenCalled();
  });
});
