import type { CSSProperties, PointerEvent, ReactNode, RefObject } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";

export type ComposerEditorLayout = "thread" | "root-compose";

export const COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY =
  "--composer-editor-available-height";

const COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT: Record<
  ComposerEditorLayout,
  string
> = {
  thread: "calc(var(--omnyo-shell-height, 100dvh) * 0.5 - 3rem)",
  "root-compose":
    "min(20rem, calc(var(--omnyo-shell-height, 100dvh) * 0.6 - 8rem))",
};

export function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

export function ComposerEditorSlot({
  editor,
  scrollContainerRef,
  inputLocked,
  isCompactLayout,
  isEmpty,
  minHeight,
  layout,
  resolveMentionLink,
  leadingInset,
  suggestion,
  animateSuggestion,
  onPointerDown,
}: {
  editor: Editor | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  inputLocked: boolean;
  isCompactLayout: boolean;
  isEmpty: boolean;
  minHeight: number;
  layout: ComposerEditorLayout;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  leadingInset: boolean;
  suggestion: ReactNode;
  animateSuggestion: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const style: CSSProperties = {
    minHeight: isCompactLayout
      ? "48px"
      : isEmpty
        ? "var(--composer-empty-min-height)"
        : `${minHeight}px`,
    height: isCompactLayout ? "48px" : undefined,
    maxHeight: isCompactLayout
      ? "48px"
      : `min(${COMPOSER_EDITOR_MAX_HEIGHT_BY_LAYOUT[layout]}, var(${COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY}, 100dvh))`,
  };

  return (
    <div
      ref={scrollContainerRef}
      data-promptbox-editor-scroll=""
      aria-busy={inputLocked || undefined}
      onPointerDown={onPointerDown}
      className={cn(
        "grid w-full overflow-y-auto bg-transparent px-4 py-2 outline-none [--composer-empty-min-height:40px]",
        leadingInset && "pl-2.5",
        COARSE_POINTER_TEXT_BASE_CLASS,
        "md:text-base",
        "leading-relaxed",
        isCompactLayout && "h-12 overflow-hidden pb-0 pr-2 pt-0",
      )}
      style={style}
    >
      {suggestion === null ? null : (
        <div
          data-promptbox-suggestion=""
          className={cn(
            "pointer-events-none min-w-0 leading-[1.7] [grid-area:1/1]",
            animateSuggestion &&
              "animate-in fade-in-0 duration-(--motion-duration-fast)",
          )}
        >
          {suggestion}
        </div>
      )}
      <PromptMentionLinkContext.Provider value={resolveMentionLink ?? null}>
        <EditorContent
          editor={editor}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;

            if (editor === null || editor.isEditable) return;
            event.preventDefault();
            blurPromptEditor(editor);
          }}
          data-promptbox-editor-content=""
          data-promptbox-compact-content={isCompactLayout ? "" : undefined}
          className={cn(
            "h-full min-h-full [grid-area:1/1]",
            isCompactLayout && "flex items-center",
            "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
            "[&_.ProseMirror_p]:m-0",
            "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
            "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-40",
          )}
        />
      </PromptMentionLinkContext.Provider>
    </div>
  );
}
