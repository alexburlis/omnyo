import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
} from "react";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";
import { PROMPT_STACK_TRACK_CLASS } from "./banner/PromptStackCard";

export function ComposerStatusTray({
  id,
  open,
  resetKey,
  onContentChange,
  children,
}: {
  id: string;
  open: boolean;
  resetKey: string | number;
  onContentChange: (hasContent: boolean) => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const onContentChangeRef = useRef(onContentChange);
  const [wasOpen, setWasOpen] = useState(open);
  const [seenResetKey, setSeenResetKey] = useState(resetKey);

  const [transition, setTransition] = useState<"opening" | "closing" | null>(
    null,
  );

  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    setWasOpen(open);
    setTransition(null);
  } else if (open !== wasOpen) {
    setWasOpen(open);
    setTransition(open ? "opening" : "closing");
  }

  const closing = transition === "closing";
  const shown = open || closing;

  useEffect(() => {
    if (transition !== "closing") return;

    const timeout = window.setTimeout(
      () => setTransition(null),
      MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
    );

    return () => window.clearTimeout(timeout);
  }, [transition]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setTransition(null);
  };

  useLayoutEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useLayoutEffect(() => {
    const content = contentRef.current;

    if (content === null || typeof ResizeObserver === "undefined") return;
    let reported: boolean | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === content);

      if (entry === undefined) return;

      const box = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;

      const hasContent = (box?.blockSize ?? entry.contentRect.height) > 0;

      if (hasContent === reported) return;
      reported = hasContent;
      onContentChangeRef.current(hasContent);
    });

    observer.observe(content);

    return () => {
      observer.disconnect();
      onContentChangeRef.current(false);
    };
  }, []);

  return (
    <div
      id={id}
      data-composer-status-tray=""
      data-open={open ? "" : undefined}
      inert={open ? undefined : true}
      onAnimationEnd={handleAnimationEnd}
      className={cn(
        shown
          ? "relative has-[[data-queue-attached]]:-mb-5"
          : "pointer-events-none invisible absolute inset-x-0 bottom-full h-0 overflow-hidden",
        transition === "opening" &&
          "animate-in fade-in-0 slide-in-from-bottom-2 ease-sheet",
        closing &&
          "pointer-events-none animate-out fade-out-0 fill-mode-forwards",
      )}
    >
      <div
        ref={contentRef}
        className={cn(
          "grid min-w-0 gap-2",
          PROMPT_STACK_TRACK_CLASS,
          shown &&
            "max-h-[min(24rem,calc(var(--omnyo-shell-height,100dvh)*0.45))] overflow-x-hidden overflow-y-auto overscroll-contain",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ComposerStatusTrayToggle({
  controlsId,
  open,
  queuedMessageCount,
  onToggle,
}: {
  controlsId: string;
  open: boolean;
  queuedMessageCount: number;
  onToggle: () => void;
}) {
  const action = open ? "Hide chat status" : "Show chat status";

  return (
    <div data-composer-status-tray-handle="" className="flex justify-end">
      <button
        type="button"
        data-composer-status-tray-toggle=""
        aria-label={
          queuedMessageCount === 0
            ? action
            : `${action}, ${queuedMessageCount} queued ${queuedMessageCount === 1 ? "message" : "messages"}`
        }
        aria-expanded={open}
        aria-controls={controlsId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
        className={cn(
          "flex h-6 cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground aria-expanded:bg-state-active aria-expanded:text-foreground max-md:pointer-coarse:h-8 max-md:pointer-coarse:px-3",
          CONTROL_PRESS_TRANSITION,
          CONTROL_PRESS_FEEDBACK,
        )}
      >
        {queuedMessageCount === 0 ? (
          "Chat status"
        ) : (
          <span>
            <span
              data-composer-status-tray-queued-count=""
              className="font-medium tabular-nums text-foreground"
            >
              {queuedMessageCount}
            </span>{" "}
            queued
          </span>
        )}
        <Icon
          name="ChevronUp"
          className={cn(
            "size-3.5 shrink-0",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
    </div>
  );
}
