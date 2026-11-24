import {
  definePluginApp,
  type PluginThreadListProps,
} from "@omnyo/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  PreferencesSync,
  PreferencesSyncController,
} from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
import { moveThreadAction } from "./app/rows/moveThreadAction.js";

function ThreadList({
  activeThreadId,
  isCompactViewport,
  experimental_scope,
  onNavigate,
}: PluginThreadListProps) {
  useSidebarThreadReveal();

  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ProjectList
          activeThreadId={activeThreadId}
          scopeProjectId={
            experimental_scope?.kind === "project"
              ? experimental_scope.projectId
              : null
          }
          onProjectSelect={onNavigate}
        />
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "preferences-sync-v1",
    component: PreferencesSyncController,
  });
  app.slots.experimental_threadList({
    id: "thread-list",
    title: "Thread list",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: ThreadList,
  });
  app.slots.experimental_threadAction(moveThreadAction);
});
