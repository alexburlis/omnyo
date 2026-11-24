import { useRef, useState, type ReactNode, type Ref } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import {
  useIsSidebarShowing,
  useSidebarKeepsCollapsedRail,
} from "@/components/ui/sidebar.js";
import {
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS,
} from "@omnyo/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  BROWSER_COLLAPSED_HEADER_RESERVE_CLASS,
  CHROME_ROW_CLASS,
  CHROME_ROW_HEIGHT_CLASS,
  getOmnyoDesktopInfo,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/omnyo-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { scrollPageToTop } from "@/lib/page-scroll-to-top";

export const HEADER_ICON_BUTTON_CLASS = COARSE_POINTER_HEADER_ICON_BUTTON_CLASS;

export const HEADER_PANE_ACTION_ICON_BUTTON_CLASS =
  COARSE_POINTER_HEADER_REDUCED_GLYPH_ICON_BUTTON_CLASS;

export const HEADER_SEAM_CLASS = "border-b border-border-seam-vertical/60";

export const APP_PAGE_HEADER_SURFACE_CLASS = "bg-surface-scrim";

interface AppPageHeaderProps {
  center?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerRef?: Ref<HTMLElement>;
  isWindowDragRegion?: boolean;
  ownsWindowTopLeft?: boolean;
}

export function AppPageHeader({
  center,
  actions,
  className,
  headerRef,
  isWindowDragRegion = true,
  ownsWindowTopLeft = true,
}: AppPageHeaderProps) {
  const isSidebarShowing = useIsSidebarShowing();
  const sidebarKeepsCollapsedRail = useSidebarKeepsCollapsedRail();
  const isCompactViewport = useIsCompactViewport();
  const localHeaderRef = useRef<HTMLElement>(null);
  const composedHeaderRef = useComposedRefs(headerRef, localHeaderRef);

  const handleScrollToTop = () => {
    if (localHeaderRef.current) scrollPageToTop(localHeaderRef.current);
  };

  const [desktopInfo] = useState(getOmnyoDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);

  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });

  const windowTopLeftReserveClassName =
    ownsWindowTopLeft && (isCompactViewport || !isSidebarShowing)
      ? !sidebarKeepsCollapsedRail &&
        (reserveMacosTrafficLights
          ? MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS
          : BROWSER_COLLAPSED_HEADER_RESERVE_CLASS)
      : false;

  return (
    <header
      ref={composedHeaderRef}
      data-app-page-header=""
      onClick={
        isCompactViewport
          ? (event) => {
              if (
                event.defaultPrevented ||
                !(event.target instanceof Element) ||
                event.target.closest(
                  'button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])',
                )
              ) {
                return;
              }

              handleScrollToTop();
            }
          : undefined
      }
      className={cn(
        CHROME_ROW_HEIGHT_CLASS,
        HEADER_SEAM_CLASS,
        APP_PAGE_HEADER_SURFACE_CLASS,
        "@container/page-header relative shrink-0 select-none px-4",
        usesDesktopChrome && isWindowDragRegion && MACOS_WINDOW_DRAG_CLASS,
        className,
      )}
    >
      {isCompactViewport ? (
        <button
          type="button"
          aria-label="Scroll to top"
          className="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onClick={handleScrollToTop}
        />
      ) : null}
      <div
        data-testid="app-page-header-content-row"
        className={cn(
          CHROME_ROW_CLASS,
          "relative z-10 gap-1 md:gap-2",
          isCompactViewport && "pointer-events-none",
          usesDesktopChrome && MACOS_CHROME_CONTROL_AXIS_CLASS,
          windowTopLeftReserveClassName,
        )}
      >
        {center ? (
          <div
            data-app-page-header-center=""
            className="-my-1 -ml-2 flex min-w-16 flex-1 items-center overflow-hidden py-1 pl-2 pr-1"
          >
            <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2">
              {center}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {actions ? (
          <div
            className={cn(
              "pointer-events-auto flex min-w-0 shrink items-center gap-1",
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
