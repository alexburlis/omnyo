import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { experimental_useAppNavigate } from "@omnyo/plugin-sdk/app";

const OpenThreadInSplitContext = createContext<
  ((threadId: string) => void) | null
>(null);

const PrefetchThreadOpenContext = createContext<
  ((threadId: string) => void) | null
>(null);

export function ThreadRowNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const navigate = experimental_useAppNavigate();
  const latest = useRef(navigate);
  useLayoutEffect(() => {
    latest.current = navigate;
  });

  const openInSplit = useCallback((threadId: string) => {
    latest.current.toThread(threadId, { split: true });
  }, []);

  const prefetchThreadOpen = useCallback((threadId: string) => {
    latest.current.experimental_prefetchThreadOpen(threadId);
  }, []);

  return (
    <OpenThreadInSplitContext.Provider value={openInSplit}>
      <PrefetchThreadOpenContext.Provider value={prefetchThreadOpen}>
        {children}
      </PrefetchThreadOpenContext.Provider>
    </OpenThreadInSplitContext.Provider>
  );
}

export function useOpenThreadInSplit(): (threadId: string) => void {
  const openInSplit = useContext(OpenThreadInSplitContext);

  if (openInSplit === null) {
    throw new Error(
      "useOpenThreadInSplit must be used within a <ThreadRowNavigationProvider>",
    );
  }

  return openInSplit;
}

export function usePrefetchThreadOpen(): (threadId: string) => void {
  const prefetchThreadOpen = useContext(PrefetchThreadOpenContext);

  if (prefetchThreadOpen === null) {
    throw new Error(
      "usePrefetchThreadOpen must be used within a <ThreadRowNavigationProvider>",
    );
  }

  return prefetchThreadOpen;
}
