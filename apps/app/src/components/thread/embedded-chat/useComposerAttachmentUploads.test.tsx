// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineComposerDraftSession } from "./useActiveComposerDraft";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { OmnyoHttpError } from "@omnyo/sdk/browser";
import { createDeferredPromise } from "@omnyo/test-helpers";
import {
  attachmentUploadTargetKey,
  movePendingAttachmentUploads,
  type CapturedAttachmentUploads,
} from "@/components/promptbox/usePendingAttachmentUploads";
import {
  useComposerAttachmentUploads,
  useDraftAttachmentUploads,
} from "./useComposerAttachmentUploads";

let projectSequence = 0;

let testProjectId = "";

beforeEach(() => {
  testProjectId = `upload-test-${++projectSequence}`;
  mocks.upload.mockReset();
});

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({ mutateAsync: mocks.upload }),
}));

function makeInlineSession(
  editSessionId: number,
  setDraft = vi.fn(),
): InlineComposerDraftSession {
  return { editSessionId, setDraft };
}

describe("useComposerAttachmentUploads", () => {
  beforeEach(() => {
    mocks.upload.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures pending files immediately, limits parallel uploads, and preserves the origin after navigation", async () => {
    const uploads = Array.from({ length: 5 }, () =>
      createDeferredPromise<PromptDraftAttachment>(),
    );

    mocks.upload.mockImplementation(
      ({ file }: { file: File }) => uploads[Number(file.name)]?.promise,
    );
    const firstTarget = { key: "first", addAttachment: vi.fn() };
    const secondTarget = { key: "second", addAttachment: vi.fn() };

    const { result, rerender, unmount } = renderHook(
      ({ target }) =>
        useDraftAttachmentUploads({ projectId: "capture-project", target }),
      {
        initialProps: { target: firstTarget },
      },
    );

    let firstBatch!: Promise<PromptDraftAttachment[]>;
    act(() => {
      firstBatch = result.current.handleAttachFiles(
        Array.from(
          { length: 4 },
          (_, index) => new File([`${index}`], `${index}`),
        ),
      );
    });
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    let captured!: CapturedAttachmentUploads | null;
    act(() => {
      captured = result.current.capturePendingUploads();
    });
    expect(result.current.pendingUploads).toHaveLength(0);
    let nextBatch!: Promise<PromptDraftAttachment[]>;
    act(() => {
      nextBatch = result.current.handleAttachFiles([new File(["next"], "4")]);
    });
    rerender({ target: secondTarget });
    unmount();
    await act(async () => {
      for (let index = 0; index < 3; index += 1)
        uploads[index]?.resolve({
          type: "localFile",
          path: `uploads/${index}`,
          name: `${index}`,
        });
      await Promise.all(uploads.slice(0, 3).map((upload) => upload.promise));
    });
    expect(mocks.upload).toHaveBeenCalledTimes(5);
    await act(async () => {
      for (let index = 3; index < 5; index += 1)
        uploads[index]?.resolve({
          type: "localFile",
          path: `uploads/${index}`,
          name: `${index}`,
        });
      await Promise.all([firstBatch, nextBatch]);
    });
    await expect(captured?.wait()).resolves.toEqual({
      attachments: Array.from({ length: 4 }, (_, index) => ({
        type: "localFile",
        path: `uploads/${index}`,
        name: `${index}`,
      })),
      error: null,
    });
    expect(firstTarget.addAttachment).toHaveBeenCalledExactlyOnceWith({
      type: "localFile",
      path: "uploads/4",
      name: "4",
    });
    expect(secondTarget.addAttachment).not.toHaveBeenCalled();
  });

  it("keeps bottom and queued attachment operations independent", async () => {
    const bottomUpload = createDeferredPromise<never>();
    const inlineUpload = createDeferredPromise<never>();
    mocks.upload
      .mockReturnValueOnce(bottomUpload.promise)
      .mockReturnValueOnce(inlineUpload.promise);
    const inline = makeInlineSession(1);
    const inlineRef = { current: inline };

    const { result } = renderHook(() =>
      useComposerAttachmentUploads({
        projectId: testProjectId,
        draftKey: "draft",
        addDraftAttachment: vi.fn(),
        inlineEditSessionId: inline.editSessionId,
        inlineSessionRef: inlineRef,
      }),
    );

    let bottomPromise!: Promise<PromptDraftAttachment[]>;
    act(() => {
      bottomPromise = result.current.handleAttachBottomFiles([
        new File(["bottom"], "bottom.txt"),
      ]);
    });
    expect(result.current.isAttachingBottomFiles).toBe(true);
    expect(result.current.isAttachingInlineFiles).toBe(false);
    expect(
      result.current.bottomPendingUploads.map((upload) => upload.file.name),
    ).toEqual(["bottom.txt"]);
    expect(result.current.inlinePendingUploads).toEqual([]);

    let inlinePromise!: Promise<PromptDraftAttachment[]>;
    act(() => {
      inlinePromise = result.current.handleAttachInlineFiles([
        new File(["inline"], "inline.txt"),
      ]);
    });
    expect(result.current.isAttachingBottomFiles).toBe(true);
    expect(result.current.isAttachingInlineFiles).toBe(true);
    expect(
      result.current.inlinePendingUploads.map((upload) => upload.file.name),
    ).toEqual(["inline.txt"]);

    await act(async () => {
      inlineUpload.reject(new Error("inline failed"));
      await inlinePromise;
    });
    expect(result.current.inlineAttachmentError).toBe(
      "Failed to attach: inline.txt",
    );
    expect(result.current.bottomAttachmentError).toBeNull();
    expect(result.current.isAttachingBottomFiles).toBe(true);
    expect(result.current.inlinePendingUploads[0]?.status).toBe("failed");
    expect(result.current.bottomPendingUploads).toHaveLength(1);

    await act(async () => {
      bottomUpload.reject(new Error("bottom failed"));
      await bottomPromise;
    });
    expect(result.current.bottomAttachmentError).toBe(
      "Failed to attach: bottom.txt",
    );
    expect(result.current.inlineAttachmentError).toBe(
      "Failed to attach: inline.txt",
    );
  });

  it("does not leak a dismissed upload into a later queued edit", async () => {
    const oldUpload = createDeferredPromise<never>();
    mocks.upload.mockReturnValueOnce(oldUpload.promise);
    const setDraft = vi.fn();
    const firstEdit = makeInlineSession(1, setDraft);

    const inlineRef: { current: InlineComposerDraftSession | null } = {
      current: firstEdit,
    };

    const { result, rerender } = renderHook(
      ({ inline }: { inline: InlineComposerDraftSession | null }) =>
        useComposerAttachmentUploads({
          projectId: testProjectId,
          draftKey: "draft",
          addDraftAttachment: vi.fn(),
          inlineEditSessionId: inline?.editSessionId ?? null,
          inlineSessionRef: inlineRef,
        }),
      {
        initialProps: {
          inline: firstEdit as InlineComposerDraftSession | null,
        },
      },
    );

    let uploadPromise!: Promise<PromptDraftAttachment[]>;
    act(() => {
      uploadPromise = result.current.handleAttachInlineFiles([
        new File(["old"], "old.txt"),
      ]);
    });
    expect(result.current.isAttachingInlineFiles).toBe(true);
    expect(result.current.inlinePendingUploads).toHaveLength(1);

    inlineRef.current = null;
    rerender({ inline: null });
    expect(result.current.isAttachingInlineFiles).toBe(false);
    expect(result.current.inlineAttachmentError).toBeNull();
    expect(result.current.inlinePendingUploads).toEqual([]);

    const secondEdit = makeInlineSession(2, setDraft);
    inlineRef.current = secondEdit;
    rerender({ inline: secondEdit });
    await act(async () => {
      oldUpload.reject(new Error("old failed"));
      await uploadPromise;
    });

    expect(result.current.isAttachingInlineFiles).toBe(false);
    expect(result.current.inlineAttachmentError).toBeNull();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "Payload Too Large",
    "HTTP 413: 413",
    "Request Entity Too Large",
  ])(
    "explains a generic 413 upload failure %j while attaching valid files",
    async (message) => {
      const uploaded: PromptDraftAttachment = {
        type: "localFile",
        path: "uploads/valid.txt",
        name: "valid.txt",
      };

      mocks.upload
        .mockRejectedValueOnce(
          new OmnyoHttpError({ body: null, code: null, message, status: 413 }),
        )
        .mockResolvedValueOnce(uploaded);
      const addAttachment = vi.fn();

      const { result } = renderHook(() =>
        useDraftAttachmentUploads({
          projectId: testProjectId,
          target: { key: "bottom", addAttachment },
        }),
      );

      await act(async () => {
        await result.current.handleAttachFiles([
          new File(["clip"], "clip.mp4"),
          new File(["valid"], "valid.txt"),
        ]);
      });

      expect(result.current.attachmentError).toContain(
        "Upload rejected as too large",
      );
      expect(result.current.attachmentError).toContain(
        "35 MiB attachment limit",
      );
      expect(addAttachment).toHaveBeenCalledExactlyOnceWith(uploaded);
    },
  );

  it.each([400, 413])(
    "shows the server's reason when it refuses an upload with %s",
    async (status) => {
      const message =
        "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.";

      mocks.upload
        .mockRejectedValueOnce(
          new OmnyoHttpError({
            body: { code: "invalid_request", message },
            code: "invalid_request",
            message,
            status,
          }),
        )
        .mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const { result } = renderHook(() =>
        useDraftAttachmentUploads({
          projectId: testProjectId,
          target: { key: "bottom", addAttachment: vi.fn() },
        }),
      );

      await act(async () => {
        await result.current.handleAttachFiles([
          new File(["heic"], "IMG_0001.heic", { type: "image/heic" }),
          new File(["png"], "shot.png", { type: "image/png" }),
        ]);
      });

      expect(result.current.attachmentError).toBe(
        `Failed to attach IMG_0001.heic, shot.png: ${message}`,
      );
    },
  );

  it("preserves the SDK's attachment-size refusal", async () => {
    mocks.upload.mockRejectedValueOnce(
      new RangeError("clip.mp4 exceeds the 35 MiB attachment limit"),
    );

    const { result } = renderHook(() =>
      useDraftAttachmentUploads({
        projectId: testProjectId,
        target: { key: "bottom", addAttachment: vi.fn() },
      }),
    );

    await act(async () => {
      await result.current.handleAttachFiles([new File(["clip"], "clip.mp4")]);
    });
    expect(result.current.attachmentError).toContain(
      "clip.mp4 exceeds the 35 MiB attachment limit",
    );
  });

  it("settles concurrent previews without the secure-context randomUUID API", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const first = createDeferredPromise<PromptDraftAttachment>();
    const concurrent = createDeferredPromise<PromptDraftAttachment>();
    const second = createDeferredPromise<PromptDraftAttachment>();
    mocks.upload
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(concurrent.promise);
    const addAttachment = vi.fn();

    const { result } = renderHook(() =>
      useDraftAttachmentUploads({
        projectId: testProjectId,
        target: { key: "bottom", addAttachment },
      }),
    );

    const file = new File(["image"], "same-name.png", { type: "image/png" });
    let batch!: Promise<PromptDraftAttachment[]>;
    let other!: Promise<PromptDraftAttachment[]>;
    act(() => {
      batch = result.current.handleAttachFiles([file, file]);
      other = result.current.handleAttachFiles([file]);
    });
    expect(
      new Set(result.current.pendingUploads.map((upload) => upload.id)).size,
    ).toBe(3);
    expect(result.current.isAttachingFiles).toBe(true);
    await act(async () => {
      first.resolve({
        type: "localImage",
        name: file.name,
        path: "uploaded.png",
        sizeBytes: 5,
      });
      await first.promise;
    });
    expect(addAttachment).toHaveBeenCalledTimes(1);
    expect(result.current.pendingUploads).toHaveLength(2);
    await act(async () => {
      concurrent.reject(new Error("Failed"));
      await other;
    });
    expect(result.current.pendingUploads).toHaveLength(2);
    await act(async () => {
      second.reject(new Error("Failed"));
      await batch;
    });
    expect(result.current.pendingUploads).toHaveLength(2);
    expect(
      result.current.pendingUploads.every(
        (upload) => upload.status === "failed",
      ),
    ).toBe(true);
    expect(result.current.isAttachingFiles).toBe(false);
  });

  it("finishes a navigated upload in its original independent draft", async () => {
    const oldUpload = createDeferredPromise<PromptDraftAttachment>();
    mocks.upload.mockReturnValueOnce(oldUpload.promise);
    const addFirstAttachment = vi.fn();
    const addSecondAttachment = vi.fn();

    const { result, rerender } = renderHook(
      ({ target }) =>
        useDraftAttachmentUploads({
          projectId: testProjectId,
          target,
        }),
      {
        initialProps: {
          target: {
            key: "edit-1",
            addAttachment: addFirstAttachment,
          } as {
            key: string;
            addAttachment: (attachment: PromptDraftAttachment) => void;
          } | null,
        },
      },
    );

    let uploadPromise!: Promise<PromptDraftAttachment[]>;
    act(() => {
      uploadPromise = result.current.handleAttachFiles([
        new File(["old"], "old.txt"),
      ]);
    });
    expect(result.current.isAttachingFiles).toBe(true);

    rerender({ target: null });
    rerender({
      target: { key: "edit-2", addAttachment: addSecondAttachment },
    });
    await act(async () => {
      oldUpload.resolve({
        type: "localFile",
        path: "uploads/old.txt",
        name: "old.txt",
        sizeBytes: 3,
      });
      await uploadPromise;
    });

    expect(addFirstAttachment).toHaveBeenCalledWith({
      type: "localFile",
      path: "uploads/old.txt",
      name: "old.txt",
      sizeBytes: 3,
    });
    expect(addSecondAttachment).not.toHaveBeenCalled();
    expect(result.current.attachmentError).toBeNull();
    expect(result.current.isAttachingFiles).toBe(false);
  });
});

describe("attachment request cancellation ownership", () => {
  it("restores failed captured files after an origin alias moves and retries the original File", async () => {
    const good: PromptDraftAttachment = {
      type: "localFile",
      path: "uploaded/good.txt",
      name: "good.txt",
    };

    const first = createDeferredPromise<PromptDraftAttachment>();
    const second = createDeferredPromise<PromptDraftAttachment>();
    mocks.upload
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const addAttachment = vi.fn();

    const { result, rerender } = renderHook(
      ({ key }) =>
        useDraftAttachmentUploads({
          projectId: testProjectId,
          target: { key, addAttachment },
        }),
      { initialProps: { key: "pending" } },
    );

    const badFile = new File(["bad"], "bad.txt");
    let pending!: Promise<PromptDraftAttachment[]>;
    let captured!: CapturedAttachmentUploads | null;
    act(() => {
      pending = result.current.handleAttachFiles([
        new File(["good"], "good.txt"),
        badFile,
      ]);
      captured = result.current.capturePendingUploads();
    });
    act(() =>
      movePendingAttachmentUploads(
        attachmentUploadTargetKey(testProjectId, "pending"),
        attachmentUploadTargetKey(testProjectId, "real"),
      ),
    );
    rerender({ key: "real" });
    await act(async () => {
      first.resolve(good);
      second.reject(new Error("refused"));
      await pending;
    });
    await expect(captured?.wait()).resolves.toEqual({
      attachments: [good],
      error: "Failed to attach: bad.txt",
    });
    act(() => {
      captured?.restore();
      captured?.restore();
    });
    expect(addAttachment).toHaveBeenCalledExactlyOnceWith(good);
    expect(result.current.pendingUploads).toHaveLength(1);
    expect(result.current.pendingUploads[0]?.file).toBe(badFile);
    expect(result.current.pendingUploads[0]?.status).toBe("failed");

    const recovered: PromptDraftAttachment = {
      type: "localFile",
      path: "uploaded/bad.txt",
      name: "bad.txt",
    };

    mocks.upload.mockResolvedValueOnce(recovered);
    await act(async () => {
      result.current.pendingUploads[0]?.retry?.();
      await Promise.resolve();
    });
    expect(mocks.upload.mock.calls[2]?.[0].file).toBe(badFile);
    expect(addAttachment).toHaveBeenLastCalledWith(recovered);
    expect(result.current.pendingUploads).toEqual([]);
  });
  it("aborts active and queued uploads on cancellation without starting queued bytes", async () => {
    mocks.upload.mockReset();
    mocks.upload.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        ),
    );
    const addAttachment = vi.fn();

    const { result } = renderHook(() =>
      useDraftAttachmentUploads({
        projectId: testProjectId,
        target: { key: "draft", addAttachment },
      }),
    );

    let pending!: Promise<PromptDraftAttachment[]>;
    act(() => {
      pending = result.current.handleAttachFiles([
        new File(["a"], "a.txt"),
        new File(["b"], "b.txt"),
        new File(["c"], "c.txt"),
        new File(["d"], "d.txt"),
      ]);
    });
    expect(result.current.pendingUploads).toHaveLength(4);
    expect(result.current.pendingUploads[0]?.cancel).toEqual(
      expect.any(Function),
    );
    act(() => {
      for (const upload of [...result.current.pendingUploads].reverse())
        upload.cancel?.();
    });
    await act(async () => {
      await pending;
    });
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    expect(addAttachment).not.toHaveBeenCalled();
    expect(result.current.pendingUploads).toEqual([]);
    expect(result.current.attachmentError).toBeNull();
  });

  it("keeps an unclaimed upload alive across navigation and unmount", async () => {
    const uploaded = createDeferredPromise<PromptDraftAttachment>();
    let capturedSignal: AbortSignal | undefined;
    mocks.upload.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      capturedSignal = signal;

      return uploaded.promise;
    });
    const addAttachment = vi.fn();

    const { result, rerender, unmount } = renderHook(
      ({ active }) =>
        useDraftAttachmentUploads({
          projectId: testProjectId,
          target: active ? { key: "draft", addAttachment } : null,
        }),
      { initialProps: { active: true } },
    );

    let pending!: Promise<PromptDraftAttachment[]>;
    act(() => {
      pending = result.current.handleAttachFiles([new File(["a"], "a.txt")]);
    });
    rerender({ active: false });
    unmount();
    expect(capturedSignal?.aborted).toBe(false);

    const attachment: PromptDraftAttachment = {
      type: "localFile",
      path: "uploaded/a.txt",
      name: "a.txt",
    };

    await act(async () => {
      uploaded.resolve(attachment);
      await pending;
    });
    expect(addAttachment).toHaveBeenCalledWith(attachment);
  });
});
