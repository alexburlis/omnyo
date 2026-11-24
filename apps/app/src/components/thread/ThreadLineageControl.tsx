import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import type { ThreadPromptParentThreadSection } from "@/components/promptbox/banner/ThreadPromptContextBanner";

const LINEAGE_CONTROL_CLASS =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground";

export function ThreadLineageControl({
  source,
  destinations,
}: {
  source: ThreadPromptParentThreadSection | null;
  destinations: readonly { href: string; title: string }[];
}) {
  const [destination] = destinations;
  const [open, setOpen] = useState(false);

  return (
    <>
      {source?.relationship === "handoff" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={source.href}
              aria-label={`Continued from ${source.parentThreadTitle}`}
              className={LINEAGE_CONTROL_CLASS}
            >
              <Icon name="ArrowTurnBackward" className="size-4" aria-hidden />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent>
            Continued from {source.parentThreadTitle}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {destinations.length > 1 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={`Continued in ${destinations.length} chats`}
            className={LINEAGE_CONTROL_CLASS}
          >
            <Icon name="ArrowTurnForward" className="size-4" aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label="Continued in"
            mobileTitle="Continued in"
            className="w-64 space-y-0.5 p-1"
          >
            {destinations.map(({ href, title }) => (
              <NavLink
                key={href}
                to={href}
                onClick={() => setOpen(false)}
                className="block rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover focus-visible:bg-state-hover"
              >
                {title}
              </NavLink>
            ))}
          </PopoverContent>
        </Popover>
      ) : destination ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={destination.href}
              aria-label={`Continued in ${destination.title}`}
              className={LINEAGE_CONTROL_CLASS}
            >
              <Icon name="ArrowTurnForward" className="size-4" aria-hidden />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent>Continued in {destination.title}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}
