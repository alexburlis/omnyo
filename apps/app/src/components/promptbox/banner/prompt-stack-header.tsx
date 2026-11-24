import { useState } from "react";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  useChangedSinceMount,
} from "@omnyo/shared-ui/motion";

export function useOwnerRevealedIds(
  isExpanded: boolean,
  ids: readonly string[],
): ReadonlySet<string> | null {
  const changed = useChangedSinceMount(isExpanded);

  const [revealed, setRevealed] = useState<{
    expanded: boolean;
    ids: ReadonlySet<string> | null;
  }>({ expanded: isExpanded, ids: null });

  if (revealed.expanded !== isExpanded) {
    setRevealed({
      expanded: isExpanded,
      ids: isExpanded && changed ? new Set(ids) : null,
    });
  }

  return revealed.ids;
}

const TRAILING_SLOT_CLASS =
  "-mr-1.5 ml-auto flex shrink-0 items-center justify-center gap-1.5 pl-1";

export function PromptStackDisclosureChevron({
  isExpanded,
}: {
  isExpanded: boolean;
}) {
  return (
    <Icon
      name="ChevronDown"
      className={cn(
        "size-3.5 shrink-0 text-subtle-foreground group-hover/disclosure:text-foreground",
        DISCLOSURE_CHEVRON_TRANSITION,
        isExpanded && "rotate-180",
      )}
      aria-hidden="true"
    />
  );
}

export function PromptStackMoreCount({ count }: { count: number }) {
  return (
    <span
      data-prompt-stack-more=""
      className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-state-hover px-1.5 text-2xs font-medium tabular-nums text-muted-foreground"
    >
      {`+${count} more`}
    </span>
  );
}

export function PromptStackTrailing({
  isExpanded,
  moreCount = 0,
}: {
  isExpanded: boolean;
  moreCount?: number;
}) {
  return (
    <span className={TRAILING_SLOT_CLASS}>
      {moreCount > 0 ? <PromptStackMoreCount count={moreCount} /> : null}
      <PromptStackDisclosureChevron isExpanded={isExpanded} />
    </span>
  );
}
