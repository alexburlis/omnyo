import { useEffect, useState } from "react";
import type {
  OmnyoDesktopApi,
  OmnyoDesktopInfo,
} from "@omnyo/desktop-contract";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";

interface DesktopUpdateInfo {
  desktopApi: OmnyoDesktopApi | null;
  desktopInfo: OmnyoDesktopInfo | null;
  isDesktop: boolean;
}

export function useDesktopUpdateInfo(): DesktopUpdateInfo {
  const [desktopApi] = useState<OmnyoDesktopApi | null>(() =>
    getOmnyoDesktopInfo(),
  );

  const [desktopInfo, setDesktopInfo] = useState<OmnyoDesktopInfo | null>(null);

  useEffect(() => {
    const api = getOmnyoDesktopInfo();

    if (api === null) {
      return;
    }

    let mounted = true;
    void api
      .getInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info);
        }
      })
      .catch(() => undefined);

    const unsubscribe = api.onChange((info) => {
      setDesktopInfo(info);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { desktopApi, desktopInfo, isDesktop: desktopApi !== null };
}
