import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { ResponsiveDrawerShell } from "@omnyo/shared-ui/responsive-overlay";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";

interface ComposerPopupHostProps {
  open: boolean;
  placement: "top" | "bottom";
  label: string;
  interactive: boolean;
  popupKey: string | null;
  popupRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLFormElement | null>;
  onClose(restoreFocus: boolean): void;
  children: ReactNode;
}

interface RetainedPopup {
  placement: "top" | "bottom";
  children: ReactNode;
}

export function ComposerPopupHost(props: ComposerPopupHostProps) {
  const { open, label, interactive, popupRef, composerRef, onClose } = props;
  const compact = useIsCompactViewport();
  const drawer = interactive && compact;

  const exiting = useRetainedPopupExit(
    open && !drawer,
    props.placement,
    props.children,
  );

  useEffect(() => {
    if (!open || drawer) return;

    const dismissOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;

      if (popupRef.current?.contains(event.target)) return;

      if (composerRef.current?.contains(event.target)) return;
      onClose(false);
    };

    document.addEventListener("pointerdown", dismissOutside, true);

    return () =>
      document.removeEventListener("pointerdown", dismissOutside, true);
  }, [composerRef, drawer, onClose, open, popupRef]);

  if (drawer) {
    return (
      <ResponsiveDrawerShell
        open={open}
        srLabel={label}
        onOpenChange={(next) => {
          if (!next) onClose(false);
        }}
        onAfterCloseAutoFocus={() => onClose(true)}
      >
        <ComposerPopupContent {...props} drawer />
      </ResponsiveDrawerShell>
    );
  }

  if (open) return <ComposerPopupContent {...props} drawer={false} />;

  if (exiting.retained === null) return null;

  return (
    <ComposerPopupContent
      {...props}
      placement={exiting.retained.placement}
      drawer={false}
      onExitEnd={exiting.finish}
    >
      {exiting.retained.children}
    </ComposerPopupContent>
  );
}

function useRetainedPopupExit(
  open: boolean,
  placement: "top" | "bottom",
  children: ReactNode,
): { retained: RetainedPopup | null; finish: () => void } {
  const lastOpenRef = useRef<RetainedPopup | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [retained, setRetained] = useState<RetainedPopup | null>(null);

  if (open !== wasOpen) {
    setWasOpen(open);
    setRetained(open ? null : lastOpenRef.current);
  }

  useLayoutEffect(() => {
    if (open) lastOpenRef.current = { placement, children };
  }, [children, open, placement]);

  useEffect(() => {
    if (retained === null) return;

    const timeout = window.setTimeout(
      () => setRetained(null),
      MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
    );

    return () => window.clearTimeout(timeout);
  }, [retained]);

  return { retained, finish: () => setRetained(null) };
}

function ComposerPopupContent({
  open,
  drawer,
  placement,
  label,
  interactive,
  popupKey,
  popupRef,
  children,
  onExitEnd,
}: ComposerPopupHostProps & { drawer: boolean; onExitEnd?: () => void }) {
  const exiting = onExitEnd !== undefined;

  useEffect(() => {
    if (!open || !interactive) return;

    const frame = window.requestAnimationFrame(() => {
      const firstInput = popupRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]',
      );

      firstInput?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [interactive, open, popupKey, popupRef]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    onExitEnd?.();
  };

  return (
    <div
      ref={exiting ? undefined : popupRef}
      data-promptbox-typeahead-menu={exiting ? undefined : ""}
      role={interactive && !drawer && !exiting ? "dialog" : undefined}
      aria-label={interactive && !exiting ? label : undefined}
      aria-hidden={exiting ? true : undefined}
      inert={exiting ? true : undefined}
      onAnimationEnd={exiting ? handleAnimationEnd : undefined}
      className={
        drawer
          ? undefined
          : cn(
              "absolute -left-px -right-px z-20",
              exiting
                ? "pointer-events-none animate-out fade-out-0 zoom-out-95 fill-mode-forwards"
                : "animate-in fade-in-0 zoom-in-95",
              placement === "top"
                ? "bottom-full mb-2 origin-bottom"
                : "top-full mt-2 origin-top",
              !exiting &&
                (placement === "top"
                  ? "slide-in-from-bottom-2"
                  : "slide-in-from-top-2"),
            )
      }
    >
      {children}
    </div>
  );
}
