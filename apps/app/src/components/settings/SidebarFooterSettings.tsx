import { DndContext } from "@dnd-kit/core";
import { useEffect, useRef } from "react";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Icon } from "@omnyo/shared-ui/icon";
import { Button } from "@omnyo/shared-ui/button";
import { Switch } from "@omnyo/shared-ui/switch";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { useReorderDnd } from "@omnyo/shared-ui/use-reorder-dnd";
import { useSidebarSortable } from "@omnyo/shared-ui/sortable-motion";
import {
  useSidebarFooterPreferences,
  type FooterItem,
  type SidebarFooterPlacement,
} from "@/components/sidebar/sidebarFooterPreferences";
import { FooterItemIcon } from "@/components/plugin/PluginSidebarFooterItems";

export function SidebarFooterSettings() {
  return (
    <SettingsWithControl
      label="Footer actions"
      description="Drag to reorder."
      controlPlacement="below"
    >
      <FooterItemControls placement="footer" />
    </SettingsWithControl>
  );
}

export function FooterItemControls({
  placement,
  onReorderingChange,
}: {
  placement: SidebarFooterPlacement;
  onReorderingChange?: (reordering: boolean) => void;
}) {
  const preferences = useSidebarFooterPreferences(placement);
  const dragging = useRef(false);

  useEffect(() => () => onReorderingChange?.(false), [onReorderingChange]);

  const { dndContextProps, onClickCapture } = useReorderDnd({
    onDragStart() {
      dragging.current = true;
      onReorderingChange?.(true);
    },
    onDragCancel() {
      dragging.current = false;
      onReorderingChange?.(false);
    },
    onDragEnd(event) {
      dragging.current = false;
      onReorderingChange?.(false);

      if (
        typeof event.active.id === "string" &&
        typeof event.over?.id === "string"
      )
        preferences.move(event.active.id, event.over.id);
    },
  });

  return (
    <div
      className="rounded-md border border-border"
      role="group"
      aria-label="Footer actions"
      onClickCapture={onClickCapture}
      onKeyDown={(event) => {
        if (event.key === "Escape" && dragging.current) event.preventDefault();
      }}
    >
      <DndContext {...dndContextProps}>
        <SortableContext
          items={preferences.items.map((item) => item.key)}
          strategy={verticalListSortingStrategy}
        >
          {preferences.items.map((item) => (
            <FooterSettingsRow
              key={item.key}
              item={item}
              visible={preferences.footer.includes(item)}
              disabled={
                preferences.isFull && !preferences.footer.includes(item)
              }
              onVisibleChange={(visible) =>
                visible
                  ? preferences.addToFooter(item.key)
                  : preferences.removeFromFooter(item.key)
              }
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function FooterSettingsRow({
  item,
  visible,
  disabled,
  onVisibleChange,
}: {
  item: FooterItem;
  visible: boolean;
  disabled: boolean;
  onVisibleChange(visible: boolean): void;
}) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: item.key,
    disabled: false,
  });

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 border-b border-border px-2 py-2 last:border-b-0"
      data-footer-setting={item.key}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-7 touch-none text-muted-foreground"
        ref={dragBindings.setActivatorNodeRef}
        {...dragBindings.attributes}
        {...dragBindings.listeners}
        aria-label={`Reorder ${item.label}`}
      >
        <Icon name="DragDropVertical" className="size-4" />
      </Button>
      <FooterItemIcon item={item} />
      <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
      <Switch
        checked={visible}
        disabled={disabled}
        onCheckedChange={onVisibleChange}
        aria-label={`Show ${item.label} in footer`}
      />
    </div>
  );
}
