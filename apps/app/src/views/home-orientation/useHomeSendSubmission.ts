import { useCallback, useRef } from "react";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import { usePendingChatSubmission } from "@/views/usePendingChatSubmission";
import { runHomeSendTransition } from "./home-send-transition";

export function useHomeSendSubmission({
  projectId,
  isActiveSurface,
  paneId,
  navigateInPane,
}: {
  projectId: string;
  isActiveSurface: boolean;
  paneId: string;
  navigateInPane: (thread: ThreadRoutePathArgs) => void;
}) {
  const sendSourceRef = useRef<HTMLDivElement | null>(null);

  const open = useCallback(
    (thread: ThreadRoutePathArgs) =>
      runHomeSendTransition({
        paneId,
        source: sendSourceRef.current,
        threadId: thread.threadId,
        navigate: () => navigateInPane(thread),
      }),
    [navigateInPane, paneId],
  );

  const { handleSubmit } = usePendingChatSubmission({
    projectId,
    isActiveSurface,
    open,
    onUnopenedFailure: null,
  });

  return { handleSubmit, sendSourceRef };
}
