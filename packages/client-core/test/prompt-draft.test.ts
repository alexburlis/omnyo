import { describe, expect, it } from "vitest";
import type { PromptMentionResource } from "@omnyo/domain";
import {
  appendQuoteAndAttachmentsToDraft,
  appendQuoteToDraftText,
  appendStructuredQuoteToDraft,
  arePromptDraftStatesEqual,
  emptyPromptDraftState,
  isPromptDraftEmpty,
  getProjectStoredPromptAttachmentPaths,
  hasAmbiguousPromptImageAnchors,
  nextPromptImageAlias,
  parsePromptDraftStorage,
  resolvePromptImageAnchor,
  promptDraftToInput,
  promptInputToDraft,
  serializePromptDraftStorage,
  withPromptImageAliasHighWater,
} from "../src/prompt/prompt-draft.js";

describe("prompt draft helpers", () => {
  it("drops invalid legacy raw text drafts", () => {
    const parsed = parsePromptDraftStorage("Investigate flaky login redirect");
    expect(parsed).toEqual({
      text: "",
      mentions: [],
      attachments: [],
    });
  });

  it("treats a stored zero attachment size as unknown", () => {
    const parsed = parsePromptDraftStorage(
      JSON.stringify({
        text: "",
        attachments: [
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 0,
          },
        ],
      }),
    );

    expect(parsed.attachments).toEqual([
      { type: "localFile", path: "/tmp/spec.md", name: "spec.md" },
    ]);
    expect(promptDraftToInput(parsed)).toEqual([
      { type: "localFile", path: "/tmp/spec.md", name: "spec.md" },
    ]);
  });

  it("preserves portable attachments through history conversion and persisted drafts", () => {
    const input = [
      {
        type: "localImage" as const,
        path: "shot.png",
        sourceProjectId: "proj_source",
      },
      {
        type: "localFile" as const,
        path: "notes.txt",
        name: "notes.txt",
        sizeBytes: 5,
        mimeType: "text/plain",
        sourceProjectId: "proj_other",
      },
      {
        type: "localFile" as const,
        path: "/tmp/report.txt",
        name: "report.txt",
        hostId: "host_1",
      },
    ];

    const restored = parsePromptDraftStorage(
      serializePromptDraftStorage(promptInputToDraft(input)),
    );

    expect(promptDraftToInput(restored)).toEqual(input);
    expect(
      getProjectStoredPromptAttachmentPaths([
        ...restored.attachments,
        {
          type: "localFile",
          path: "legacy.txt",
          name: "legacy.txt",
          sizeBytes: 1,
        },
      ]),
    ).toEqual(["legacy.txt"]);
  });

  it("parses structured drafts with attachments", () => {
    const parsed = parsePromptDraftStorage(
      JSON.stringify({
        text: "Review",
        attachments: [
          {
            type: "localImage",
            path: "/tmp/image.png",
            name: "image.png",
            sizeBytes: 12,
            mimeType: "image/png",
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      text: "Review",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 12,
          mimeType: "image/png",
        },
      ],
    });
  });

  it("detects whether a draft has any submittable state", () => {
    expect(isPromptDraftEmpty(emptyPromptDraftState())).toBe(true);
    expect(
      isPromptDraftEmpty({
        text: "",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "/tmp/spec.md",
            name: "spec.md",
            sizeBytes: 42,
            mimeType: "text/markdown",
          },
        ],
      }),
    ).toBe(false);
  });

  it("maps draft text and attachments to prompt input list", () => {
    const input = promptDraftToInput({
      text: "  Ship this patch  ",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/image.png",
          name: "image.png",
          sizeBytes: 32,
          mimeType: "image/png",
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });

    expect(input).toEqual([
      { type: "text", text: "Ship this patch", mentions: [] },
      { type: "localImage", path: "/tmp/image.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);
  });

  it("keeps attachment mentions only while their attachment is in the draft", () => {
    const text = "Compare @Pasted text.txt with @Pasted text 2.txt";

    const attached = {
      kind: "attachment" as const,
      path: "Pasted-text-1.txt",
      label: "Pasted text.txt",
    };

    const removed = {
      kind: "attachment" as const,
      path: "Pasted-text-2.txt",
      label: "Pasted text 2.txt",
    };

    const input = promptDraftToInput({
      text,
      mentions: [
        { start: 8, end: 24, resource: attached },
        { start: 30, end: 48, resource: removed },
      ],
      attachments: [
        {
          type: "localFile",
          path: "Pasted-text-1.txt",
          name: "Pasted text.txt",
        },
      ],
    });

    expect(input[0]).toEqual({
      type: "text",
      text,
      mentions: [{ start: 8, end: 24, resource: attached }],
    });
  });

  it("sends no size for an unknown or zero-size placeholder attachment", () => {
    const input = promptDraftToInput({
      text: "",
      mentions: [],
      attachments: [
        { type: "localFile", path: "uploads/spec.md", name: "spec.md" },
        {
          type: "localFile",
          path: "uploads/plugin.md",
          name: "plugin.md",
          sizeBytes: 0,
        },
      ],
    });

    expect(input).toEqual([
      { type: "localFile", path: "uploads/spec.md", name: "spec.md" },
      { type: "localFile", path: "uploads/plugin.md", name: "plugin.md" },
    ]);
  });

  it("keeps visible mention ranges when trailing trim clips mention whitespace", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };

    const text = "  Ask @manager   ";
    const token = "@manager";
    const start = text.indexOf(token);

    if (start < 0) {
      throw new Error("Expected mention token in test text");
    }

    const input = promptDraftToInput({
      text,
      mentions: [
        {
          start,
          end: text.length,
          resource,
        },
      ],
      attachments: [],
    });

    expect(input).toEqual([
      {
        type: "text",
        text: "Ask @manager",
        mentions: [
          {
            start: "Ask ".length,
            end: "Ask @manager".length,
            resource,
          },
        ],
      },
    ]);
  });

  it("maps prompt input back to an editable draft", () => {
    const draft = promptInputToDraft([
      { type: "text", text: "Investigate", mentions: [] },
      { type: "image", url: "https://example.com/image.png" },
      { type: "localImage", path: "/tmp/screenshot.png" },
      {
        type: "localFile",
        path: "/tmp/spec.md",
        name: "spec.md",
        sizeBytes: 42,
        mimeType: "text/markdown",
      },
    ]);

    expect(draft).toEqual({
      text: "Investigate",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "/tmp/screenshot.png",
          name: "screenshot.png",
        },
        {
          type: "localFile",
          path: "/tmp/spec.md",
          name: "spec.md",
          sizeBytes: 42,
          mimeType: "text/markdown",
        },
      ],
    });
  });
});

describe("inline image anchors", () => {
  const anchor = (text: string, label: string, path: string) => {
    const start = text.indexOf(`[${label}]`);

    return {
      start,
      end: start + label.length + 2,
      resource: { kind: "attachment" as const, path, label },
    };
  };

  const shot = {
    type: "localImage" as const,
    path: "/tmp/shot.png",
    hostId: "host_mac",
    name: "shot.png",
    alias: "Img1",
  };

  const chart = {
    type: "localImage" as const,
    path: "uploads/chart.png",
    name: "chart.png",
    alias: "Img2",
  };

  it("sends each image right after its first anchor and keeps the typed text exact", () => {
    const text = "  See [Img1] then [Img2], and again [Img1]  \n";

    const input = promptDraftToInput({
      text,
      mentions: [
        anchor(text, "Img1", shot.path),
        anchor(text, "Img2", chart.path),
        {
          ...anchor(text, "Img1", shot.path),
          start: text.lastIndexOf("[Img1]"),
          end: text.lastIndexOf("[Img1]") + 6,
        },
      ],
      attachments: [
        chart,
        shot,
        { type: "localFile", path: "uploads/spec.md", name: "spec.md" },
      ],
    });

    expect(input.map((chunk) => chunk.type)).toEqual([
      "text",
      "localImage",
      "text",
      "localImage",
      "text",
      "localFile",
    ]);
    expect(input[1]).toEqual({
      type: "localImage",
      path: shot.path,
      hostId: "host_mac",
    });
    expect(
      input.flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : [])),
    ).toEqual(["See [Img1]", " then [Img2]", ", and again [Img1]"]);
    expect(input[4]).toMatchObject({
      mentions: [{ start: 12, end: 18 }],
    });
  });

  it("round-trips anchored input without adding separators", () => {
    const text = "A [Img1]\n\n  B [Img2] ";

    const draft = {
      text,
      mentions: [
        anchor(text, "Img1", shot.path),
        anchor(text, "Img2", chart.path),
      ],
      attachments: [shot, chart],
    };

    const input = promptDraftToInput(draft);
    const restored = promptInputToDraft(input);

    expect(restored.text).toBe(text.trim());
    expect(restored.mentions).toEqual(draft.mentions);
    expect(restored.attachments).toEqual([
      {
        type: "localImage",
        path: shot.path,
        hostId: "host_mac",
        name: "shot.png",
        alias: "Img1",
      },
      {
        type: "localImage",
        path: chart.path,
        name: "chart.png",
        alias: "Img2",
      },
    ]);
    expect(promptDraftToInput(restored)).toEqual(input);
  });

  it("keeps typed lookalike text and unanchored images in the legacy order", () => {
    const input = promptDraftToInput({
      text: "Typed [Img1] only",
      mentions: [],
      attachments: [shot],
    });

    expect(input).toEqual([
      { type: "text", text: "Typed [Img1] only", mentions: [] },
      { type: "localImage", path: shot.path, hostId: "host_mac" },
    ]);
    expect(promptInputToDraft(input).text).toBe("Typed [Img1] only");
  });

  it("binds an anchor to its exact alias and path, never the first path match", () => {
    const sameBytesFromProject = {
      type: "localImage" as const,
      path: shot.path,
      sourceProjectId: "prj_other",
      name: "shot.png",
      alias: "Img3",
    };

    const attachments = [shot, sameBytesFromProject];

    expect(
      resolvePromptImageAnchor(attachments, { path: shot.path, label: "Img3" }),
    ).toEqual({ status: "bound", attachment: sameBytesFromProject });
    expect(
      resolvePromptImageAnchor(
        [
          { ...shot, alias: undefined },
          { ...sameBytesFromProject, alias: undefined },
        ],
        { path: shot.path, label: "Img1" },
      ),
    ).toEqual({ status: "ambiguous" });
    expect(
      resolvePromptImageAnchor([{ ...shot, alias: undefined }], {
        path: shot.path,
        label: "Img1",
      }),
    ).toEqual({ status: "bound", attachment: { ...shot, alias: undefined } });
  });

  it("reports ambiguous legacy anchors and does not interleave them", () => {
    const text = "Look [Img1]";

    const draft = {
      text,
      mentions: [anchor(text, "Img1", shot.path)],
      attachments: [
        { ...shot, alias: undefined },
        { ...shot, hostId: "host_air", alias: undefined },
      ],
    };

    expect(hasAmbiguousPromptImageAnchors(draft)).toBe(true);
    expect(promptDraftToInput(draft).map((chunk) => chunk.type)).toEqual([
      "text",
      "localImage",
      "localImage",
    ]);
  });

  it("never reissues a label still visible in text, attachments or history", () => {
    expect(
      nextPromptImageAlias({
        text: "Earlier I said Img4 was wrong",
        attachments: [shot],
        reservedAliases: ["Img2"],
      }),
    ).toBe("Img5");
    expect(nextPromptImageAlias({ text: "", attachments: [] })).toBe("Img1");
  });

  it("raises and persists the label high-water mark without lowering it", () => {
    const labelled = withPromptImageAliasHighWater(null, {
      text: "See [Img2] and Img7",
      mentions: [],
      attachments: [shot],
    });

    expect(labelled.imageAliasHighWater).toBe(7);

    const cleared = withPromptImageAliasHighWater(labelled, {
      text: "See",
      mentions: [],
      attachments: [],
    });

    expect(cleared.imageAliasHighWater).toBe(7);
    expect(
      parsePromptDraftStorage(serializePromptDraftStorage(cleared))
        .imageAliasHighWater,
    ).toBe(7);
    expect(
      arePromptDraftStatesEqual(cleared, {
        ...cleared,
        imageAliasHighWater: 8,
      }),
    ).toBe(false);
    expect(
      nextPromptImageAlias({ text: "", attachments: [], highWater: 7 }),
    ).toBe("Img8");
    expect(
      withPromptImageAliasHighWater(null, {
        text: "plain",
        mentions: [],
        attachments: [],
      }),
    ).not.toHaveProperty("imageAliasHighWater");
  });

  it("restores the high-water mark from anchored sent input", () => {
    const text = "A [Img4]";

    const restored = promptInputToDraft(
      promptDraftToInput({
        text,
        mentions: [anchor(text, "Img4", shot.path)],
        attachments: [{ ...shot, alias: "Img4" }],
      }),
    );

    expect(restored.imageAliasHighWater).toBe(4);
  });

  it("persists the alias beside the attachment owner", () => {
    const parsed = parsePromptDraftStorage(
      serializePromptDraftStorage({
        text: "",
        mentions: [],
        attachments: [shot],
      }),
    );

    expect(parsed.attachments).toEqual([shot]);
    expect(
      parsePromptDraftStorage(
        JSON.stringify({ attachments: [{ ...shot, alias: "picture" }] }),
      ).attachments,
    ).toEqual([{ ...shot, alias: undefined }]);
  });
});

describe("appendQuoteToDraftText", () => {
  it("appends a one-line quote to an empty draft with a trailing newline", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "  hello world  ",
    );

    expect(next.text).toBe("> hello world\n");
  });

  it("prefixes each line of a multi-line quote and prefixes blank lines as `>`", () => {
    const next = appendQuoteToDraftText(
      emptyPromptDraftState(),
      "para one\n\npara two",
    );

    expect(next.text).toBe("> para one\n>\n> para two\n");
  });

  it("appends to existing text separated by a newline", () => {
    const base = { text: "existing reply", mentions: [], attachments: [] };
    const next = appendQuoteToDraftText(base, "quoted");
    expect(next.text).toBe("existing reply\n> quoted\n");
  });

  it("stacks a second quote below the first, separated by a blank line", () => {
    const first = appendQuoteToDraftText(emptyPromptDraftState(), "first");
    expect(appendQuoteToDraftText(first, "second").text).toBe(
      "> first\n\n> second\n",
    );
  });

  it("ignores an empty or whitespace-only quote", () => {
    const base = emptyPromptDraftState();
    expect(appendQuoteToDraftText(base, "")).toBe(base);
    expect(appendQuoteToDraftText(base, "   \n  ")).toBe(base);
  });

  it("leaves existing mention offsets byte-for-byte unchanged (appends to the end)", () => {
    const resource: PromptMentionResource = {
      kind: "thread",
      threadId: "thr_parent",
      label: "Prompt UX thread",
    };

    const text = "Ask @manager now";
    const start = text.indexOf("@manager");
    const mention = { start, end: start + "@manager".length, resource };
    const base = { text, mentions: [mention], attachments: [] };

    const next = appendQuoteToDraftText(base, "context");

    expect(next.mentions).toEqual([mention]);
    expect(next.text.startsWith(text)).toBe(true);
  });
});

describe("appendQuoteAndAttachmentsToDraft", () => {
  it("keeps file, skill and attachment mentions at their quoted positions", () => {
    const source =
      "  Review @spec\r\n> earlier\r\n\r\n> $verify\r\nSee @image  ";

    const resources: [string, PromptMentionResource][] = [
      [
        "@spec",
        {
          kind: "path",
          source: "workspace",
          entryKind: "file",
          path: "docs/spec.md",
          label: "spec.md",
        },
      ],
      [
        "$verify",
        {
          kind: "command",
          trigger: "$",
          name: "verify",
          source: "skill",
          origin: "project",
          label: "verify",
          argumentHint: null,
        },
      ],
      [
        "@image",
        {
          kind: "attachment",
          path: "uploads/screenshot.png",
          label: "screenshot.png",
        },
      ],
    ];

    const mentions = resources.map(([token, resource]) => ({
      resource,
      start: source.indexOf(token),
      end: source.indexOf(token) + token.length,
    }));

    const existing = {
      start: 4,
      end: 11,
      resource: { kind: "thread", threadId: "thr_manager", label: "Manager" },
    } satisfies (typeof mentions)[number];

    const next = appendStructuredQuoteToDraft(
      { text: "Ask @parent", mentions: [existing], attachments: [] },
      source,
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
        },
      ],
      mentions,
    );

    expect(next.text).toBe(
      "Ask @parent\n> Review @spec\n> > earlier\n> > $verify\n> See @image\n",
    );
    expect(next.mentions).toEqual([
      existing,
      { ...mentions[0], start: 21, end: 26 },
      { ...mentions[1], start: 43, end: 50 },
      { ...mentions[2], start: 57, end: 63 },
    ]);
    const [input] = promptDraftToInput(next);
    expect(input?.type === "text" && input.mentions).toEqual(next.mentions);
  });

  it("binds a quoted image to the existing attachment when its old alias differs", () => {
    const image = {
      type: "localImage" as const,
      path: "uploads/screenshot.png",
      name: "screenshot.png",
      alias: "Img1",
    };

    const resource = {
      kind: "attachment" as const,
      path: image.path,
      label: "Img1",
    };

    const next = appendStructuredQuoteToDraft(
      {
        text: "See [Img1]",
        mentions: [{ start: 4, end: 10, resource }],
        attachments: [image],
      },
      "Original [Img20]",
      [{ type: image.type, path: image.path, name: image.name }],
      [{ start: 9, end: 16, resource: { ...resource, label: "Img20" } }],
    );

    expect(next.text).toBe("See [Img1]\n> Original [Img1]\n");
    expect(next.mentions).toEqual([
      { start: 4, end: 10, resource },
      { start: 22, end: 28, resource },
    ]);
    expect(next.attachments).toEqual([image]);
    expect(hasAmbiguousPromptImageAnchors(next)).toBe(false);
  });

  it("appends a quote and merges new attachments", () => {
    const next = appendQuoteAndAttachmentsToDraft(
      emptyPromptDraftState(),
      "review this",
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    );

    expect(next).toEqual({
      text: "> review this\n",
      mentions: [],
      attachments: [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("adds attachments even when there is no quote text", () => {
    const next = appendQuoteAndAttachmentsToDraft(emptyPromptDraftState(), "", [
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 0,
      },
    ]);

    expect(next).toEqual({
      text: "",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    });
  });

  it("dedupes attachments by path", () => {
    const attachment = {
      type: "localFile" as const,
      path: "uploads/spec.md",
      name: "spec.md",
      sizeBytes: 0,
    };

    const base = {
      text: "",
      mentions: [],
      attachments: [attachment],
    };

    expect(appendQuoteAndAttachmentsToDraft(base, "", [attachment])).toBe(base);
  });
});
