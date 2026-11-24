// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OmnyoHttpError } from "@/lib/sdk";
import { usePendingAttachmentUploads } from "./usePendingAttachmentUploads";

const mocks = vi.hoisted(() => ({
  reportEmptyAttachment: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: mocks.toastError },
}));

vi.mock("@/lib/attachment-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attachment-diagnostics")>()),
  reportEmptyAttachment: mocks.reportEmptyAttachment,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const emptyMessage = "The pasted file was empty. Copy it again and paste.";

it("fails an empty file visibly and reports it without uploading", async () => {
  const key = `project\0${crypto.randomUUID()}`;
  const { result } = renderHook(() => usePendingAttachmentUploads(key));
  const upload = vi.fn();
  const empty = new File([], "image.png", { type: "image/png" });

  await act(async () => {
    await result.current.startUploads([empty], {
      upload,
      onUploaded: vi.fn(),
      rejectionReason: () => null,
    });
  });

  expect(upload).not.toHaveBeenCalled();
  expect(mocks.reportEmptyAttachment).toHaveBeenCalledWith(
    empty,
    "empty_before_upload",
  );
  expect(result.current.pendingUploads).toMatchObject([
    { status: "failed", error: emptyMessage },
  ]);
  expect(mocks.toastError).toHaveBeenCalledWith("Attachment upload failed", {
    description: `image.png: ${emptyMessage}`,
  });
});

it("reports a file the server received empty", async () => {
  const key = `project\0${crypto.randomUUID()}`;
  const { result } = renderHook(() => usePendingAttachmentUploads(key));
  const file = new File(["png"], "image.png", { type: "image/png" });

  await act(async () => {
    await result.current.startUploads([file], {
      upload: () =>
        Promise.reject(
          new OmnyoHttpError({
            body: null,
            code: "attachment_empty",
            message: "The attachment arrived empty.",
            status: 400,
          }),
        ),
      onUploaded: vi.fn(),
      rejectionReason: () => "generic",
    });
  });

  expect(mocks.reportEmptyAttachment).toHaveBeenCalledWith(
    file,
    "empty_on_server",
  );
  expect(result.current.pendingUploads).toMatchObject([
    { status: "failed", error: emptyMessage },
  ]);
});
