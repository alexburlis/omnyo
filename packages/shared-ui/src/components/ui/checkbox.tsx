import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

import { cn } from "../../lib/utils";
import { Icon } from "../../components/ui/icon.js";
import { FOCUS_RING_CLASS } from "./focus-ring.js";

const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      `peer size-4 shrink-0 rounded-sm border border-input shadow-xs transition-colors duration-(--motion-duration-base) ${FOCUS_RING_CLASS} disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background`,
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      forceMount
      className="flex items-center justify-center text-current transition-[opacity,scale] duration-(--motion-duration-base) ease-(--motion-ease-snappy) motion-reduce:transition-opacity data-[state=unchecked]:scale-95 data-[state=unchecked]:opacity-0"
    >
      <Icon name="Check" className="size-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));

Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
