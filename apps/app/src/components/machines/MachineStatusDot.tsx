import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import type { MachineStatusTone } from "./machine-status";

const TOOLTIP_DELAY_MS = 300;

export function MachineStatusDot({
  connected,
  tone,
  label,
  decorative = false,
  className,
}: {
  connected?: boolean;
  tone?: MachineStatusTone;
  label?: string;
  decorative?: boolean;
  className?: string;
}) {
  const resolved: MachineStatusTone =
    tone ?? (connected === true ? "online" : "offline");

  const announced = label !== undefined && !decorative;

  const dot = (
    <span
      role={announced ? "img" : undefined}
      aria-label={announced ? label : undefined}
      aria-hidden={announced ? undefined : true}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        resolved === "online" && "bg-success",
        resolved === "attention" && "bg-attention",
        resolved === "failed" && "bg-destructive",
        resolved === "offline" && "border border-muted-foreground",
        className,
      )}
    />
  );

  if (label === undefined) return dot;

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>{dot}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
