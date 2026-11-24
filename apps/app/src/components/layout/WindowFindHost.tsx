import { useCallback } from "react";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import {
  getOmnyoDesktopInfo,
  readWindowFindTopOffset,
} from "@/lib/omnyo-desktop";

export function WindowFindHost() {
  const openWindowFind = useCallback((): boolean => {
    const desktop = getOmnyoDesktopInfo();

    if (desktop?.openWindowFind === undefined) {
      return false;
    }

    desktop.openWindowFind({ topOffset: readWindowFindTopOffset() });

    return true;
  }, []);

  useAppCommandHandler("window.find", openWindowFind);

  return null;
}
