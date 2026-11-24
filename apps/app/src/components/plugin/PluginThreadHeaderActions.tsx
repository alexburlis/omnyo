import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { PluginSlotMount } from "./PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";

export function PluginThreadHeaderActions({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const { threadHeaderActions } = usePluginSlots();
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();

  if (threadHeaderActions.length === 0 || isCompactViewport) return null;

  return (
    <>
      {threadHeaderActions.map((slot) => {
        const Component = slot.component;

        return (
          <PluginSlotMount
            key={`${slot.pluginId}/${slot.id}/${slot.generation}/${threadId}`}
            pluginId={slot.pluginId}
            slotKind="threadHeaderAction"
            slotId={slot.id}
            instanceId={threadId}
            crashFallback={null}
          >
            <span
              role="group"
              aria-label={slot.title}
              className="flex max-h-7 min-w-0 max-w-64 shrink items-center empty:hidden"
            >
              <Component
                threadId={threadId}
                projectId={projectId}
                isCompactViewport={isPointerCoarse}
              />
            </span>
          </PluginSlotMount>
        );
      })}
    </>
  );
}
