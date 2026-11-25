import type { ReactNode } from "react";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { InitialLoadSurface } from "@/components/thread/ThreadInitialLoad";

export function PluginPanelLoading() {
  return (
    <div
      role="status"
      aria-label="Loading plugin panel"
      aria-busy="true"
      className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-hidden p-4 md:p-5"
    >
      <Skeleton className="h-5 w-36 max-w-full shrink-0" />
      <Skeleton className="h-9 max-w-2xl shrink-0" />
      <Skeleton className="h-20 shrink-0" />
    </div>
  );
}

export function PluginPageLoad({ children }: { children: ReactNode }) {
  return (
    <InitialLoadSurface fallback={<PluginPanelLoading />}>
      {children}
    </InitialLoadSurface>
  );
}
