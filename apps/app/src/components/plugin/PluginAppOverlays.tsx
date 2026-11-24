import { memo, useState } from "react";
import { useAllPluginCssSettled } from "@/lib/plugin-css";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import {
  usePluginSlots,
  type ExperimentalAppOverlaySlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

function useAppLayoutReady(): boolean {
  const frontendsSettled = usePluginFrontendsSettled();
  const cssSettled = useAllPluginCssSettled();
  const ready = frontendsSettled && cssSettled;
  const [wasReady, setWasReady] = useState(ready);

  if (ready && !wasReady) setWasReady(true);

  return ready || wasReady;
}

const PluginAppOverlay = memo(function PluginAppOverlay({
  slot,
}: {
  slot: ExperimentalAppOverlaySlot;
}) {
  const Component = slot.component;

  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="appOverlay"
      slotId={slot.id}
      appOverlayBundleHash={slot.bundleHash}
      crashFallback={null}
    >
      <Component />
    </PluginSlotMount>
  );
});

export function PluginAppOverlays() {
  const { appOverlays } = usePluginSlots();
  const layoutReady = useAppLayoutReady();

  if (!layoutReady || appOverlays.length === 0) return null;

  return (
    <div data-omnyo-plugin-app-overlays="" className="contents">
      {appOverlays.map((slot) => (
        <PluginAppOverlay
          key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
          slot={slot}
        />
      ))}
    </div>
  );
}
