// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PromptImageAnchorContext,
  promptAttachmentKey,
} from "./attachment-anchor-focus";
import {
  clearLocalAttachmentPreviews,
  registerLocalAttachmentPreview,
} from "@/lib/attachment-local-previews";
import { AttachmentPreview } from "./AttachmentPreview";

describe("AttachmentPreview", () => {
  const revoked: string[] = [];
  let created = 0;

  beforeEach(() => {
    created = 0;
    revoked.length = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => `blob:local-${++created}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        revoked.push(url);
      },
    });
  });

  afterEach(() => {
    cleanup();
    clearLocalAttachmentPreviews();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it.each(["image/png", "text/plain"])(
    "keeps failed %s files visible with retry and remove actions",
    (type) => {
      const retry = vi.fn();
      const cancel = vi.fn();

      const { getByRole } = render(
        <AttachmentPreview
          attachments={[]}
          pendingUploads={[
            {
              id: "failed",
              file: new File(["file"], "failed-file", { type }),
              status: "failed",
              error: "Upload refused",
              retry,
              cancel,
            },
          ]}
          expandedImageIndex={null}
          onExpandedImageIndexChange={vi.fn()}
        />,
      );

      expect(
        getByRole("status", {
          name: "Failed to upload failed-file",
        }).getAttribute("aria-description"),
      ).toBe("Upload refused");
      fireEvent.click(
        getByRole("button", { name: "Retry upload of failed-file" }),
      );
      const remove = getByRole("button", { name: "Remove failed-file" });
      expect(remove.querySelector('[data-icon="X"]')).not.toBeNull();
      expect(remove.querySelector('[data-icon="Zap"]')).toBeNull();
      fireEvent.click(remove);
      expect(retry).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("shows a local preview before upload completion and releases it on settlement", () => {
    const file = new File(["image"], "pending.png", { type: "image/png" });

    const props = {
      attachments: [],
      expandedImageIndex: null,
      onExpandedImageIndexChange: vi.fn(),
    };

    const { getByRole, queryByRole, rerender } = render(
      <AttachmentPreview
        {...props}
        pendingUploads={[{ id: "upload-1", file }]}
      />,
    );

    const status = getByRole("status", { name: "Uploading pending.png" });
    expect(status.querySelector("img")?.getAttribute("src")).toBe(
      "blob:local-1",
    );
    expect(status.textContent).toContain("Uploading");
    expect(queryByRole("button", { name: "Remove pending.png" })).toBeNull();

    rerender(<AttachmentPreview {...props} />);
    expect(queryByRole("status")).toBeNull();
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("shows an uploading file in the file pill row so finishing does not move it", () => {
    const { getByRole } = render(
      <AttachmentPreview
        attachments={[
          { type: "localFile", path: "uploads/notes.txt", name: "notes.txt" },
        ]}
        pendingUploads={[
          {
            id: "upload-1",
            file: new File(["log"], "Pasted text.txt", { type: "text/plain" }),
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
      />,
    );

    const uploading = getByRole("status", {
      name: "Uploading Pasted text.txt",
    });

    const finishedPill = getByRole("button", { name: "Remove notes.txt" })
      .parentElement?.parentElement;

    expect(uploading.parentElement).toBe(finishedPill?.parentElement);
    expect(uploading.className).toBe(finishedPill?.className);
  });

  it("keeps upload feedback in the collapsed composer and releases previews on unmount", () => {
    const props = {
      attachments: [],
      pendingUploads: [
        {
          id: "upload-1",
          file: new File(["image"], "pending.png", { type: "image/png" }),
        },
      ],
      expandedImageIndex: null,
      onExpandedImageIndexChange: vi.fn(),
    };

    const { getByRole, rerender, unmount } = render(
      <AttachmentPreview {...props} compact />,
    );

    const uploading = getByRole("status", { name: "1 uploading" });
    expect(uploading.textContent).toBe("1");
    expect(uploading.querySelector('[data-icon="Paperclip"]')).not.toBeNull();

    const attachments = [
      {
        type: "localImage" as const,
        path: "done.png",
        name: "done.png",
        sizeBytes: 5,
      },
    ];

    rerender(
      <AttachmentPreview {...props} attachments={attachments} compact />,
    );
    const mixed = getByRole("status", { name: "1 attachment, 1 uploading" });
    expect(mixed.textContent).toBe("2");
    rerender(
      <AttachmentPreview
        {...props}
        attachments={attachments}
        pendingUploads={[]}
        compact
      />,
    );
    const settled = getByRole("img", { name: "1 attachment" });
    expect(settled.querySelector('[data-icon="Loading"]')).toBeNull();
    rerender(<AttachmentPreview {...props} />);
    expect(
      getByRole("status", { name: "Uploading pending.png" }).querySelector(
        "img",
      ),
    ).not.toBeNull();
    unmount();
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("renders a just-picked image from its local object URL and revokes it on remove", () => {
    registerLocalAttachmentPreview(
      "photo-1-abc.png",
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    registerLocalAttachmentPreview(
      "notes-1-abc.txt",
      new Blob(["hi"], { type: "text/plain" }),
    );
    const onRemoveAttachment = vi.fn();

    const { getAllByRole, getByLabelText } = render(
      <AttachmentPreview
        attachmentProjectId="proj_1"
        attachments={[
          {
            type: "localImage",
            path: "photo-1-abc.png",
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "localImage",
            path: "restored-2-def.png",
            sourceProjectId: "proj_source",
            name: "restored.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    const images = getAllByRole("img");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "blob:local-1",
      "/api/v1/projects/proj_source/attachments/content?path=restored-2-def.png&thumbnailWidth=160",
    ]);
    expect(images[0]?.getAttribute("srcset")).toBeNull();
    expect(images[1]?.getAttribute("srcset")).toContain(
      "thumbnailWidth=320 2x",
    );
    expect(
      images.every((image) => image.getAttribute("decoding") === "async"),
    ).toBe(true);

    fireEvent.click(getByLabelText("Remove photo.png"));
    expect(onRemoveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ path: "photo-1-abc.png" }),
    );
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("keeps composer focus when a touch on remove synthesizes mousedown", () => {
    const onRemoveAttachment = vi.fn();

    const { getByRole } = render(
      <AttachmentPreview
        attachments={[
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "localFile",
            path: "diff.patch",
            name: "diff.patch",
            mimeType: "text/plain",
            sizeBytes: 3,
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    for (const name of ["Remove screenshot.png", "Remove diff.patch"]) {
      const removeButton = getByRole("button", { name });
      expect(fireEvent.mouseDown(removeButton, { button: 0 })).toBe(false);
      fireEvent.click(removeButton, { detail: 1 });
    }

    expect(
      onRemoveAttachment.mock.calls.map(([attachment]) => attachment.path),
    ).toEqual(["screenshot.png", "diff.patch"]);
  });

  it("separates compact touch targets from attachment remove visuals", () => {
    const { getByRole } = render(
      <AttachmentPreview
        attachments={[
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "localFile",
            path: "diff.patch",
            name: "diff.patch",
            mimeType: "text/plain",
            sizeBytes: 3,
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={() => {}}
      />,
    );

    const imageRemoveButton = getByRole("button", {
      name: "Remove screenshot.png",
    });

    expect(
      imageRemoveButton.classList.contains("max-md:pointer-coarse:size-7"),
    ).toBe(true);
    expect(imageRemoveButton.classList.contains("bg-black/55")).toBe(false);
    expect(
      imageRemoveButton.firstElementChild?.classList.contains("size-4"),
    ).toBe(true);
    expect(
      imageRemoveButton.firstElementChild?.classList.contains("bg-black/55"),
    ).toBe(true);

    const fileRemoveButton = getByRole("button", {
      name: "Remove diff.patch",
    });

    expect(
      fileRemoveButton.classList.contains("max-md:pointer-coarse:size-7"),
    ).toBe(true);
    expect(fileRemoveButton.parentElement?.classList.contains("size-4")).toBe(
      true,
    );
    expect(
      fileRemoveButton.firstElementChild?.classList.contains("size-4"),
    ).toBe(true);
  });
});

it("cancels only the selected pending file", () => {
  const cancelFirst = vi.fn();
  const cancelSecond = vi.fn();

  const { getByRole } = render(
    <AttachmentPreview
      attachments={[]}
      expandedImageIndex={null}
      onExpandedImageIndexChange={vi.fn()}
      pendingUploads={[
        {
          id: "first",
          file: new File(["first"], "first.mp4"),
          cancel: cancelFirst,
        },
        {
          id: "second",
          file: new File(["second"], "second.mp4"),
          cancel: cancelSecond,
        },
      ]}
    />,
  );

  fireEvent.click(getByRole("button", { name: "Cancel upload of first.mp4" }));
  expect(cancelFirst).toHaveBeenCalledTimes(1);
  expect(cancelSecond).not.toHaveBeenCalled();
  cleanup();
});

it("labels anchored images and pairs them with the composer highlight", () => {
  const setActiveKey = vi.fn();

  const attachment = {
    type: "localImage" as const,
    path: "shot.png",
    hostId: "host_mac",
    name: "shot.png",
    alias: "Img2",
  };

  const view = render(
    <PromptImageAnchorContext.Provider
      value={{
        activeKey: promptAttachmentKey(attachment),
        setActiveKey,
        resolve: () => ({ status: "missing" }),
      }}
    >
      <AttachmentPreview
        attachments={[attachment]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={() => {}}
      />
    </PromptImageAnchorContext.Provider>,
  );

  const thumbnail = view.getByRole("button", { name: "Img2, shot.png" });
  expect(thumbnail.className).toContain("ring-2");
  expect(view.getByRole("button", { name: "Remove Img2" })).toBeTruthy();

  fireEvent.focus(thumbnail);
  expect(setActiveKey).toHaveBeenLastCalledWith(
    promptAttachmentKey(attachment),
  );
  fireEvent.blur(thumbnail);
  expect(setActiveKey).toHaveBeenLastCalledWith(null);
});
