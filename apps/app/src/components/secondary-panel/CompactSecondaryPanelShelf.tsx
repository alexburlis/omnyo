import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  dragSettleTransition,
  MOTION_DURATION_MS,
  prefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import { usePersistentOverlayFocus } from "@omnyo/shared-ui/responsive-overlay";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { hasTextSelectionWithin } from "@/components/ui/gesture-dom";
import { useHorizontalDismissDrag } from "@/components/ui/use-horizontal-dismiss-drag";
import { setCompactSecondaryPanelPresentation } from "@/components/ui/secondary-panel-shelf-visibility";

const SHELF_TRANSITION_CLASS =
  "[transition:translate_var(--motion-duration-drawer)_var(--motion-ease-sheet)] motion-reduce:transition-none!";

const SHELF_CLOSED_TRANSITION_CLASS =
  "data-[state=closed]:invisible data-[state=closed]:[transition:translate_var(--motion-duration-drawer)_var(--motion-ease-sheet),visibility_0s_linear_var(--motion-duration-drawer)]";

function getShelfSettleTransition(settleMs: number): string {
  const translate = dragSettleTransition(["translate"], settleMs);

  return translate === "none"
    ? translate
    : `${translate}, visibility 0s linear ${settleMs}ms`;
}

interface CompactSecondaryPanelShelfProps {
  children: ReactNode;
  onClose: () => void;
  onContentAnimationEnd?: (open: boolean) => void;
  open: boolean;
  srLabel: string;
}

export function CompactSecondaryPanelShelf({
  children,
  onClose,
  onContentAnimationEnd,
  open,
  srLabel,
}: CompactSecondaryPanelShelfProps) {
  const labelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const draggedInsetRef = useRef<HTMLElement | null>(null);
  const state = open ? "full" : "closed";
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => onCloseRef.current(), []);

  const clearDragStyles = useCallback(() => {
    const panel = panelRef.current;

    if (panel !== null) {
      panel.style.translate = "";
      panel.style.transition = "";
    }

    const inset = draggedInsetRef.current;

    if (inset !== null) {
      inset.style.translate = "";
      inset.style.transition = "";
      draggedInsetRef.current = null;
    }
  }, []);

  const applyDragProgress = useCallback(
    ({
      progress,
      width,
      settling,
      settleMs,
    }: {
      progress: number;
      width: number;
      settling: boolean;
      settleMs: number;
    }) => {
      const panel = panelRef.current;

      if (panel === null) {
        return;
      }

      panel.style.translate = `${width * (1 - progress)}px`;
      panel.style.transition = settling
        ? getShelfSettleTransition(settleMs)
        : "none";

      const inset = panel.ownerDocument.querySelector('[data-sidebar="inset"]');

      if (inset instanceof HTMLElement) {
        draggedInsetRef.current = inset;
        inset.style.translate = `${-width * progress}px`;
        inset.style.transition = settling
          ? dragSettleTransition(["translate"], settleMs)
          : "none";
      }
    },
    [],
  );

  const { beginPointerDrag, beginTouchDrag } = useHorizontalDismissDrag({
    direction: "right",
    dismissTiming: "immediate",
    enabled: open,
    getWidth: () => panelRef.current?.clientWidth ?? 0,
    onClear: clearDragStyles,
    onDismiss: requestClose,
    onProgress: applyDragProgress,
    resetKey: state,
    suppressClick: false,
  });

  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  usePersistentOverlayFocus({
    open: open && portalTarget !== null,
    panelRef,
    requestClose,
  });

  useLayoutEffect(() => {
    if (open) return;
    const panel = panelRef.current;

    if (panel === null) return;

    if (hasTextSelectionWithin(panel)) {
      panel.ownerDocument.getSelection()?.removeAllRanges();
    }
  }, [open]);

  useEffect(() => {
    setCompactSecondaryPanelPresentation(state);

    return () => setCompactSecondaryPanelPresentation("closed");
  }, [state]);

  useEffect(() => {
    if (onContentAnimationEnd === undefined) return;

    const timer = window.setTimeout(
      () => onContentAnimationEnd(open),
      prefersReducedMotion() ? 0 : MOTION_DURATION_MS.drawer,
    );

    return () => window.clearTimeout(timer);
  }, [onContentAnimationEnd, open]);

  if (portalTarget === null) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      data-omnyo-portaled-overlay=""
      tabIndex={-1}
      inert={!open}
      data-testid="secondary-panel-shelf"
      data-state={state}
      style={{
        zIndex:
          state === "full"
            ? APP_OVERLAY_LAYER.secondaryPanelFullPage
            : APP_OVERLAY_LAYER.secondaryPanel,
      }}
      className={cn(
        "fixed inset-y-0 right-0 flex h-(--omnyo-shell-height) flex-col overflow-hidden bg-sidebar pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--omnyo-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] outline-none",
        "w-full translate-x-full data-[state=full]:translate-x-0",
        SHELF_TRANSITION_CLASS,
        SHELF_CLOSED_TRANSITION_CLASS,
      )}
      onPointerDown={beginPointerDrag}
      onTouchStart={beginTouchDrag}
    >
      <span id={labelId} className="sr-only">
        {srLabel}
      </span>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>,
    portalTarget,
  );
}
