import * as React from "react";

import { COARSE_POINTER_TEXT_BASE_CLASS } from "./coarse-pointer-sizing.js";
import { cn } from "../../lib/utils";
import { FIELD_FOCUS_RING_CLASS } from "./focus-ring.js";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        `flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 ${CONTROL_HOVER_TRANSITION} placeholder:text-muted-foreground ${FIELD_FOCUS_RING_CLASS} disabled:cursor-not-allowed disabled:opacity-50`,
        COARSE_POINTER_TEXT_BASE_CLASS,
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";

export { Textarea };
