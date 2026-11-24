import { useEffect } from "react";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";
import { useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  useEffect(() => {
    const desktopApi = getOmnyoDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);
}
