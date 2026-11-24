import { useEffect } from "react";
import type { ThreadOpenSplit } from "@omnyo/server-contract";
import { useLatestRef } from "@/hooks/useLatestRef";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

export function useDesktopOpenThread(args: {
  threads: readonly { id: string; projectId: string }[];
  openThread: (thread: ThreadRoutePathArgs, split: ThreadOpenSplit) => void;
  navigate: (path: string) => unknown;
}): void {
  const threadsRef = useLatestRef(args.threads);
  const { navigate, openThread } = args;

  useEffect(() => {
    const desktop = getOmnyoDesktopInfo();

    if (!desktop?.onOpenThread) return;

    return desktop.onOpenThread((threadId) => {
      const listed = threadsRef.current.find(
        (thread) => thread.id === threadId,
      );

      if (listed !== undefined) {
        openThread({ projectId: listed.projectId, threadId }, "replace");

        return;
      }

      void sdk.threads.get({ threadId }).then(
        (thread) =>
          openThread({ projectId: thread.projectId, threadId }, "replace"),
        () => navigate(`/threads/${encodeURIComponent(threadId)}`),
      );
    });
  }, [navigate, openThread, threadsRef]);
}
