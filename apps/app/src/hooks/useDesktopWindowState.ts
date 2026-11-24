import { useEffect, useState } from "react";
import type { OmnyoDesktopWindowState } from "@omnyo/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getOmnyoDesktopInfo,
} from "@/lib/omnyo-desktop";

export function useDesktopWindowState(): OmnyoDesktopWindowState {
  const [windowState, setWindowState] = useState<OmnyoDesktopWindowState>(
    DEFAULT_DESKTOP_WINDOW_STATE,
  );

  useEffect(() => {
    const desktopApi = getOmnyoDesktopInfo();
    let cancelled = false;

    const unsubscribe = desktopApi?.onWindowStateChange?.((nextState) => {
      setWindowState(nextState);
    });

    void desktopApi?.getWindowState?.().then((nextState) => {
      if (!cancelled) {
        setWindowState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return windowState;
}
