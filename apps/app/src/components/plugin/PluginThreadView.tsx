import { useCallback, type ReactNode } from "react";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { appToast } from "@/components/ui/app-toast";
import { resolveReplacement } from "@/lib/plugin-slot-resolvers";
import { usePluginSlots } from "@/lib/plugin-slots";
import { PluginContext } from "./plugin-context";
import { PluginSlotMount } from "./PluginSlotMount";

const THREAD_VIEW_SLOT_KIND = "threadView";

interface PluginThreadViewProps {
  threadId: string;
  projectId: string;
  defaultView: ReactNode;
  transcript: ReactNode;
  composer: ReactNode;
}

function CoreOwned({ children }: { children: ReactNode }) {
  return (
    <PluginContext.Provider value={null}>{children}</PluginContext.Provider>
  );
}

export function PluginThreadView({
  threadId,
  projectId,
  defaultView,
  transcript,
  composer,
}: PluginThreadViewProps) {
  const { threadViews } = usePluginSlots();
  const isCompactViewport = useIsCompactViewport();
  const replacement = resolveReplacement(threadViews);

  const title =
    replacement.kind === "plugin"
      ? replacement.registration.title
      : "Thread view";

  const handleCrash = useCallback(
    (crashedPluginId: string) => {
      appToast.error("Thread view plugin crashed", {
        description: `${title} (${crashedPluginId}) stopped working.`,
      });
    },
    [title],
  );

  if (replacement.kind === "owner") return defaultView;

  const registration = replacement.registration;
  const View = registration.component;

  return (
    <PluginSlotMount
      key={`${registration.pluginId}/${registration.id}/${registration.generation}`}
      pluginId={registration.pluginId}
      slotKind={THREAD_VIEW_SLOT_KIND}
      slotId={registration.id}
      instanceId={threadId}
      crashResetKey={threadId}
      crashFallback={<CoreOwned>{defaultView}</CoreOwned>}
      onCrash={handleCrash}
    >
      <div
        data-thread-window=""
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip"
      >
        <View
          threadId={threadId}
          projectId={projectId}
          isCompactViewport={isCompactViewport}
          defaultView={<CoreOwned>{defaultView}</CoreOwned>}
          transcript={<CoreOwned>{transcript}</CoreOwned>}
          composer={<CoreOwned>{composer}</CoreOwned>}
        />
      </div>
    </PluginSlotMount>
  );
}
