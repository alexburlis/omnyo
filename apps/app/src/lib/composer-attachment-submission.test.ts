// @vitest-environment jsdom

import { createDeferredPromise } from "@omnyo/test-helpers";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { describe, expect, it, vi } from "vitest";
import {
  PENDING_VOICE_TRANSCRIPT_LABEL,
  prepareComposerAttachmentSubmission,
} from "./composer-attachment-submission";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { recoverInterruptedComposerSubmissions } from "./composer-submission-journal";
import { registerPendingImageAnchorFile } from "@/components/promptbox/editor/prompt-image-anchor";
import { recordUploadedAttachmentSource } from "@/components/promptbox/usePendingAttachmentUploads";

const scope = {
  kind: "thread",
  projectId: "project-upload",
  threadId: "thread-upload",
} as const;

const attachment: PromptDraftAttachment = {
  type: "localFile",
  path: "/report.pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
};

describe("composer attachment submission", () => {
  it("shows a pending voice transcript at once and sends the transcript once ready", async () => {
    const spoken = createDeferredPromise<string>();

    const submission = prepareComposerAttachmentSubmission({
      scope,
      draft: { text: "Before", mentions: [], attachments: [] },
      uploads: null,
      pendingTranscript: () => spoken.promise,
    });

    expect(submission.input).toEqual([
      { type: "text", text: "Before", mentions: [] },
      { type: "text", text: PENDING_VOICE_TRANSCRIPT_LABEL, mentions: [] },
    ]);
    const prepared = submission.prepareInput?.();
    spoken.resolve("spoken words");
    await expect(prepared).resolves.toEqual([
      { type: "text", text: "Before spoken words", mentions: [] },
    ]);
    expect(submission.getDraft().text).toBe("Before spoken words");
    submission.complete();
  });

  it("keeps the main draft independent from a conversation and tags prepared attachment input", async () => {
    const conversationScope = { ...scope, conversationKey: "canvas:region-a" };
    const main = getPromptDraftAccessor(scope);
    const region = getPromptDraftAccessor(conversationScope);
    main.setDraft({ text: "Main draft", mentions: [], attachments: [] });
    region.setDraft({ text: "Region draft", mentions: [], attachments: [] });
    expect(main.getCurrent().text).toBe("Main draft");
    expect(region.getCurrent().text).toBe("Region draft");

    const conversation = {
      kind: "plugin",
      pluginId: "canvas",
      itemId: "conversation:region-a",
      label: "Canvas conversation",
    } as const;

    const submission = prepareComposerAttachmentSubmission({
      scope: conversationScope,
      draft: region.getCurrent(),
      conversation,
      uploads: {
        files: [new File(["report"], "report.pdf")],
        wait: async () => ({ attachments: [attachment], error: null }),
        restore: vi.fn(),
      },
    });

    expect(submission.input[0]).toEqual({
      type: "text",
      text: conversation.label,
      mentions: [{ start: 0, end: 19, resource: conversation }],
    });
    const prepared = await submission.prepareInput?.();
    expect(prepared?.[0]).toEqual(submission.input[0]);
    expect(prepared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "localFile", path: attachment.path }),
      ]),
    );
    submission.complete();
    expect(main.getCurrent().text).toBe("Main draft");
    main.setDraft({ text: "", mentions: [], attachments: [] });
    region.setDraft({ text: "", mentions: [], attachments: [] });
  });
  it("shows file-only preparation locally and journals actual attachment input before delivery", async () => {
    const uploaded = createDeferredPromise<{
      attachments: PromptDraftAttachment[];
      error: string | null;
    }>();

    const submission = prepareComposerAttachmentSubmission({
      scope,
      draft: { text: "", mentions: [], attachments: [] },
      uploads: {
        files: [new File(["report"], "report.pdf")],
        wait: () => uploaded.promise,
        restore: vi.fn(),
      },
    });

    expect(submission.input).toEqual([
      { type: "text", text: "Uploading report.pdf", mentions: [] },
    ]);
    const prepared = submission.prepareInput?.();
    uploaded.resolve({ attachments: [attachment], error: null });
    const input = await prepared;
    expect(input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "localFile", path: "/report.pdf" }),
      ]),
    );
    expect(input).not.toEqual(submission.input);
    const restore = vi.fn();
    expect(recoverInterruptedComposerSubmissions(restore)).toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(restore).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ attachments: [attachment] }),
    );
    submission.complete();
  });

  it("restores partial upload references and original file ownership on preparation failure", async () => {
    const restoreFiles = vi.fn();
    const restoreDraft = vi.fn();

    const submission = prepareComposerAttachmentSubmission({
      scope,
      draft: { text: "Review both reports", mentions: [], attachments: [] },
      uploads: {
        files: [
          new File(["first"], "report.pdf"),
          new File(["second"], "failed.pdf"),
        ],
        wait: async () => ({
          attachments: [attachment],
          error: "failed.pdf could not upload",
        }),
        restore: restoreFiles,
      },
    });

    await expect(submission.prepareInput?.()).rejects.toThrow(
      "failed.pdf could not upload",
    );
    submission.restoreFailed(restoreDraft);
    expect(restoreFiles).toHaveBeenCalledTimes(1);
    expect(restoreDraft).toHaveBeenCalledWith({
      text: "Review both reports",
      mentions: [],
      attachments: [attachment],
    });
    expect(recoverInterruptedComposerSubmissions(vi.fn())).toEqual({
      recovered: 0,
      failed: 0,
    });
  });

  it("binds a label typed while its image uploads to that image when sending", async () => {
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const pendingPath = "pending-image:batch:0";
    const text = "See [Img2] here";
    const start = text.indexOf("[Img2]");

    const uploadedImage: PromptDraftAttachment = {
      type: "localImage",
      path: "uploads/shot.png",
      name: "shot.png",
    };

    registerPendingImageAnchorFile(file, pendingPath);
    recordUploadedAttachmentSource(uploadedImage, file);

    const submission = prepareComposerAttachmentSubmission({
      scope,
      draft: {
        text,
        mentions: [
          {
            start,
            end: start + 6,
            resource: { kind: "attachment", path: pendingPath, label: "Img2" },
          },
        ],
        attachments: [],
        imageAliasHighWater: 2,
      },
      uploads: {
        files: [file],
        wait: async () => ({ attachments: [uploadedImage], error: null }),
        restore: vi.fn(),
      },
    });

    await expect(submission.prepareInput?.()).resolves.toEqual([
      {
        type: "text",
        text: "See [Img2]",
        mentions: [
          {
            start,
            end: start + 6,
            resource: {
              kind: "attachment",
              path: "uploads/shot.png",
              label: "Img2",
            },
          },
        ],
      },
      { type: "localImage", path: "uploads/shot.png" },
      { type: "text", text: " here", mentions: [] },
    ]);
    expect(submission.getDraft().attachments).toEqual([
      { ...uploadedImage, alias: "Img2" },
    ]);
    submission.complete();
  });
});
