import type { ReactNode } from "react";
import { BottomAnchoredScrollBody } from "./bottom-anchored-scroll-body.js";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { OverflowFade } from "./overflow-fade.js";

type PageShellScrollBehavior = "bottom-anchor" | "static";

interface PageShellBaseProps {
  children: ReactNode;
  footer?: ReactNode;
  scrollOverlay?: ReactNode;
  shellClassName?: string;
  scrollAreaClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  maxWidthClassName?: string;
}

interface PageShellProps extends PageShellBaseProps {
  scrollBehavior?: PageShellScrollBehavior;
  animateFollowLatest?: boolean;
}

const SHELL_BLEED_CLASS =
  "-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5";

const DEFAULT_MAX_WIDTH_CLASS = "max-w-[760px]";

export const THREAD_TIMELINE_SHELL_PROPS = {
  shellClassName: "!mx-0 !mt-0 md:!mx-0 md:!mt-0",
  scrollAreaClassName: "scroll-pt-4",
  contentClassName: "gap-2 pt-4",
  footerClassName: "chat-prompt-box",
} as const satisfies Pick<
  PageShellProps,
  | "shellClassName"
  | "scrollAreaClassName"
  | "contentClassName"
  | "footerClassName"
>;

export function threadPageFrameClassName(isBoundedPane: boolean): string {
  return cn(
    "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip",
    !isBoundedPane && "-mx-4 -mb-4 -mt-4 md:-mx-5 md:-mb-5 md:-mt-5",
  );
}

export function PageShellFooter({
  children,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
}: {
  children: ReactNode;
  footerClassName?: string;
  maxWidthClassName?: string;
}) {
  if (!children) return null;

  return (
    <div className="relative shrink-0 bg-background">
      <OverflowFade placement="above" tone="background" />
      <div
        className={cn(
          "mx-auto w-full px-4 pb-4 max-md:px-3 max-md:pb-2",
          maxWidthClassName,
          footerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function PageShell({
  children,
  footer,
  scrollOverlay,
  shellClassName,
  scrollAreaClassName,
  contentClassName,
  footerClassName,
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS,
  scrollBehavior = "static",
  animateFollowLatest,
}: PageShellProps) {
  const staticFooter = footer ? (
    <PageShellFooter
      footerClassName={footerClassName}
      maxWidthClassName={maxWidthClassName}
    >
      {footer}
    </PageShellFooter>
  ) : null;

  if (scrollBehavior === "bottom-anchor") {
    return (
      <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
        <BottomAnchoredScrollBody
          scrollAreaClassName={scrollAreaClassName}
          contentClassName={contentClassName}
          maxWidthClassName={maxWidthClassName}
          footer={staticFooter}
          scrollOverlay={scrollOverlay}
          animateFollowLatest={animateFollowLatest}
        >
          {children}
        </BottomAnchoredScrollBody>
      </div>
    );
  }

  return (
    <div className={cn(SHELL_BLEED_CLASS, shellClassName)}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          data-page-scroll-viewport=""
          className={cn(
            "@container/page min-h-0 flex-1 overflow-y-auto",
            scrollAreaClassName,
          )}
        >
          <div
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              maxWidthClassName,
              contentClassName,
            )}
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
          </div>
        </div>
        {staticFooter}
      </div>
    </div>
  );
}
