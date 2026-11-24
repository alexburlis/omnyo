import { memo } from "react";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import {
  useNeighborReorderSortable,
  type UseNeighborReorderSortableArgs,
} from "../dnd/useNeighborReorderSortable.js";
import type { ProjectThreadNode } from "../model/project-thread-groups.js";
import {
  getThreadRootNodeId,
  SortableThreadRootItem,
  ThreadRootItem,
} from "./ThreadRootItems.js";

export interface ShelfThreadTreeProps {
  rootNodes: readonly ProjectThreadNode[];
  selectedThreadId?: string;
  collapsedEnvironmentIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  isReorderPending: boolean;
  onReorder: UseNeighborReorderSortableArgs<ProjectThreadNode>["onReorder"];
}

export const ShelfThreadTree = memo(function ShelfThreadTree({
  rootNodes,
  selectedThreadId,
  collapsedEnvironmentIds,
  onProjectSelect,
  onToggleEnvironmentCollapsed,
  isReorderPending,
  onReorder,
}: ShelfThreadTreeProps) {
  const disabled = isReorderPending || rootNodes.length < 2;

  const { handleDragEnd, itemIds, renderedItems } = useNeighborReorderSortable({
    disabled,
    getId: getThreadRootNodeId,
    items: rootNodes,
    onReorder,
  });

  const { dndContextProps, consumeClickSuppression, onClickCapture } =
    useSidebarReorderDnd({
      onDragEnd: handleDragEnd,
      touchSensor: SidebarTouchSensor,
    });

  return (
    <div
      data-sidebar-sticky-section=""
      className="relative space-y-0.5"
      onClickCapture={onClickCapture}
    >
      {renderedItems.length > 1 ? (
        <DndContext {...dndContextProps}>
          <SortableContext
            items={itemIds}
            strategy={verticalListSortingStrategy}
          >
            {renderedItems.map((node) => (
              <SortableThreadRootItem
                key={getThreadRootNodeId(node)}
                node={node}
                disabled={disabled}
                selectedThreadId={selectedThreadId}
                collapsedEnvironmentIds={collapsedEnvironmentIds}
                onProjectSelect={onProjectSelect}
                onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
              />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        renderedItems.map((node) => (
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
