import { useMemo, type CSSProperties, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  getSortableTransition,
  MOTION_DURATION_MS,
  MOTION_EASE,
  usePrefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import { SettingsRowList } from "@/components/ui/settings-section";

const SORTABLE_ROW_LIFT_TRANSITION = ["box-shadow", "opacity"]
  .map(
    (property) =>
      `${property} ${MOTION_DURATION_MS.fast}ms ${MOTION_EASE.standard}`,
  )
  .join(", ");

const SORTABLE_ROW_LIFT_CLASS =
  "relative z-10 rounded-md bg-card opacity-90 shadow-lift";

const restrictDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const sortableSettingsRowModifiers: Modifier[] = [restrictDragToVerticalAxis];

interface SortableSettingsRowsProps {
  ids: string[];
  disabled: boolean;
  onReorder: (activeId: string, overId: string) => void;
  children: ReactNode;
}

export function SortableSettingsRowList(props: SortableSettingsRowsProps) {
  return (
    <SortableSettingsRows {...props}>
      <SettingsRowList>{props.children}</SettingsRowList>
    </SortableSettingsRows>
  );
}

export function SortableSettingsRows({
  ids,
  disabled,
  onReorder,
  children,
}: SortableSettingsRowsProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    if (
      disabled ||
      typeof event.active.id !== "string" ||
      typeof event.over?.id !== "string"
    ) {
      return;
    }

    onReorder(event.active.id, event.over.id);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={sortableSettingsRowModifiers}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function useSortableSettingsRow({
  id,
  disabled,
  label,
}: {
  id: string;
  disabled: boolean;
  label: string;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id,
    disabled,
    transition: getSortableTransition(usePrefersReducedMotion()),
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition:
        transition === undefined
          ? SORTABLE_ROW_LIFT_TRANSITION
          : `${transition}, ${SORTABLE_ROW_LIFT_TRANSITION}`,
    }),
    [transform, transition],
  );

  const handle = (
    <Button
      ref={setActivatorNodeRef}
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "-ml-2 h-8 w-7 shrink-0 touch-none text-muted-foreground",
        !disabled && "cursor-grab active:cursor-grabbing",
      )}
      disabled={disabled}
      aria-label={`Reorder ${label}`}
      {...attributes}
      {...listeners}
    >
      <Icon name="DragDropVertical" aria-hidden="true" />
    </Button>
  );

  const liftClassName = isDragging ? SORTABLE_ROW_LIFT_CLASS : undefined;

  return { setNodeRef, style, isDragging, handle, liftClassName };
}
