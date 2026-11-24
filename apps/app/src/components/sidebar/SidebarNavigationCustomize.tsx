import { useMemo } from "react";
import type { SidebarVisibilityItem } from "@omnyo/shared-ui/sidebar-visibility-customize";
import { SidebarCustomizePanel } from "@omnyo/shared-ui/sidebar-customize-panel";
import { Switch } from "@omnyo/shared-ui/switch";
import { COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityControls";
import { isCustomizableSidebarNavigationItem } from "./sidebarNavigationItems";
import {
  SidebarNavigationIcon,
  useSidebarNavigationModel,
} from "./SidebarNavigationModel";

export function SidebarNavigationCustomize({
  onClose,
  reorderInList,
}: {
  onClose: (restoreFocus: boolean) => void;
  reorderInList: boolean;
}) {
  const model = useSidebarNavigationModel();
  const { arrangement, state } = model;

  const items = useMemo<SidebarVisibilityItem[]>(
    () =>
      model.state.items
        .filter(isCustomizableSidebarNavigationItem)
        .map((item) => ({
          id: item.id,
          title: item.label,
          icon: <SidebarNavigationIcon icon={item.icon} />,
          ...(item.isDisabled ? { disabled: true } : {}),
        })),
    [model.state.items],
  );

  if (!reorderInList) {
    return (
      <RailVisibilityToggles
        items={items}
        visibleIds={arrangement.visibleKeys}
        onDone={() => onClose(true)}
        onVisibleChange={arrangement.setVisible}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="plugin-nav-sidebar-items"
      data-sidebar-navigation-customize-mode="true"
    >
      <SidebarVisibilityCustomize
        title="Customize rail"
        listLabel="Sidebar navigation"
        variant="compact"
        items={items}
        visibleIds={arrangement.visibleKeys}
        onActivate={(item, event) =>
          state.actions.activate(item.id, {
            openInSplit: event.metaKey || event.ctrlKey,
          })
        }
        onDone={() => onClose(true)}
        onExit={() => onClose(false)}
        onReorder={arrangement.moveAny}
        onVisibleChange={arrangement.setVisible}
      />
    </div>
  );
}

function RailVisibilityToggles({
  items,
  onDone,
  onVisibleChange,
  visibleIds,
}: {
  items: readonly SidebarVisibilityItem[];
  onDone: () => void;
  onVisibleChange: (id: string, visible: boolean) => void;
  visibleIds: readonly string[];
}) {
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const railOrder = useMemo(() => [...items].reverse(), [items]);

  return (
    <SidebarCustomizePanel
      onDone={onDone}
      testIdPrefix="sidebar-navigation"
      title="Customize rail"
      variant="compact"
    >
      <p className="px-2 pb-1.5 text-xs text-muted-foreground">
        Drag icons in the rail to reorder.
      </p>
      <div
        role="list"
        aria-label="Rail destinations"
        className="space-y-0.5"
        data-testid="plugin-nav-sidebar-items"
      >
        {railOrder.map((item) => {
          const checked = visibleIdSet.has(item.id);

          return (
            <label
              key={item.id}
              role="listitem"
              className={cn(
                "flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-xs text-sidebar-foreground",
                COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
                "hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
              )}
              data-sidebar-customize-item={item.id}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center transition-opacity duration-(--motion-duration-base)",
                  !checked && "opacity-50",
                )}
              >
                {item.icon}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate transition-colors duration-(--motion-duration-base)",
                  !checked && "text-muted-foreground",
                )}
              >
                {item.title}
              </span>
              <Switch
                checked={checked}
                aria-label={`Show ${item.title} in rail`}
                onCheckedChange={(next) => onVisibleChange(item.id, next)}
              />
            </label>
          );
        })}
      </div>
    </SidebarCustomizePanel>
  );
}
