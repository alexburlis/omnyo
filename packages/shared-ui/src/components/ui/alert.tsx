import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>[data-icon-root]+div]:translate-y-[-3px] [&>[data-icon-root]]:absolute [&>[data-icon-root]]:left-4 [&>[data-icon-root]]:top-4 [&>[data-icon-root]]:size-4 [&>[data-icon-root]~*]:pl-7",
  {
    variants: {
      variant: {
        default:
          "border-border bg-surface-raised text-foreground [&>[data-icon-root]]:text-muted-foreground",
        destructive:
          "border-surface-destructive-border bg-surface-destructive text-destructive-text [&>[data-icon-root]]:text-destructive-text",
        warning:
          "border-warning/30 bg-warning/10 text-foreground [&>[data-icon-root]]:text-warning-text",
        success:
          "border-success/30 bg-success/10 text-foreground [&>[data-icon-root]]:text-success-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));

Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-5", className)}
    {...props}
  />
));

AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-sm leading-5 text-muted-foreground [&_p]:leading-relaxed",
      className,
    )}
    {...props}
  />
));

AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
