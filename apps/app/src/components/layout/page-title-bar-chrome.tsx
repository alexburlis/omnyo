import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { MACOS_APP_REGION_NO_DRAG_CLASS } from "@/lib/omnyo-desktop";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { useWindowTitleBarHostsRightPanelToggle } from "./WindowRightPanelToggle";
import {
  useWindowTitleBarSlots,
  type WindowTitleBarSlots,
} from "./window-title-bar-slots";

export function usePageTitleBarSlots(): WindowTitleBarSlots | null {
  const slots = useWindowTitleBarSlots();

  const titleBarHostsRightPanelToggle =
    useWindowTitleBarHostsRightPanelToggle();

  const isSplitPane = useOptionalPaneContext()?.isSplitPane ?? false;

  return slots !== null && titleBarHostsRightPanelToggle && !isSplitPane
    ? slots
    : null;
}

export function WindowTitleBarChrome({
  actions,
  slots,
  title,
}: {
  actions: ReactNode;
  slots: WindowTitleBarSlots;
  title: ReactNode;
}) {
  const [isActive, setIsActive] = useState(false);

  useLayoutEffect(() => {
    setIsActive(true);

    return () => setIsActive(false);
  }, []);

  if (!isActive) return null;

  return (
    <>
      {slots.pageTitle === null
        ? null
        : createPortal(
            <div
              data-page-title-bar-chrome=""
              className="flex min-w-0 items-center gap-2"
            >
              {title}
            </div>,
            slots.pageTitle,
          )}
      {slots.pageActions === null || actions === null
        ? null
        : createPortal(
            <div
              data-page-title-bar-actions=""
              className={cn(
                "flex items-center gap-1",
                MACOS_APP_REGION_NO_DRAG_CLASS,
              )}
            >
              {actions}
            </div>,
            slots.pageActions,
          )}
    </>
  );
}
