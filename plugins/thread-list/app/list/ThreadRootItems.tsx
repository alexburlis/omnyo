import { memo, type CSSProperties } from "react";
import { ThreadTreeNodeRow } from "./ProjectRow.js";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "@/components/ui/sortable-motion";
import type { ProjectThreadNode } from "../model/project-thread-groups.js";
import type { SectionThreadDndState } from "../dnd/useSectionThreadDnd.js";

export interface SortableThreadRootItemProps {
  collapsedEnvironmentIds: Set<string>;
  disabled: boolean;
  displace?: boolean;
  node: ProjectThreadNode;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  sectionDnd?: SectionThreadDndState | null;
  selectedThreadId?: string;
}

interface ThreadRootItemProps extends Omit<
  SortableThreadRootItemProps,
  "disabled" | "displace"
> {
  consumeClickSuppression?: () => boolean;
  dragBindings?: SidebarSortableDragBindings;
  sortableRef?: (element: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
}

export function getThreadRootNodeId(node: ProjectThreadNode): string {
  return node.thread.id;
}

export const ThreadRootItem = memo(function ThreadRootItem({
  collapsedEnvironmentIds,
  consumeClickSuppression,
  dragBindings,
  node,
  onProjectSelect,
  onToggleEnvironmentCollapsed,
  sectionDnd,
  selectedThreadId,
  sortableRef,
  sortableStyle,
}: ThreadRootItemProps) {
  return (
    <ThreadTreeNodeRow
      projectId={node.thread.projectId}
      node={node}
      depthOffset={0}
      isEnvGrouped={false}
      sectionDnd={sectionDnd}
      selectedThreadId={selectedThreadId}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      onProjectSelect={onProjectSelect}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
      consumeClickSuppression={consumeClickSuppression}
      dragBindings={dragBindings}
      sortableRef={sortableRef}
      sortableStyle={sortableStyle}
    />
  );
});

export const SortableThreadRootItem = memo(function SortableThreadRootItem({
  disabled,
  displace = true,
  node,
  ...props
}: SortableThreadRootItemProps) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: getThreadRootNodeId(node),
    disabled,
    displace,
  });

  const sortableStyle: CSSProperties =
    props.sectionDnd?.activeThread?.id === getThreadRootNodeId(node)
      ? { ...style, opacity: 0.35, pointerEvents: "none" }
      : style;

  return (
    <ThreadRootItem
      {...props}
      node={node}
      dragBindings={dragBindings}
      sortableRef={setNodeRef}
      sortableStyle={sortableStyle}
    />
  );
});
