import { memo, useCallback, useMemo } from "react";
import { DndContext, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { NeighborReorderRequest } from "../model/neighbor-reorder.js";
import { PinnedEnvironmentThreadGroupRow } from "./ProjectRow.js";
import {
  getThreadRootNodeId,
  SortableThreadRootItem,
  ThreadRootItem,
} from "./ThreadRootItems.js";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import { useSidebarListShown } from "./useSidebarListShown.js";
import type {
  ProjectThreadItem,
  ProjectThreadNode,
} from "../model/project-thread-groups.js";
import {
  useNeighborReorderSortable,
  type UseNeighborReorderSortableArgs,
} from "../dnd/useNeighborReorderSortable.js";
import { useChronologicalSectionThreadDnd } from "../dnd/SectionThreadDndContext.js";
import {
  PINNED_THREAD_PARENT_KEY,
  type SectionThreadDndState,
} from "../dnd/useSectionThreadDnd.js";

interface PinnedThreadRootReorderCallbacks {
  onSettled: () => void;
}

export interface PinnedThreadTreeProps {
  rootItems: readonly ProjectThreadItem[];
  rootNodes: readonly ProjectThreadNode[];
  selectedThreadId?: string;
  collapsedEnvironmentIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  isPinnedReorderPending?: boolean;
  onReorderPinnedRoot?: (
    request: NeighborReorderRequest,
    callbacks: PinnedThreadRootReorderCallbacks,
  ) => void;
}

interface PinnedGroupedRootItemsProps {
  rootItems: readonly ProjectThreadItem[];
  selectedThreadId?: string;
  collapsedEnvironmentIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  consumeClickSuppression?: () => boolean;
  sectionDnd?: SectionThreadDndState;
}

const PinnedGroupedRootItems = memo(function PinnedGroupedRootItems({
  rootItems,
  selectedThreadId,
  collapsedEnvironmentIds,
  onProjectSelect,
  onToggleEnvironmentCollapsed,
  consumeClickSuppression,
  sectionDnd,
}: PinnedGroupedRootItemsProps) {
  return rootItems.map((item) => {
    if (item.kind === "environment") {
      return (
        <PinnedEnvironmentThreadGroupRow
          key={`environment:${item.group.environmentId}`}
          group={item.group}
          selectedThreadId={selectedThreadId}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          onProjectSelect={onProjectSelect}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
        />
      );
    }

    if (item.kind === "section" || item.kind === "chatGroup") return null;

    const commonProps = {
      node: item.node,
      selectedThreadId,
      collapsedEnvironmentIds,
      onProjectSelect,
      onToggleEnvironmentCollapsed,
    };

    return sectionDnd ? (
      <SortableThreadRootItem
        key={getThreadRootNodeId(item.node)}
        {...commonProps}
        disabled={sectionDnd.pinnedReorderPending}
        displace={false}
        sectionDnd={sectionDnd}
      />
    ) : (
      <ThreadRootItem
        key={getThreadRootNodeId(item.node)}
        {...commonProps}
        consumeClickSuppression={consumeClickSuppression}
      />
    );
  });
});

export const PinnedThreadTree = memo(function PinnedThreadTree({
  rootItems,
  rootNodes,
  selectedThreadId,
  collapsedEnvironmentIds,
  onProjectSelect,
  onToggleEnvironmentCollapsed,
  isPinnedReorderPending = false,
  onReorderPinnedRoot,
}: PinnedThreadTreeProps) {
  const chronologicalDnd = useChronologicalSectionThreadDnd();

  const handleReorderPinnedRoot = useCallback<
    UseNeighborReorderSortableArgs<ProjectThreadNode>["onReorder"]
  >(
    (request, callbacks) => {
      onReorderPinnedRoot?.(request, callbacks);
    },
    [onReorderPinnedRoot],
  );

  const standaloneReorderDisabled =
    isPinnedReorderPending || !onReorderPinnedRoot || rootNodes.length < 2;

  const {
    handleDragEnd: handleSortableDragEnd,
    itemIds: renderedRootNodeIds,
    renderedItems: renderedRootNodes,
  } = useNeighborReorderSortable({
    disabled: chronologicalDnd !== null || standaloneReorderDisabled,
    getId: getThreadRootNodeId,
    items: rootNodes,
    onReorder: handleReorderPinnedRoot,
  });

  const { dndContextProps, consumeClickSuppression, onClickCapture } =
    useSidebarReorderDnd({
      onDragEnd: handleSortableDragEnd,
      touchSensor: SidebarTouchSensor,
    });

  const chronologicalRootNodes = useMemo(() => {
    if (!chronologicalDnd) return rootNodes;

    const nodesById = new Map(
      rootNodes.map((node) => [getThreadRootNodeId(node), node]),
    );

    const orderedNodes: ProjectThreadNode[] = [];

    for (const id of chronologicalDnd.pinnedItemIds) {
      const node = nodesById.get(id);

      if (!node) return rootNodes;
      orderedNodes.push(node);
    }

    return orderedNodes;
  }, [chronologicalDnd, rootNodes]);

  const hasEnvironmentGroups = rootItems.some(
    (item) => item.kind === "environment",
  );

  const shown = useSidebarListShown();

  const { setNodeRef: setPinnedParentRef } = useDroppable({
    id: PINNED_THREAD_PARENT_KEY,
    disabled: chronologicalDnd === null,
  });

  if (rootItems.length === 0 || !shown) {
    return null;
  }

  if (chronologicalDnd) {
    return (
      <div
        ref={setPinnedParentRef}
        data-sidebar-sticky-section=""
        className="relative space-y-0.5"
        onClickCapture={chronologicalDnd.onClickCapture}
      >
        <SortableContext
          items={[...chronologicalDnd.pinnedItemIds]}
          strategy={verticalListSortingStrategy}
        >
          {hasEnvironmentGroups ? (
            <PinnedGroupedRootItems
              rootItems={rootItems}
              sectionDnd={chronologicalDnd}
              selectedThreadId={selectedThreadId}
              collapsedEnvironmentIds={collapsedEnvironmentIds}
              onProjectSelect={onProjectSelect}
              onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
            />
          ) : (
            chronologicalRootNodes.map((node) => (
              <SortableThreadRootItem
                key={getThreadRootNodeId(node)}
                node={node}
                disabled={chronologicalDnd.pinnedReorderPending}
                displace={false}
                sectionDnd={chronologicalDnd}
                selectedThreadId={selectedThreadId}
                collapsedEnvironmentIds={collapsedEnvironmentIds}
                onProjectSelect={onProjectSelect}
                onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
              />
            ))
          )}
        </SortableContext>
      </div>
    );
  }

  return (
    <div
      data-sidebar-sticky-section=""
      className="relative space-y-0.5"
      onClickCapture={onClickCapture}
    >
      {hasEnvironmentGroups ? (
        <PinnedGroupedRootItems
          rootItems={rootItems}
          selectedThreadId={selectedThreadId}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          onProjectSelect={onProjectSelect}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
          consumeClickSuppression={consumeClickSuppression}
        />
      ) : renderedRootNodes.length > 1 ? (
        <DndContext {...dndContextProps}>
          <SortableContext
            items={renderedRootNodeIds}
            strategy={verticalListSortingStrategy}
          >
            {renderedRootNodes.map((node) => (
              <SortableThreadRootItem
                key={getThreadRootNodeId(node)}
                node={node}
                disabled={standaloneReorderDisabled}
                selectedThreadId={selectedThreadId}
                collapsedEnvironmentIds={collapsedEnvironmentIds}
                onProjectSelect={onProjectSelect}
                onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        renderedRootNodes.map((node) => (
          <ThreadRootItem
            key={getThreadRootNodeId(node)}
            node={node}
            selectedThreadId={selectedThreadId}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            onProjectSelect={onProjectSelect}
            onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
            consumeClickSuppression={consumeClickSuppression}
          />
        ))
      )}
    </div>
  );
});
