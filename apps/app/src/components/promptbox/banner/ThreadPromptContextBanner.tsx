import { CONTEXT_CARD_TOGGLE_CLASS } from "@omnyo/shared-ui/chrome-style-tokens";
import {
  machineRemovalDescriptions,
  machineRemovalLabels,
  type MachineRemovalStatus,
} from "@/lib/machine-removal-display";
import type { ReactNode, RefObject } from "react";
import { NavLink } from "react-router-dom";
import type {
  EnvironmentStatus,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_CONTEXT_BANNER_COLLAPSED_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
} from "@omnyo/shared-ui/activity-row-styles";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { MetaChip } from "@omnyo/shared-ui/meta-chip";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  useDisclosureFocusHandoff,
} from "@omnyo/shared-ui/prompt-stack-disclosure";
import { PromptStackTrailing } from "@/components/promptbox/banner/prompt-stack-header";
import {
  BannerActionSlot,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork" | "handoff";
}

export interface ThreadPromptContinuedInSection {
  title: string;
  href: string;
  otherCount: number;
}

interface ThreadPromptChildThreadItem {
  id: string;
  title: string;
  href: string;
  hasPendingInteraction: boolean;
}

export interface ThreadPromptChildThreadsSection {
  items: readonly ThreadPromptChildThreadItem[];
}

export interface ThreadPromptArchivedSection {
  archivedAt: number;
  onUnarchive?: () => void;
  unarchivePending?: boolean;
}

export interface ThreadPromptEnvironmentGoneSection {
  status: Extract<EnvironmentStatus, "destroyed"> | MachineRemovalStatus;
  onRestore?: () => void;
  restorePending?: boolean;
}

const THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES: ReadonlySet<ThreadRuntimeDisplayStatus> =
  new Set(["active", "provisioning", "starting", "waiting-for-host"]);

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES.has(status);
}

export type ThreadPromptContextBannerExpandedSection =
  | "parentThread"
  | "childThreads"
  | "status";

interface ThreadPromptContextBannerProps {
  archivedSection: ThreadPromptArchivedSection | null;
  environmentGoneSection: ThreadPromptEnvironmentGoneSection | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  continuedInSection: ThreadPromptContinuedInSection | null;
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

const ARCHIVED_THREAD_STATUS_LABEL = "Thread is archived";

const ENVIRONMENT_GONE_STATUS_COPY: Record<
  ThreadPromptEnvironmentGoneSection["status"],
  { description: string; label: string }
> = {
  destroyed: {
    description:
      "Environment unavailable. You can still view this thread’s history.",
    label: "Environment unavailable",
  },
  removed: {
    label: machineRemovalLabels.removed,
    description: machineRemovalDescriptions.removed,
  },
  removing: {
    label: machineRemovalLabels.removing,
    description: machineRemovalDescriptions.removing,
  },
  "cleanup-failed": {
    label: machineRemovalLabels["cleanup-failed"],
    description: machineRemovalDescriptions["cleanup-failed"],
  },
};

const SECTION_IDS = {
  parentThread: {
    toggle: "thread-prompt-banner-parent-thread-toggle",
    body: "thread-prompt-banner-parent-thread-body",
  },
  childThreads: {
    toggle: "thread-prompt-banner-child-threads-toggle",
    body: "thread-prompt-banner-child-threads-body",
  },
  status: {
    toggle: "thread-prompt-banner-status-toggle",
    body: "thread-prompt-banner-status-body",
  },
} as const;

const SEGMENT_SHRINK_CLASS = "min-w-0 overflow-hidden";

function ChildThreadIcon({ className }: { className?: string }) {
  return (
    <Icon
      name="ChevronDown"
      className={cn("size-3.5 shrink-0 rotate-45", className)}
      aria-hidden="true"
    />
  );
}

interface SectionToggleButtonProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  fillRow: boolean;
  id: string;
  controlsId: string;
  ariaLabel?: string;
  icon: ReactNode;
  label: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}

function SectionToggleButton({
  buttonRef,
  fillRow,
  id,
  controlsId,
  ariaLabel,
  icon,
  label,
  isExpanded,
  onToggle,
}: SectionToggleButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      id={id}
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        CONTEXT_CARD_TOGGLE_CLASS,
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        SEGMENT_SHRINK_CLASS,
        label !== null && label !== undefined ? "gap-1.5" : "gap-0",
        fillRow && "flex-1 justify-start text-left",
        PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
        isExpanded ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {label !== null && label !== undefined ? (
        <span className="min-w-0 truncate">{label}</span>
      ) : null}
      {fillRow ? <PromptStackTrailing isExpanded={isExpanded} /> : null}
    </button>
  );
}

const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string }
> = {
  parent: {
    verb: "Child of",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent thread",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
  },
  handoff: {
    verb: "Continued from",
    bodyLead: "This thread continues ",
    ariaPrefix: "Continued from",
  },
};

const PARENT_SECTION_ICON: Record<
  ThreadPromptParentThreadSection["relationship"],
  IconName
> = {
  parent: "UserRound",
  fork: "Fork",
  handoff: "ArrowTurnForward",
};

function useParentSectionAriaLabel(
  section: ThreadPromptParentThreadSection,
): string {
  const parentThreadTitle = useThreadTitleDisplayText(
    section.parentThreadTitle,
  );

  return `${PARENT_SECTION_COPY[section.relationship].ariaPrefix} ${parentThreadTitle}`;
}

const PARENT_THREAD_TITLE_CLASS =
  "text-foreground/90 underline underline-offset-2";

function ParentThreadInlineSegment({
  section,
}: {
  section: ThreadPromptParentThreadSection;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
      )}
      title={ariaLabel}
    >
      <Icon
        name={PARENT_SECTION_ICON[section.relationship]}
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {PARENT_SECTION_COPY[section.relationship].verb}{" "}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
      </span>
    </div>
  );
}

function continuedInOtherLabel(count: number): string {
  return `Also continued in ${count} other ${count === 1 ? "thread" : "threads"}`;
}

function ContinuedInInlineSegment({
  section,
}: {
  section: ThreadPromptContinuedInSection;
}) {
  const title = useThreadTitleDisplayText(section.title);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
      )}
      title={`Continued in ${title}`}
    >
      <Icon
        name="ArrowTurnForward"
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        Continued in{" "}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.title}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
      </span>
      {section.otherCount > 0 ? (
        <MetaChip
          label={`+${section.otherCount} more`}
          description={continuedInOtherLabel(section.otherCount)}
          className="text-2xs"
        />
      ) : null}
    </div>
  );
}

function ParentThreadSectionToggle({
  section,
  buttonRef,
  isExpanded,
  onToggle,
}: {
  section: ThreadPromptParentThreadSection;
  buttonRef: RefObject<HTMLButtonElement | null>;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);

  return (
    <SectionToggleButton
      buttonRef={buttonRef}
      fillRow={false}
      id={SECTION_IDS.parentThread.toggle}
      controlsId={SECTION_IDS.parentThread.body}
      ariaLabel={ariaLabel}
      icon={
        <Icon
          name={PARENT_SECTION_ICON[section.relationship]}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
      }
      label={null}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

function ParentThreadSectionBody({
  section,
  isExpanded,
  collapseRef,
  onCollapse,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
  collapseRef: RefObject<HTMLButtonElement | null>;
  onCollapse: () => void;
}) {
  return (
    <AnimatedDisclosureBody
      collapsedBorder="reserve"
      id={SECTION_IDS.parentThread.body}
      labelledBy={SECTION_IDS.parentThread.toggle}
      isExpanded={isExpanded}
      collapseLabel="Collapse parent thread"
      collapseRef={collapseRef}
      onCollapse={onCollapse}
    >
      <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
        {PARENT_SECTION_COPY[section.relationship].bodyLead}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
        .
      </div>
    </AnimatedDisclosureBody>
  );
}

function ChildThreadsBody({
  items,
}: {
  items: readonly ThreadPromptChildThreadItem[];
}) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <NavLink
            to={item.href}
            className="flex min-w-0 items-center gap-2 py-0.5 text-foreground/90 underline-offset-2 hover:underline"
          >
            {item.hasPendingInteraction ? (
              <Icon
                name="CircleQuestion"
                className="size-3.5 shrink-0 text-muted-foreground/75 no-underline"
                aria-hidden="true"
              />
            ) : (
              <ChildThreadIcon className="text-subtle-foreground no-underline" />
            )}
            <ThreadTitle title={item.title} tooltip className="flex-1" />
            {item.hasPendingInteraction ? (
              <span className="shrink-0 text-muted-foreground">
                Needs input
              </span>
            ) : null}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function PendingBannerActionButton({
  pending,
  label,
  pendingLabel,
  onClick,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  onClick: () => void;
}) {
  return (
    <PromptBannerActionButton onClick={onClick} disabled={pending}>
      {pending ? pendingLabel : label}
    </PromptBannerActionButton>
  );
}

function childThreadsLabel(args: {
  count: number;
  pendingCount: number;
}): string {
  if (args.pendingCount > 0) {
    return `${args.pendingCount} child ${args.pendingCount === 1 ? "thread needs" : "threads need"} input`;
  }

  return `${args.count} active child ${args.count === 1 ? "thread" : "threads"}`;
}

function ActiveChildThreadsCard({
  childThreadsSection,
  isExpanded,
  onToggle,
}: {
  childThreadsSection: ThreadPromptChildThreadsSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const items = [...childThreadsSection.items].sort((left, right) =>
    left.hasPendingInteraction === right.hasPendingInteraction
      ? 0
      : left.hasPendingInteraction
        ? -1
        : 1,
  );

  const primary = items[0];
  const primaryTitle = useThreadTitleDisplayText(primary?.title ?? "");
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);

  if (!primary) {
    return null;
  }

  const pendingCount = items.filter(
    (item) => item.hasPendingInteraction,
  ).length;

  const otherCount = items.length - 1;

  const groupLabel = childThreadsLabel({
    count: items.length,
    pendingCount,
  });

  const needsApproval = pendingCount > 0;

  return (
    <PromptStackCard
      ariaLabel="Child threads"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          ref={focus.triggerRef}
          type="button"
          id={SECTION_IDS.childThreads.toggle}
          aria-expanded={isExpanded}
          aria-controls={SECTION_IDS.childThreads.body}
          aria-label={`${groupLabel}: ${primaryTitle}`}
          onClick={focus.onTriggerClick}
          className={cn(
            needsApproval
              ? PROMPT_STACK_CARD_HEADER_BUTTON_CLASS
              : activityRowClass(
                  "active",
                  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
                ),
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          )}
        >
          <Icon
            name={needsApproval ? "CircleQuestion" : "UserRound"}
            className={
              needsApproval
                ? "size-3.5 shrink-0 text-muted-foreground/75"
                : activityIconClass("active", "size-3.5 shrink-0")
            }
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="text-muted-foreground">
              {needsApproval ? "Needs your input: " : "Active child thread: "}
            </span>
            <ThreadTitle
              title={primary.title}
              className="font-medium text-foreground/80"
              inline
            />
          </span>
          <PromptStackTrailing isExpanded={isExpanded} moreCount={otherCount} />
        </button>
      </div>
      <AnimatedDisclosureBody
        collapsedBorder="reserve"
        id={SECTION_IDS.childThreads.body}
        labelledBy={SECTION_IDS.childThreads.toggle}
        isExpanded={isExpanded}
        collapseLabel="Collapse child threads"
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <ChildThreadsBody items={items} />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}

interface ReadOnlyContextBannerProps {
  iconName: IconName;
  statusLabel: string;
  description: string | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  continuedInSection: ThreadPromptContinuedInSection | null;
  statusAction: ReactNode;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

function ReadOnlyContextBanner({
  iconName,
  statusLabel,
  description,
  parentThreadSection,
  continuedInSection,
  statusAction,
  expandedSection,
  onToggleSection,
}: ReadOnlyContextBannerProps) {
  const isParentThreadExpanded =
    expandedSection === "parentThread" && parentThreadSection !== null;

  const isStatusExpanded = expandedSection === "status" && description !== null;

  const parentFocus = useDisclosureFocusHandoff(isParentThreadExpanded, () =>
    onToggleSection("parentThread"),
  );

  const statusFocus = useDisclosureFocusHandoff(isStatusExpanded, () =>
    onToggleSection("status"),
  );

  const hasMultipleSegments = parentThreadSection !== null;

  const statusIcon = (
    <Icon name={iconName} className="size-3.5 shrink-0" aria-hidden="true" />
  );

  const showStatusAction = statusAction !== null && !hasMultipleSegments;

  return (
    <PromptStackCard
      ariaLabel="Thread history"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 text-xs text-muted-foreground",
          PROMPT_STACK_INLAY_INSET_CLASS,
        )}
      >
        {parentThreadSection ? (
          <ParentThreadSectionToggle
            section={parentThreadSection}
            buttonRef={parentFocus.triggerRef}
            isExpanded={isParentThreadExpanded}
            onToggle={parentFocus.onTriggerClick}
          />
        ) : null}
        {continuedInSection ? (
          <ContinuedInInlineSegment section={continuedInSection} />
        ) : null}
        {description === null ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs",
              PROMPT_STACK_INLAY_SEGMENT_CLASS,
            )}
            role="status"
            aria-label={statusLabel}
          >
            {statusIcon}
            <span className="min-w-0 truncate" aria-hidden="true">
              {statusLabel}
            </span>
          </div>
        ) : (
          <SectionToggleButton
            buttonRef={statusFocus.triggerRef}
            fillRow
            id={SECTION_IDS.status.toggle}
            controlsId={SECTION_IDS.status.body}
            icon={statusIcon}
            label={statusLabel}
            isExpanded={isStatusExpanded}
            onToggle={statusFocus.onTriggerClick}
          />
        )}
        {showStatusAction ? (
          <BannerActionSlot>{statusAction}</BannerActionSlot>
        ) : null}
      </div>
      {description === null ? null : (
        <AnimatedDisclosureBody
          collapsedBorder="reserve"
          id={SECTION_IDS.status.body}
          labelledBy={SECTION_IDS.status.toggle}
          isExpanded={isStatusExpanded}
          collapseLabel={`Collapse ${statusLabel.toLowerCase()}`}
          collapseRef={statusFocus.collapseRef}
          onCollapse={statusFocus.onCollapseClick}
        >
          <p className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </AnimatedDisclosureBody>
      )}
      {parentThreadSection ? (
        <ParentThreadSectionBody
          section={parentThreadSection}
          isExpanded={isParentThreadExpanded}
          collapseRef={parentFocus.collapseRef}
          onCollapse={parentFocus.onCollapseClick}
        />
      ) : null}
    </PromptStackCard>
  );
}

export function ThreadPromptContextBanner({
  archivedSection,
  environmentGoneSection,
  parentThreadSection,
  continuedInSection,
  childThreadsSection,
  expandedSection,
  onToggleSection,
}: ThreadPromptContextBannerProps) {
  if (archivedSection || environmentGoneSection) {
    const environmentGone = environmentGoneSection !== null;

    const environmentGoneCopy = environmentGoneSection
      ? ENVIRONMENT_GONE_STATUS_COPY[environmentGoneSection.status]
      : null;

    return (
      <ReadOnlyContextBanner
        iconName={environmentGone ? "CircleX" : "Archive"}
        statusLabel={environmentGoneCopy?.label ?? ARCHIVED_THREAD_STATUS_LABEL}
        description={environmentGoneCopy?.description ?? null}
        statusAction={
          archivedSection?.onUnarchive ? (
            <PendingBannerActionButton
              pending={Boolean(archivedSection.unarchivePending)}
              label="Unarchive"
              pendingLabel="Unarchiving..."
              onClick={archivedSection.onUnarchive}
            />
          ) : environmentGoneSection?.onRestore ? (
            <PendingBannerActionButton
              pending={Boolean(environmentGoneSection.restorePending)}
              label="Restore workspace"
              pendingLabel="Restoring..."
              onClick={environmentGoneSection.onRestore}
            />
          ) : null
        }
        parentThreadSection={parentThreadSection}
        continuedInSection={continuedInSection}
        expandedSection={expandedSection}
        onToggleSection={onToggleSection}
      />
    );
  }

  const activeChildThreadsCard =
    childThreadsSection !== null && childThreadsSection.items.length > 0 ? (
      <ActiveChildThreadsCard
        childThreadsSection={childThreadsSection}
        isExpanded={expandedSection === "childThreads"}
        onToggle={() => onToggleSection("childThreads")}
      />
    ) : null;

  const parentThreadCard =
    parentThreadSection || continuedInSection ? (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className="overflow-hidden"
        style={{ minHeight: PROMPT_CONTEXT_BANNER_COLLAPSED_HEIGHT }}
      >
        <div
          className={cn(
            "flex items-center gap-0.5 text-xs text-muted-foreground",
            PROMPT_STACK_INLAY_INSET_CLASS,
          )}
        >
          {parentThreadSection ? (
            <ParentThreadInlineSegment section={parentThreadSection} />
          ) : null}
          {continuedInSection ? (
            <ContinuedInInlineSegment section={continuedInSection} />
          ) : null}
        </div>
      </PromptStackCard>
    ) : null;

  if (activeChildThreadsCard && parentThreadCard) {
    return (
      <div className="min-w-0 space-y-2">
        {activeChildThreadsCard}
        {parentThreadCard}
      </div>
    );
  }

  return activeChildThreadsCard ?? parentThreadCard;
}
