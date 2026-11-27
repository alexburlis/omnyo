import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";
import { FOCUS_RING_CLASS } from "./focus-ring";

export type ButtonVariant = "default" | "outline" | "soft" | "ghost" | "destructive";

export type ButtonSize = "xs" | "sm" | "icon-xs" | "icon-sm";

const PRESS_TRANSITION =
  "transition-[color,background-color,border-color,scale] duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-safe:active:scale-[0.97]";

const BASE_CLASS = `inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium ${PRESS_TRANSITION} ${FOCUS_RING_CLASS} disabled:pointer-events-none disabled:opacity-50`;

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "bg-foreground text-background hover:bg-foreground/90",
  outline:
    "border border-border bg-surface-raised text-foreground hover:border-input hover:bg-state-hover",
  soft: "bg-state-hover text-foreground hover:bg-state-active",
  ghost: "text-muted-foreground hover:bg-state-hover hover:text-foreground",
  destructive: "text-destructive-text hover:bg-destructive/10",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs pointer-coarse:h-9 pointer-coarse:px-3",
  sm: "h-8 px-3 text-xs",
  "icon-xs": "size-6 pointer-coarse:size-9",
  "icon-sm": "size-8",
};

export function buttonClass(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return cn(BASE_CLASS, VARIANT_CLASS[variant], SIZE_CLASS[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "soft", size = "xs", className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />
  ),
);

Button.displayName = "Button";
