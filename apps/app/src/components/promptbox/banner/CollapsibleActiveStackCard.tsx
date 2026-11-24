import type { ReactNode } from "react";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { PromptBannerActionButton } from "@/components/promptbox/banner/prompt-banner-actions";
import { PromptStackDisclosureChevron } from "@/components/promptbox/banner/prompt-stack-header";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@omnyo/shared-ui/activity-row-styles";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  useDisclosureFocusHandoff,
} from "@omnyo/shared-ui/prompt-stack-disclosure";

const HEADER_GROUP_CLASS = activityRowClass(
  "active",
  "flex w-full items-center rounded-none px-0 py-0",
);

const HEADER_BUTTON_CLASS =
  "flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-none bg-transparent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";

interface CollapsibleActiveStackCardProps {
  cardAriaLabel: string;
  controlsAriaLabel: string;
  toggleId: string;
  bodyId: string;
  toggleAriaLabel: string;
  iconName: IconName;
  title: string;
  description?: string;
  isExpanded: boolean;
  onToggle: () => void;
  dismiss: {
    ariaLabel: string;
    label: string;
    pendingLabel: string;
    isPending: boolean;
    onDismiss: () => void;
  } | null;
  children: ReactNode;
}

export function CollapsibleActiveStackCard({
  cardAriaLabel,
  controlsAriaLabel,
  toggleId,
  bodyId,
  toggleAriaLabel,
  iconName,
  title,
  description,
  isExpanded,
  onToggle,
  dismiss,
  children,
}: CollapsibleActiveStackCardProps) {
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);

  return (
    <PromptStackCard
      ariaLabel={cardAriaLabel}
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        role="group"
        aria-label={controlsAriaLabel}
        className={HEADER_GROUP_CLASS}
      >
        <button
          ref={focus.triggerRef}
          type="button"
          id={toggleId}
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          aria-label={toggleAriaLabel}
          onClick={focus.onTriggerClick}
          className={cn(
            HEADER_BUTTON_CLASS,
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          )}
        >
          <Icon
            name={iconName}
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "shrink-0 text-left font-medium",
            )}
          >
            {title}
          </span>
          {description ? (
            <span
              data-promptbox-hide-tiny=""
              className="min-w-0 truncate text-left text-muted-foreground"
            >
              {description}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center pl-1">
            <PromptStackDisclosureChevron isExpanded={isExpanded} />
          </span>
        </button>
        {dismiss ? (
          <PromptBannerActionButton
            aria-label={dismiss.ariaLabel}
            onClick={dismiss.onDismiss}
            disabled={dismiss.isPending}
            className="mr-1.5 disabled:cursor-wait"
          >
            {dismiss.isPending ? (
              <Icon
                name="Loading"
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : null}
            {dismiss.isPending ? dismiss.pendingLabel : dismiss.label}
          </PromptBannerActionButton>
        ) : null}
      </div>
      <AnimatedDisclosureBody
        id={bodyId}
        labelledBy={toggleId}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel={`Collapse ${title}`}
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        {children}
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
