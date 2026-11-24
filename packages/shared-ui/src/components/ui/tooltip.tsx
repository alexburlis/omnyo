import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { TOOLTIP_MOTION } from "./motion.js";
import { isLastInputKeyboard } from "./overlay-trigger.js";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(function TooltipTriggerComponent({ onFocus, ...props }, ref) {
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      onFocus={(event) => {
        onFocus?.(event);

        if (!event.defaultPrevented && !isLastInputKeyboard()) {
          event.preventDefault();
        }
      }}
      {...props}
    />
  );
});

TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContentComponent(
  {
    avoidCollisions = true,
    className,
    collisionPadding = 8,
    hideWhenDetached = true,
    sideOffset = 4,
    ...props
  },
  ref,
) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        {...usePortalScopeProps()}
        avoidCollisions={avoidCollisions}
        collisionPadding={collisionPadding}
        hideWhenDetached={hideWhenDetached}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-[min(20rem,var(--radix-tooltip-content-available-width))] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground break-words origin-(--radix-tooltip-content-transform-origin)",
          TOOLTIP_MOTION,
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
