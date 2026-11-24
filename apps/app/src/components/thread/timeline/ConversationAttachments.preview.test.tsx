// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  buildAttachmentItems,
  ConversationAttachments,
} from "./ConversationAttachments";
import type { UserAttachmentImageSrcResolver } from "./types";

afterEach(cleanup);

function threadResolver(
  threadId: string | undefined,
): UserAttachmentImageSrcResolver {
  return (path, projectId, options) =>
    toUserAttachmentImageSrc(path, projectId, threadId, options);
}

function attachedImages(localImagePaths: string[]) {
  return {
    webImages: 0,
    localImages: localImagePaths.length,
    localFiles: 0,
    imageUrls: [],
    localImagePaths,
    localFilePaths: [],
    localFileDetails: [],
  };
}

it("loads responsive thumbnails while opening the untouched native image", async () => {
  const items = buildAttachmentItems({
    attachments: attachedImages(["photo.png"]),
    projectId: "project-1",
    text: "",
    mentions: [],
    resolveUserAttachmentImageSrc: threadResolver(undefined),
  });

  render(<ConversationAttachments {...items} projectId="project-1" />);
  const thumbnail = screen.getByRole("img", { name: "photo.png" });
  expect(thumbnail.getAttribute("src")).toContain("thumbnailWidth=160");
  expect(thumbnail.getAttribute("srcset")).toContain("thumbnailWidth=320 2x");
  expect(thumbnail.getAttribute("srcset")).toContain("thumbnailWidth=640 4x");
  fireEvent.click(thumbnail);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

  const native = within(screen.getByRole("dialog")).getByRole("img", {
    name: "photo.png",
  });

  expect(native.getAttribute("src")).toBe(
    "/api/v1/projects/project-1/attachments/content?path=photo.png",
  );
  expect(native.getAttribute("srcset")).toBeNull();
});

it("loads host-file thumbnails for absolute paths while opening the exact host file", async () => {
  const items = buildAttachmentItems({
    attachments: attachedImages(["/Users/developer/Desktop/shot.png"]),
    projectId: "project-1",
    text: "",
    mentions: [],
    resolveUserAttachmentImageSrc: threadResolver("thread-1"),
  });

  const original =
    "/api/v1/threads/thread-1/host-files/Users/developer/Desktop/shot.png";

  render(<ConversationAttachments {...items} projectId="project-1" />);
  const thumbnail = screen.getByRole("img", { name: "shot.png" });
  expect(thumbnail.getAttribute("src")).toBe(`${original}?thumbnailWidth=160`);
  expect(thumbnail.getAttribute("srcset")).toContain("thumbnailWidth=320 2x");
  fireEvent.click(thumbnail);
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

  const native = within(screen.getByRole("dialog")).getByRole("img", {
    name: "shot.png",
  });

  expect(native.getAttribute("src")).toBe(original);
  expect(native.getAttribute("srcset")).toBeNull();
});

it("uses the resolved image directly when the resolver has no smaller copy", () => {
  const items = buildAttachmentItems({
    attachments: attachedImages(["/Users/developer/Desktop/shot.png"]),
    projectId: "project-1",
    text: "",
    mentions: [],
    resolveUserAttachmentImageSrc: (path) => path,
  });

  render(<ConversationAttachments {...items} projectId="project-1" />);
  const tile = screen.getByRole("img", { name: "shot.png" });
  expect(tile.getAttribute("src")).toBe("/Users/developer/Desktop/shot.png");
  expect(tile.getAttribute("srcset")).toBeNull();
});
