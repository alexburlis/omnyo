import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";
import { Icon, type IconName } from "./icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export type MetaChipTone = "neutral" | "attention" | "success" | "error";

const META_CHIP_TONE_CLASS: Record<MetaChipTone, string> = {
  neutral: "bg-state-hover text-muted-foreground",
  attention: "bg-surface-attention text-foreground",
  success: "bg-success/12 text-success-foreground",
  error: "bg-destructive/10 text-destructive-text",
};

export function MetaChip({
  icon,
  label,
  description,
  tone = "neutral",
  className,
}: {
  icon?: IconName;
  label?: ReactNode;
  description: string;
  tone?: MetaChipTone;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={description}
            className={cn(
              "inline-flex h-5 shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-xs font-medium tabular-nums [&_[data-icon-root]]:size-3.5 [&_[data-icon-root]]:shrink-0",
              label === undefined && "w-5 justify-center px-0",
              META_CHIP_TONE_CLASS[tone],
              FOCUS_RING_CLASS,
              className,
            )}
          >
            {icon === undefined ? null : (
              <Icon name={icon} aria-hidden="true" />
            )}
            {label === undefined ? null : (
              <span aria-hidden="true">{label}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
