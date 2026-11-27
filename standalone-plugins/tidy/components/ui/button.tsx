import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring.js";
import { CONTROL_PRESS_FEEDBACK, CONTROL_PRESS_TRANSITION } from "./motion.js";

const buttonVariants = cva(
  `inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ${CONTROL_PRESS_TRANSITION} ${FOCUS_RING_CLASS} disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0`,
  {
    variants: {
      variant: {
        default: `bg-control-primary text-control-primary-foreground shadow-control-primary hover:bg-control-primary-hover ${CONTROL_PRESS_FEEDBACK}`,
        destructive: `bg-destructive text-destructive-foreground shadow-control hover:bg-destructive/90 ${CONTROL_PRESS_FEEDBACK}`,
        outline: `border border-border bg-surface-raised text-foreground shadow-control hover:border-input hover:bg-state-hover hover:text-foreground ${CONTROL_PRESS_FEEDBACK}`,
        secondary: `bg-secondary text-secondary-foreground hover:bg-muted ${CONTROL_PRESS_FEEDBACK}`,
        soft: `bg-state-hover text-foreground hover:bg-state-active ${CONTROL_PRESS_FEEDBACK}`,
        ghost: `${CONTROL_PRESS_FEEDBACK} hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground aria-pressed:hover:bg-state-active data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:hover:bg-state-active`,
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_[data-icon-root]]:size-3.5 pointer-coarse:h-9 pointer-coarse:px-3",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "icon-sm": "size-8",
        "icon-xs": "size-6 [&_[data-icon-root]]:size-3.5 pointer-coarse:size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
