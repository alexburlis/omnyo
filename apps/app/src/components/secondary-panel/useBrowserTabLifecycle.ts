import { useEffect, useMemo, useRef } from "react";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { getDesktopBrowserApi } from "@/lib/omnyo-desktop";
import { destroyPersistedBrowserView } from "./browserViewVisibilityCoordinator";

interface UseBrowserTabLifecycleArgs {
  browserTabs: readonly BrowserFixedPanelTab[];
  scopeId: string | null;
}

interface BrowserTabIdSnapshot {
  scopeId: string | null;
  tabIds: ReadonlySet<string>;
}

export function useBrowserTabLifecycle({
  browserTabs,
  scopeId,
}: UseBrowserTabLifecycleArgs): void {
  const desktopBrowser = useMemo(() => getDesktopBrowserApi(), []);
  const previousTabIdsRef = useRef<BrowserTabIdSnapshot | null>(null);

  useEffect(() => {
    const tabIds: ReadonlySet<string> = new Set(
      browserTabs.map((tab) => tab.id),
    );

    const previous = previousTabIdsRef.current;

    if (
      desktopBrowser !== null &&
      previous !== null &&
      previous.scopeId === scopeId
    ) {
      for (const tabId of previous.tabIds) {
        if (!tabIds.has(tabId)) {
          destroyPersistedBrowserView({ desktopBrowser, tabId });
        }
      }
    }

    previousTabIdsRef.current = { scopeId, tabIds };
  }, [browserTabs, desktopBrowser, scopeId]);
}
