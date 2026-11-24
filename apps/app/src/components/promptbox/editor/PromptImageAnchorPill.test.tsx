// @vitest-environment jsdom

import { useMemo, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import {
  PromptImageAnchorContext,
  promptAttachmentKey,
  type PromptImageAnchorState,
} from "../attachment-anchor-focus";
import { PromptMentionExtension } from "./prompt-mention-extension";
import { promptImageAnchorContent } from "./prompt-image-anchor";

const ATTACHMENTS: PromptDraftAttachment[] = [
  {
    type: "localImage",
    path: "uploads/first.png",
    name: "first.png",
    alias: "Img1",
  },
  {
    type: "localImage",
    path: "uploads/second.png",
    name: "second.png",
    alias: "Img2",
  },
];

let editor: Editor | null = null;

function Composer() {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const anchors = useMemo<PromptImageAnchorState>(
    () => ({
      activeKey,
      setActiveKey,
      resolve: (anchor) => {
        const attachment = ATTACHMENTS.find(
          (item) => item.path === anchor.path,
        );

        return attachment
          ? {
              status: "bound",
              attachment,
              key: promptAttachmentKey(attachment),
              previewSrc: `blob:${attachment.name}`,
            }
          : { status: "missing" };
      },
    }),
    [activeKey],
  );

  const instance = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, PromptMentionExtension],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Compare " },
            promptImageAnchorContent({
              label: "Img1",
              path: "uploads/first.png",
            }),
            { type: "text", text: " with " },
            promptImageAnchorContent({
              label: "Img2",
              path: "uploads/second.png",
            }),
          ],
        },
      ],
    },
  });

  editor = instance;

  return (
    <PromptImageAnchorContext.Provider value={anchors}>
      <EditorContent editor={instance} />
    </PromptImageAnchorContext.Provider>
  );
}

async function flush() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

async function renderComposer() {
  render(<Composer />);
  await flush();
}

async function runEditor(command: (current: Editor) => void) {
  await act(async () => {
    if (editor) command(editor);
  });
  await flush();
}

function chip(label: "Img1" | "Img2"): HTMLElement {
  const element = document.querySelector(`[data-image-anchor="${label}"]`);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`${label} chip was not rendered`);
  }

  return element;
}

function chipsWithClass(className: string): string[] {
  return (["Img1", "Img2"] as const).filter((label) =>
    chip(label).classList.contains(className),
  );
}

function preview(name: string): HTMLElement {
  return screen.getByRole("img", { name });
}

function openPreviews(): string[] {
  return ATTACHMENTS.map((attachment) => attachment.name).filter(
    (name) => screen.queryByRole("img", { name }) !== null,
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function hover(target: HTMLElement, init: PointerEventInit = {}) {
  fireEvent.pointerEnter(target, { pointerType: "mouse", ...init });
}

function unhover(target: HTMLElement) {
  fireEvent.pointerLeave(target, { pointerType: "mouse" });
}

describe("PromptImageAnchorPill preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    editor = null;
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  it("never opens a preview from select-all, undo, caret moves, focus, touch or a drag", async () => {
    await renderComposer();

    await runEditor((current) => current.commands.selectAll());
    await runEditor((current) => current.commands.deleteSelection());
    await runEditor((current) => current.commands.undo());
    advance(1000);
    expect(openPreviews()).toEqual([]);

    await runEditor((current) => current.commands.setTextSelection(9));
    await runEditor((current) => current.commands.focus());
    act(() => chip("Img1").focus());
    advance(1000);
    expect(openPreviews()).toEqual([]);

    hover(chip("Img1"), { pointerType: "touch" });
    advance(1000);
    hover(chip("Img2"), { buttons: 1 });
    advance(1000);
    expect(openPreviews()).toEqual([]);
  });

  it("opens a hovered preview after a short delay and fades it once the pointer leaves the chip and preview, even with text selected", async () => {
    await renderComposer();

    hover(chip("Img1"));
    advance(100);
    expect(openPreviews()).toEqual([]);
    advance(300);
    expect(openPreviews()).toEqual(["first.png"]);

    unhover(chip("Img1"));
    hover(preview("first.png"));
    advance(500);
    expect(openPreviews()).toEqual(["first.png"]);

    await runEditor((current) => current.commands.selectAll());
    act(() => {
      const view = editor?.view.dom;

      if (view) window.getSelection()?.selectAllChildren(view);
    });
    fireEvent.pointerDown(preview("first.png"));
    fireEvent.pointerUp(preview("first.png"));
    advance(10);
    unhover(preview("first.png"));
    advance(500);
    expect(openPreviews()).toEqual([]);
  });

  it("keeps a clicked preview open off-hover until an outside pointer down or Escape, with one preview at a time", async () => {
    await renderComposer();

    fireEvent.click(chip("Img1"));
    expect(openPreviews()).toEqual(["first.png"]);
    unhover(chip("Img1"));
    advance(1000);
    expect(openPreviews()).toEqual(["first.png"]);

    fireEvent.pointerDown(document.body);
    expect(openPreviews()).toEqual([]);

    fireEvent.click(chip("Img1"));
    advance(0);
    hover(chip("Img2"));
    advance(400);
    expect(openPreviews()).toEqual(["second.png"]);

    fireEvent.click(chip("Img2"));
    advance(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(openPreviews()).toEqual([]);

    fireEvent.click(chip("Img2"));
    advance(0);
    fireEvent.pointerDown(chip("Img2"));
    fireEvent.click(chip("Img2"));
    expect(openPreviews()).toEqual([]);
  });

  it("toggles a preview from a focused chip with Enter or Space and closes it when focus leaves the chip", async () => {
    await renderComposer();

    act(() => chip("Img2").focus());
    fireEvent.keyDown(chip("Img2"), { key: "Enter" });
    expect(openPreviews()).toEqual(["second.png"]);
    expect(chip("Img2").getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(chip("Img2"), { key: " " });
    expect(openPreviews()).toEqual([]);

    fireEvent.keyDown(chip("Img2"), { key: "Enter" });
    expect(openPreviews()).toEqual(["second.png"]);
    act(() => chip("Img1").focus());
    advance(1000);
    expect(openPreviews()).toEqual([]);
  });

  it("opens from a primary click without taking focus from the editor", async () => {
    await renderComposer();

    expect(fireEvent.mouseDown(chip("Img1"), { button: 2 })).toBe(true);
    expect(fireEvent.mouseDown(chip("Img1"))).toBe(false);
    fireEvent.click(chip("Img1"));
    expect(openPreviews()).toEqual(["first.png"]);
  });

  it("tints chips only while the live selection covers them, including after select-all, delete and undo", async () => {
    await renderComposer();
    const selected = "prompt-mention-pill--selected";

    await runEditor((current) => current.commands.selectAll());
    expect(chipsWithClass(selected)).toEqual(["Img1", "Img2"]);

    await runEditor((current) => current.commands.setTextSelection(9));
    expect(chipsWithClass(selected)).toEqual([]);

    await runEditor((current) => current.commands.selectAll());
    await runEditor((current) => current.commands.deleteSelection());
    await runEditor((current) => current.commands.undo());
    await runEditor((current) => current.commands.setTextSelection(9));
    expect(chipsWithClass(selected)).toEqual([]);
    expect(chipsWithClass("ring-2")).toEqual([]);
  });
});
