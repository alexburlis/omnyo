import { ThreadCreationPlacementScope } from "./ThreadCreationPlacement.js";
import { memo, type ReactNode } from "react";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import {
  TopLevelSidebarSection,
  type TopLevelSidebarSectionProps,
} from "./TopLevelSidebarSection.js";
import { useSidebarSortable } from "@/components/ui/sortable-motion";
import { CHRONOLOGICAL_CONTAINER_ID } from "../model/project-thread-groups.js";
import {
  isCollapsibleSidebarSectionId,
  type CollapsibleSidebarSectionId,
  type SidebarSectionId,
} from "../model/sidebar-section-id.js";
import type { CollapsedChildActivity } from "../model/thread-activity.js";
import { PINNED_THREAD_PARENT_KEY } from "../dnd/useSectionThreadDnd.js";
import type { ThreadSplitIndicatorTarget } from "./groupRollups.js";

interface SortableSidebarSectionProps extends TopLevelSidebarSectionProps {
  disabled: boolean;
  id: SidebarSectionId;
}

export interface BuiltInSidebarSectionOptions {
  activity?: CollapsedChildActivity;
  actions?: ReactNode;
  actionsOpen?: boolean;
  collapsedThreads?: readonly ThreadSplitIndicatorTarget[];
  content: ReactNode;
  label: string;
  status?: ReactNode;
}

interface BuiltInSidebarSectionProps extends BuiltInSidebarSectionOptions {
  consumeClickSuppression?: ConsumeDragClickSuppression;
  disabled: boolean;
  id: CollapsibleSidebarSectionId;
  isCollapsed: boolean;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
}

const BUILT_IN_SECTION_DROP_PARENT_KEY: Record<
  CollapsibleSidebarSectionId,
  string | undefined
> = {
  pinned: PINNED_THREAD_PARENT_KEY,
  threads: CHRONOLOGICAL_CONTAINER_ID,
  shelf: undefined,
};

export type BuiltInSidebarSectionOptionsById = Record<
  CollapsibleSidebarSectionId,
  BuiltInSidebarSectionOptions
>;

interface RenderBuiltInSidebarSectionArgs {
  collapsedSectionIds: ReadonlySet<CollapsibleSidebarSectionId>;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  disabled: boolean;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
  sectionId: SidebarSectionId;
  sections: BuiltInSidebarSectionOptionsById;
  showPinnedSection: boolean;
}

export const SortableSidebarSection = memo(function SortableSidebarSection({
  id,
  disabled,
  ...props
}: SortableSidebarSectionProps) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id,
    disabled,
  });

  return (
    <TopLevelSidebarSection
      {...props}
      dragBindings={props.labelEditor ? undefined : dragBindings}
      sectionRef={setNodeRef}
      sectionStyle={style}
    />
  );
});

function BuiltInSidebarSection({
  actions,
  actionsOpen,
  activity,
  collapsedThreads,
  consumeClickSuppression,
  content,
  disabled,
  id,
  isCollapsed,
  label,
  onToggleCollapsed,
  status,
}: BuiltInSidebarSectionProps) {
  return (
    <SortableSidebarSection
      id={id}
      label={label}
      status={status}
      stickyHeader={id !== "pinned"}
      disabled={disabled}
      actions={actions}
      actionsOpen={actionsOpen}
      collapsedActivity={activity}
      collapsedThreads={collapsedThreads}
      actionsMobileAlways
      collapseControl={{
        isCollapsed,
        onToggleCollapsed: () => onToggleCollapsed(id),
      }}
      consumeClickSuppression={consumeClickSuppression}
      dropParentKey={BUILT_IN_SECTION_DROP_PARENT_KEY[id]}
    >
      <ThreadCreationPlacementScope group={id}>
        {content}
      </ThreadCreationPlacementScope>
    </SortableSidebarSection>
  );
}

export function renderBuiltInSidebarSection({
  collapsedSectionIds,
  consumeClickSuppression,
  disabled,
  onToggleCollapsed,
  sectionId,
  sections,
  showPinnedSection,
}: RenderBuiltInSidebarSectionArgs): ReactNode | undefined {
  if (!isCollapsibleSidebarSectionId(sectionId)) {
    return undefined;
  }

  if (sectionId === "pinned" && !showPinnedSection) return undefined;

  return (
    <BuiltInSidebarSection
      {...sections[sectionId]}
      key={sectionId}
      id={sectionId}
      disabled={disabled}
      isCollapsed={collapsedSectionIds.has(sectionId)}
      onToggleCollapsed={onToggleCollapsed}
      consumeClickSuppression={consumeClickSuppression}
    />
  );
}
