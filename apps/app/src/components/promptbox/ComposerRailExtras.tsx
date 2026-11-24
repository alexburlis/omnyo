import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./composer-tool-button";

export function ComposerRailExtras({ children }: { children: ReactNode }) {
  const isCompactViewport = useIsCompactViewport();

  if (isCompactViewport) {
    return (
      <div
        data-composer-rail-extras=""
        className="flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
      >
        <div className="ml-auto flex w-max shrink-0 items-center gap-1">
          {children}
        </div>
      </div>
    );
  }

  return (
    <OverflowingComposerRailExtras>{children}</OverflowingComposerRailExtras>
  );
}

function OverflowingComposerRailExtras({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const requiredWidthRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const measuresWhileCollapsed = collapsed && !open;

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const measure = () => {
      const content = contentRef.current;

      if (content) requiredWidthRef.current = content.scrollWidth;
      const next = requiredWidthRef.current > container.clientWidth + 1;
      setCollapsed(next);

      if (!next) setOpen(false);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);

    if (contentRef.current) observer.observe(contentRef.current);

    return () => observer.disconnect();
  }, [collapsed, measuresWhileCollapsed]);

  return (
    <div
      ref={containerRef}
      data-composer-rail-extras=""
      className="relative flex min-w-0 flex-1 justify-end"
    >
      {collapsed ? (
        <>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="More composer controls"
                className={COMPOSER_TOOL_BUTTON_CLASS}
              >
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              aria-label="Composer controls"
              className="flex w-max max-w-[min(28rem,calc(100vw-2rem))] flex-wrap items-center gap-2 p-2"
            >
              {children}
            </PopoverContent>
          </Popover>
          {measuresWhileCollapsed ? (
            <div
              ref={contentRef}
              aria-hidden
              inert
              data-composer-rail-extras-measure=""
              className="pointer-events-none invisible absolute top-0 right-0 flex h-0 w-max items-center gap-1 overflow-hidden"
            >
              {children}
            </div>
          ) : null}
        </>
      ) : (
        <div
          ref={contentRef}
          className="flex w-max shrink-0 items-center gap-1"
        >
          {children}
        </div>
      )}
    </div>
  );
}
