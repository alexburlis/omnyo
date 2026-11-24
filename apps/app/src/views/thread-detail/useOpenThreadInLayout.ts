import { useCallback } from "react";
import { useStore } from "jotai";
import { useNavigate } from "react-router-dom";
import type { ThreadOpenSplit } from "@omnyo/server-contract";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { findPaneByThread } from "@/lib/split-layout";
import { useActivatedRouteNavigate } from "@/components/ui/app-route-anchor";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { applyThreadOpenToLayout } from "./splitThreadNavigation";

export function useOpenThreadInLayout({
  userInitiated = false,
}: { userInitiated?: boolean } = {}): (
  thread: ThreadRoutePathArgs,
  split: ThreadOpenSplit,
) => void {
  const store = useStore();
  const navigate = useNavigate();
  const activate = useActivatedRouteNavigate();
  const isCompactViewport = useIsCompactViewport();

  return useCallback(
    (thread, split) => {
      const current = store.get(splitLayoutAtom);

      const alreadyOpen =
        current !== null &&
        findPaneByThread(current.root, thread.projectId, thread.threadId) !==
          null;

      const next = applyThreadOpenToLayout(
        current,
        thread,
        isCompactViewport ? "replace" : split,
      );

      if (next !== current) store.set(splitLayoutAtom, next);

      const open = userInitiated ? activate : navigate;
      void open(
        getThreadRoutePath(thread),
        alreadyOpen ? { replace: true } : undefined,
      );
    },
    [activate, isCompactViewport, navigate, store, userInitiated],
  );
}
