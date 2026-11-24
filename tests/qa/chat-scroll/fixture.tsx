import "@omnyo/shared-ui/icon-extended";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Provider } from "jotai";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { ThreadTimelineSurface } from "@/components/thread/timeline/ThreadTimelineSurface";
import { useThreadTimelineController } from "@/components/thread/timeline/useThreadTimelineController";
import { createAppQueryClient } from "@/lib/query-client";
import { ThreadDetailWorkerPoolProvider } from "@/views/thread-detail/ThreadDetailWorkerPoolProvider";
import "@/app.css";

const threadId = "thread-0";

const queryClient = createAppQueryClient({ showMutationErrorToasts: false });

function Timeline() {
  const timeline = useThreadTimelineController({ threadId });

  return (
    <BottomAnchoredScrollBody footer={null} maxWidthClassName="max-w-3xl">
      <ThreadTimelineSurface
        timelineHistory={timeline.timelineHistory}
        activeThinking={null}
        contextBoundarySeq={timeline.contextBoundarySeq}
        hasOlderTimelineRows={timeline.hasOlderTimelineRows}
        isLoadingOlderTimelineRows={timeline.isLoadingOlderTimelineRows}
        onLoadOlderRows={timeline.loadOlderTimelineRows}
        isThreadTimelinePending={timeline.timelineLoading}
        timelineError={timeline.timelineError !== null}
        showOngoingIndicator={false}
        timelineRows={timeline.timelineRows}
        threadId={threadId}
        readOnly
        includePluginMessageActions={false}
        workspaceRootPath={undefined}
      />
    </BottomAnchoredScrollBody>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <Provider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <TooltipProvider>
            <ThreadDetailWorkerPoolProvider>
              {children}
            </ThreadDetailWorkerPoolProvider>
          </TooltipProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </Provider>
  );
}

const root = document.getElementById("app");

if (!root) throw new Error("Fixture root missing");

createRoot(root).render(
  <Providers>
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Timeline />
    </div>
  </Providers>,
);
