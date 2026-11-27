import type { HTMLAttributes } from "react";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "prose", "lead", "display", "numeral"],
      shadow: ["control", "control-primary", "card", "card-hover", "lift"],
    },
  },
});

export function cn(...classes: ClassValue[]) {
  return twMerge(clsx(classes));
}

export function Alert({
  variant,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant: "warning" | "destructive" }) {
  return (
    <div
      role="alert"
      className={cn(
        "relative w-full rounded-lg border px-4 py-3 text-sm [&>[data-icon-root]+div]:translate-y-[-3px] [&>[data-icon-root]]:absolute [&>[data-icon-root]]:left-4 [&>[data-icon-root]]:top-4 [&>[data-icon-root]]:size-4 [&>[data-icon-root]~*]:pl-7",
        variant === "warning"
          ? "border-warning/30 bg-warning/10 text-foreground [&>[data-icon-root]]:text-warning-text"
          : "border-surface-destructive-border bg-surface-destructive text-destructive-text [&>[data-icon-root]]:text-destructive-text",
        className,
      )}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("mb-1 font-medium leading-5", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-sm leading-5 text-muted-foreground [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse motion-reduce:animate-none rounded-md bg-surface-selected",
        className,
      )}
      {...props}
    />
  );
}
