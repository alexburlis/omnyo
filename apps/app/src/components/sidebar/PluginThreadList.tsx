import { ProjectSidebarItemsCollectors } from "@/lib/plugin-project-sidebar-items";
import { useCallback, useState } from "react";
import {
  PluginSlotMount,
  resetCrashedPluginSlots,
} from "@/components/plugin/PluginSlotMount";
import { useSidebar } from "@/components/ui/sidebar.js";
import { useRouteState } from "@/hooks/useRouteState";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import type { PluginThreadListSlot } from "@/lib/plugin-slots";
import { appToast } from "@/components/ui/app-toast";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { schedulePluginFrontendReconcile } from "@/lib/plugin-frontend-lazy";
import { ThreadListPlaceholder } from "./ThreadListPlaceholder";
import { useLocationProject, useSidebarScope } from "./sidebarScope";

const THREAD_LIST_SLOT_KIND = "threadList";

interface PluginThreadListProps {
  replacement: ResolvedReplacement<PluginThreadListSlot>;
  onNavigate: () => void;
}

export function PluginThreadList({
  replacement,
  onNavigate,
}: PluginThreadListProps) {
  const { threadId } = useRouteState();
  const locationProject = useLocationProject();
  const { isCompactViewport } = useSidebar();
  const scope = useSidebarScope();
  const bootSettled = usePluginFrontendsSettled();
  const [attempt, setAttempt] = useState(0);

  const registration =
    replacement.kind === "plugin" ? replacement.registration : null;

  const pluginId = registration?.pluginId ?? null;
  const title = registration?.title ?? "Thread list";

  const handleCrash = useCallback(
    (crashedPluginId: string) => {
      appToast.error("Thread list plugin crashed", {
        description: `${title} (${crashedPluginId}) stopped working.`,
      });
    },
    [title],
  );

  const handleReload = useCallback(() => {
    if (pluginId !== null) resetCrashedPluginSlots(pluginId);
    setAttempt((current) => current + 1);
  }, [pluginId]);

  if (registration === null) {
    return (
      <ThreadListPlaceholder
        state={
          bootSettled
            ? { kind: "missing", onReload: schedulePluginFrontendReconcile }
            : { kind: "loading" }
        }
      />
    );
  }

  const List = registration.component;

  return (
    <>
      <ProjectSidebarItemsCollectors />
      <PluginSlotMount
        key={`${registration.pluginId}/${registration.id}/${registration.generation}/${attempt}`}
        pluginId={registration.pluginId}
        slotKind={THREAD_LIST_SLOT_KIND}
        slotId={registration.id}
        crashFallback={
          <ThreadListPlaceholder
            state={{
              kind: "crashed",
              pluginTitle: title,
              onReload: handleReload,
            }}
          />
        }
        onCrash={handleCrash}
        pendingFallback={<ThreadListPlaceholder state={{ kind: "loading" }} />}
      >
        <List
          activeThreadId={threadId ?? null}
          activeProjectId={locationProject?.projectId ?? null}
          isCompactViewport={isCompactViewport}
          experimental_scope={scope}
          onNavigate={onNavigate}
          searchQuery=""
        />
      </PluginSlotMount>
    </>
  );
}
