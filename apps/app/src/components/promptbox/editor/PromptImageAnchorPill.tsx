import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { NodeViewWrapper } from "@tiptap/react";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@omnyo/shared-ui/hover-card";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PROMPT_MENTION_PILL_CLASS } from "@/components/promptbox/mentions/prompt-mention-display";
import { promptMentionClipboardDataAttributes } from "@/components/promptbox/mentions/prompt-mention-clipboard";
import { promptImageAnchorText } from "@omnyo/client-core";
import { usePromptImageAnchors } from "../attachment-anchor-focus";
import type { PromptImageAnchorRef } from "./prompt-image-anchor";

const UNCLEAR_LABEL = "Image link unclear. Remove it and add the image again.";

const PREVIEW_OPEN_DELAY_MS = 300;

const PREVIEW_CLOSE_DELAY_MS = 80;

type PreviewMode = "closed" | "hover" | "pinned";

interface PreviewOwner {
  close: () => void;
}

let openPreviewOwner: PreviewOwner | null = null;

function claimOpenPreview(owner: PreviewOwner) {
  if (openPreviewOwner !== owner) openPreviewOwner?.close();
  openPreviewOwner = owner;
}

function releaseOpenPreview(owner: PreviewOwner) {
  if (openPreviewOwner === owner) openPreviewOwner = null;
}

function useAnchorPreview() {
  const [mode, setMode] = useState<PreviewMode>("closed");
  const timerRef = useRef<number | undefined>(undefined);

  const [owner] = useState<PreviewOwner>(() => ({
    close: () => {
      window.clearTimeout(timerRef.current);
      setMode("closed");
    },
  }));

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      releaseOpenPreview(owner);
    },
    [owner],
  );

  const schedule = (action: () => void, delayMs: number) => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(action, delayMs);
  };

  const show = (next: Exclude<PreviewMode, "closed">) => {
    window.clearTimeout(timerRef.current);
    claimOpenPreview(owner);
    setMode(next);
  };

  const hide = () => {
    window.clearTimeout(timerRef.current);
    releaseOpenPreview(owner);
    setMode("closed");
  };

  return {
    open: mode !== "closed",
    hide,
    toggle: () => (mode === "pinned" ? hide() : show("pinned")),
    enterChip: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;

      if (mode !== "closed") {
        window.clearTimeout(timerRef.current);

        return;
      }

      if (event.buttons !== 0) return;
      schedule(() => show("hover"), PREVIEW_OPEN_DELAY_MS);
    },
    enterPreview: () => {
      if (mode === "hover") window.clearTimeout(timerRef.current);
    },
    leave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch" || mode === "pinned") return;

      if (mode === "hover") schedule(hide, PREVIEW_CLOSE_DELAY_MS);
      else window.clearTimeout(timerRef.current);
    },
  };
}

export function PromptImageAnchorPill({
  anchor,
  isSelected,
}: {
  anchor: PromptImageAnchorRef;
  isSelected: boolean;
}) {
  const anchors = usePromptImageAnchors();
  const preview = useAnchorPreview();
  const chipRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const state = anchors?.resolve(anchor) ?? { status: "missing" as const };
  const boundKey = state.status === "bound" ? state.key : null;
  const setActiveKey = anchors?.setActiveKey;

  useEffect(() => {
    if (!isSelected || boundKey === null || !setActiveKey) return;
    setActiveKey(boundKey);

    return () => setActiveKey(null);
  }, [boundKey, isSelected, setActiveKey]);

  const isActive = boundKey !== null && anchors?.activeKey === boundKey;
  const isUnclear = state.status === "ambiguous" || state.status === "missing";

  const ariaLabel =
    state.status === "bound"
      ? `Image ${anchor.label.slice(3)}, ${state.attachment.name}`
      : state.status === "pending"
        ? `Image ${anchor.label.slice(3)}, uploading`
        : `Image ${anchor.label.slice(3)}. ${UNCLEAR_LABEL}`;

  const previewControls =
    state.status === "bound"
      ? {
          ref: chipRef,
          role: "button",
          tabIndex: 0,
          "aria-expanded": preview.open,
          onClick: (event: MouseEvent<HTMLElement>) => {
            if (
              event.button !== 0 ||
              event.detail > 1 ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey
            ) {
              return;
            }

            preview.toggle();
          },
          onMouseDown: (event: MouseEvent<HTMLElement>) => {
            if (event.button === 0) event.preventDefault();
          },
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            preview.toggle();
          },
          onBlur: (event: FocusEvent<HTMLElement>) => {
            const next = event.relatedTarget;

            if (
              next instanceof Node &&
              (chipRef.current?.contains(next) ||
                previewRef.current?.contains(next))
            ) {
              return;
            }

            preview.hide();
          },
        }
      : { role: "img" };

  const chip = (
    <NodeViewWrapper
      as="span"
      className={cn(
        PROMPT_MENTION_PILL_CLASS,
        "selection:bg-transparent [&_*]:selection:bg-transparent",
        isSelected && "prompt-mention-pill--selected",
        isActive && "ring-2 ring-ring",
        state.status === "bound" &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isUnclear &&
          "border-attention/50 bg-surface-attention text-warning-text",
      )}
      {...promptMentionClipboardDataAttributes({
        resource: {
          kind: "attachment",
          path: anchor.path,
          label: anchor.label,
        },
        serializedText: promptImageAnchorText(anchor.label),
      })}
      data-image-anchor={anchor.label}
      aria-label={ariaLabel}
      {...previewControls}
      onPointerEnter={(event: PointerEvent<HTMLElement>) => {
        if (boundKey === null) return;
        setActiveKey?.(boundKey);
        preview.enterChip(event);
      }}
      onPointerLeave={(event: PointerEvent<HTMLElement>) => {
        if (boundKey === null) return;
        setActiveKey?.(null);
        preview.leave(event);
      }}
    >
      {state.status === "bound" ? (
        <img
          src={state.previewSrc}
          alt=""
          className="-ml-0.5 size-4 shrink-0 self-center rounded-sm object-cover"
          draggable={false}
        />
      ) : (
        <Icon
          name={isUnclear ? "AlertCircle" : "Paperclip"}
          className="-ml-px size-4 shrink-0 self-center"
          aria-hidden
        />
      )}
      <span className="truncate">{anchor.label}</span>
    </NodeViewWrapper>
  );

  if (state.status !== "bound") return chip;

  return (
    <HoverCard open={preview.open}>
      <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
      <HoverCardContent
        ref={previewRef}
        side="top"
        className="w-auto max-w-64 p-1.5"
        onPointerEnter={preview.enterPreview}
        onPointerLeave={preview.leave}
        onEscapeKeyDown={(event) => {
          if (!preview.open) return;
          event.preventDefault();
          event.stopPropagation();
          preview.hide();
        }}
        onPointerDownOutside={(event) => {
          if (
            event.target instanceof Node &&
            chipRef.current?.contains(event.target)
          ) {
            event.preventDefault();

            return;
          }

          preview.hide();
        }}
      >
        <img
          src={state.previewSrc}
          alt={state.attachment.name}
          className="max-h-40 max-w-60 rounded-sm object-contain"
        />
        <p className="mt-1 truncate px-0.5 text-xs text-muted-foreground">
          {anchor.label} · {state.attachment.name}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}
