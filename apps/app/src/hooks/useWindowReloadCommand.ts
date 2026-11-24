import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";

export function useWindowReloadCommand(): void {
  const desktopApi = getOmnyoDesktopInfo();
  const reloadWindow = desktopApi?.reloadWindow;

  useAppCommandHandler(
    "window.reload",
    () => {
      if (reloadWindow === undefined) {
        return false;
      }

      reloadWindow.call(desktopApi);

      return true;
    },
    0,
    reloadWindow !== undefined,
  );
}
