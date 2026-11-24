import type { ReactNode } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PROMPT_STACK_TRACK_CLASS } from "./banner/PromptStackCard";

export function ComposerBannerStack({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-composer-banner-stack=""
      className={cn(
        "grid max-h-[min(12rem,calc(var(--omnyo-shell-height,100dvh)*0.25))] min-w-0 gap-2 overflow-x-hidden overflow-y-auto overscroll-contain has-[[data-queue-attached]]:-mb-5 md:max-h-none md:overflow-visible",
        PROMPT_STACK_TRACK_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}
