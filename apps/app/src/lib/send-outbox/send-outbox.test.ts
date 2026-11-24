import type { PromptDraftAttachment } from "@omnyo/client-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ws", () => ({
  wsManager: {
    onConnected: () => () => undefined,
    onResumed: () => () => undefined,
  },
}));

import { buildOutboxMessageInput } from "./send-outbox";

describe("buildOutboxMessageInput", () => {
  it("stages the bytes of uploaded files under a token and leaves files without bytes on their path", async () => {
    const withBytes: PromptDraftAttachment = {
      type: "localFile",
      path: "uploads/notes-1.txt",
      name: "notes.txt",
    };

    const withoutBytes: PromptDraftAttachment = {
      type: "localFile",
      path: "uploads/restored-2.txt",
      name: "restored.txt",
    };

    const source = new File(["file bytes"], "notes.txt", {
      type: "text/plain",
    });

    const staged = await buildOutboxMessageInput({
      attachments: [withBytes, withoutBytes],
      input: [
        { type: "text", text: "see files", mentions: [] },
        { type: "localFile", path: withBytes.path, name: "notes.txt" },
        { type: "localFile", path: withoutBytes.path, name: "restored.txt" },
      ],
      sourceOf: (attachment) => (attachment === withBytes ? source : null),
    });

    const [attachment] = staged.attachments;

    expect({
      attachments: staged.attachments.map((item) => ({
        mimeType: item.mimeType,
        name: item.name,
        sizeBytes: item.sizeBytes,
        uploadedPath: item.uploadedPath,
      })),
      input: staged.input,
    }).toEqual({
      attachments: [
        {
          mimeType: "text/plain",
          name: "notes.txt",
          sizeBytes: 10,
          uploadedPath: "uploads/notes-1.txt",
        },
      ],
      input: [
        { type: "text", text: "see files", mentions: [] },
        { type: "localFile", path: attachment?.token, name: "notes.txt" },
        {
          type: "localFile",
          path: "uploads/restored-2.txt",
          name: "restored.txt",
        },
      ],
    });
  });
});
