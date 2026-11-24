import { memo } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { MACOS_APP_REGION_NO_DRAG_CLASS } from "@/lib/omnyo-desktop";
import {
  usePluginSlots,
  type ExperimentalTitleBarCenterSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

const PluginTitleBarCenterItem = memo(function PluginTitleBarCenterItem({
  slot,
}: {
  slot: ExperimentalTitleBarCenterSlot;
}) {
  const Component = slot.component;

  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="titleBarCenter"
      slotId={slot.id}
      crashFallback={null}
    >
      <Component />
    </PluginSlotMount>
  );
});

export function PluginTitleBarCenter({ className }: { className?: string }) {
  const { titleBarCenters } = usePluginSlots();

  if (titleBarCenters.length === 0) return null;

  return (
    <div
      data-omnyo-plugin-title-bar-center=""
      className={cn(
        "flex min-w-0 items-center gap-2",
        MACOS_APP_REGION_NO_DRAG_CLASS,
        className,
      )}
    >
      {titleBarCenters.map((slot) => (
        <PluginTitleBarCenterItem
          key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
          slot={slot}
        />
      ))}
    </div>
  );
}
