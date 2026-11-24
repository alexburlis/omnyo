// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "./extensions.js";

describe("Omnyo structured link transition", () => {
  it.each([
    ["bbtask://", "omnyotask://", "taskMention", "TSK-42"],
    ["bbthread://", "omnyothread://", "threadMention", "thr_stable"],
  ])(
    "imports the exact V1 %s href with a stable target",
    (legacy, current, nodeName, id) => {
      const editor = new Editor({
        extensions: createEditorExtensions(),
        content: `Before [unchanged label](${legacy}${id}) after.`,
      });

      try {
        const targets: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === nodeName)
            targets.push(node.attrs.key ?? node.attrs.threadId);
        });
        expect(targets).toEqual([id]);
        expect(editor.storage.markdown.getMarkdown()).toBe(
          `Before [unchanged label](${current}${id}) after.`,
        );
      } finally {
        editor.destroy();
      }
    },
  );

  it("preserves prose, code, and unrelated URLs while current links round-trip", () => {
    const content = [
      "Literal bbtask://TSK-42 and `bbthread://thr_stable` stay user text.",
      "[external](https://example.com/bbtask://TSK-42)",
      "[current](omnyotask://TSK-42)",
    ].join("\n\n");

    const editor = new Editor({
      extensions: createEditorExtensions(),
      content,
    });

    try {
      expect(editor.storage.markdown.getMarkdown()).toBe(content);
      expect(
        editor.view.dom.querySelector('[data-task-mention="TSK-42"]')
          ?.textContent,
      ).toBe("current");
    } finally {
      editor.destroy();
    }
  });
});
