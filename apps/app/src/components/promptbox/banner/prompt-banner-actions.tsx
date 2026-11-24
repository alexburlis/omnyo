import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { buttonVariants } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";

export const PROMPT_BANNER_ACTION_BUTTON_CLASS = cn(
  buttonVariants({ variant: "soft", size: "xs" }),
  "disabled:cursor-not-allowed",
);

export const PromptBannerActionButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PromptBannerActionButton(
  { className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(PROMPT_BANNER_ACTION_BUTTON_CLASS, className)}
      {...props}
    />
  );
});

export const PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS =
  "relative bg-surface-raised-solid before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-r before:from-transparent before:to-surface-raised-solid before:content-['']";

export function BannerActionSlot({
  children,
  hideInTiny = true,
}: {
  children: ReactNode;
  hideInTiny?: boolean;
}) {
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-1.5 pr-1.5 text-xs text-muted-foreground"
      data-promptbox-hide-tiny={hideInTiny ? "" : undefined}
    >
      {children}
    </div>
  );
}
