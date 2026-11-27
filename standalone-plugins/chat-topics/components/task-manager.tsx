import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_ResponsiveDrawerShell as ResponsiveDrawerShell,
} from "@omnyo/plugin-sdk/app";
import type { ExperimentalSidebarFooterCardProps } from "@omnyo/plugin-sdk/app";
import {
  hostTaskManagerFooter,
  setTaskManager,
  useTaskManager,
  useTaskManagerList,
} from "../lib/task-manager.ts";
import { useTaskUsage } from "../lib/use-task-usage.ts";
import { TaskOverview } from "./task-overview.tsx";

export function TaskManagerToggle({ footer = false }: { footer?: boolean }) {
  const enabled = useTaskManager();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [present, setPresent] = useState(false);
  const shown = open || present;
  const usage = useTaskUsage(open);
  const lastUsage = useRef(usage);

  if (open) lastUsage.current = usage;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const restoringFocus = useRef(false);
  const id = useId();

  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);

  const close = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    clearTimeout(touchTimer.current);
    setOpen(false);
  }, []);

  const dismiss = useCallback(() => {
    close();
    restoringFocus.current = true;
    trigger.current?.focus({ preventScroll: true });
    restoringFocus.current = false;
  }, [close]);

  const leave = () => {
    clearTimeout(openTimer.current);
    clearTimeout(touchTimer.current);

    if (compact) return;
    closeTimer.current = setTimeout(() => {
      const focused = document.activeElement;

      if (
        !focused?.matches(":focus-visible") ||
        (!panel.current?.contains(focused) && focused !== trigger.current)
      )
        setOpen(false);
    }, 160);
  };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => close, [close]);

  useEffect(() => {
    if (!open) return;

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        close();
    };

    window.addEventListener("keydown", keydown, true);

    if (!compact) window.addEventListener("pointerdown", outside, true);

    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [open, compact, close, dismiss]);

  useLayoutEffect(() => {
    if (!shown || compact) return;
    const element = panel.current;
    const anchor = trigger.current;

    if (!element || !anchor) return;
    element.showPopover();

    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - element.offsetWidth - 8));
      element.style.left = `${left}px`;
      element.style.top = `${Math.max(8, rect.top - element.offsetHeight - 8)}px`;
    };

    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener("resize", position);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);

      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [shown, compact]);

  useEffect(() => {
    if (open) {
      setPresent(true);

      return;
    }

    if (!present) return;
    const duration = panel.current ? getComputedStyle(panel.current).animationDuration : "0s";
    const delay = Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = setTimeout(() => setPresent(false), Number.isFinite(delay) ? delay : 0);

    return () => clearTimeout(timer);
  }, [open, present]);

  const content = (
    <TaskOverview
      usage={open ? usage : lastUsage.current}
      onClose={dismiss}
      enabled={enabled}
      onToggle={() => setTaskManager(!enabled)}
    />
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="switch"
        aria-label="Task Manager"
        aria-description="Hover or focus for machine and process usage. Click to show or hide sidebar readings. On touch, hold for the overview."
        aria-haspopup="dialog"
        aria-checked={enabled}
        aria-controls={open ? id : undefined}
        className="ct-task-toggle"
        data-placement={footer ? "footer" : "list"}
        onClick={() => {
          if (!longPressed.current) setTaskManager(!enabled);
          longPressed.current = false;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          cancelClose();
          openTimer.current = setTimeout(() => setOpen(true), 250);
        }}
        onPointerLeave={leave}
        onPointerDown={(event) => {
          longPressed.current = false;

          if (event.pointerType === "touch")
            touchTimer.current = setTimeout(() => {
              longPressed.current = true;
              setOpen(true);
            }, 450);
        }}
        onPointerUp={() => clearTimeout(touchTimer.current)}
        onPointerCancel={() => clearTimeout(touchTimer.current)}
        onContextMenu={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        onFocus={(event) => {
          if (!restoringFocus.current && event.currentTarget.matches(":focus-visible")) {
            cancelClose();
            setOpen(true);
          }
        }}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !panel.current?.contains(event.relatedTarget)
          )
            leave();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="ChartColumn" aria-hidden className="size-4" />
      </button>
      {compact ? (
        <ResponsiveDrawerShell
          open={open}
          onOpenChange={setOpen}
          srLabel="Task Manager overview"
          contentClassName="ct-task-drawer"
        >
          <div id={id} ref={panel} className="ct-task-overview ct-task-overview-compact">
            {content}
          </div>
        </ResponsiveDrawerShell>
      ) : shown ? (
        <div
          data-state={open ? "open" : "closed"}
          id={id}
          ref={panel}
          popover="manual"
          role="dialog"
          aria-label="Task Manager overview"
          className="ct-task-overview"
          onPointerEnter={cancelClose}
          onPointerLeave={leave}
          onFocus={cancelClose}
          onBlur={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              leave();
          }}
        >
          {content}
        </div>
      ) : null}
    </>
  );
}

function FooterTaskManager() {
  const hasList = useTaskManagerList();
  useLayoutEffect(() => (hasList ? hostTaskManagerFooter() : undefined), [hasList]);

  return hasList ? <TaskManagerToggle footer /> : null;
}

export function TaskManagerCard({ experimental_placement }: ExperimentalSidebarFooterCardProps) {
  const probe = useRef<HTMLSpanElement>(null);
  const [underSidebar, setUnderSidebar] = useState(false);
  useLayoutEffect(() => {
    setUnderSidebar((probe.current?.closest('[data-footer-region="sidebar"]') ?? null) !== null);
  }, []);

  if (experimental_placement !== "footer") return null;

  return underSidebar ? <FooterTaskManager /> : <span ref={probe} hidden />;
}
