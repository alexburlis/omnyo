import { useEffect, useRef } from "react";
import type { OmnyoDesktopApi } from "@omnyo/desktop-contract";
import { appToast, type AppToastOptions } from "@/components/ui/app-toast";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { withLocalStorage } from "@/lib/browser-storage";

const PROMPT_TOAST_ID = "desktop-update-ready";

const LATER_VERSION_STORAGE_KEY = "omnyo.desktopUpdateLaterVersion";

export const DESKTOP_UPDATE_READY_TITLE = "Update ready";

export const DESKTOP_RELAUNCH_FAILED_TITLE = "Relaunch failed";

function readLaterVersion(): string | null {
  return withLocalStorage(
    (storage) => storage.getItem(LATER_VERSION_STORAGE_KEY),
    null,
  );
}

function rememberLater(version: string): void {
  withLocalStorage(
    (storage) => storage.setItem(LATER_VERSION_STORAGE_KEY, version),
    undefined,
  );
}

export function relaunchIntoDesktopUpdate(api: OmnyoDesktopApi): void {
  void api.installUpdate().catch((error: unknown) => {
    appToast.error(DESKTOP_RELAUNCH_FAILED_TITLE, {
      description:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The update did not install.",
    });
  });
}

export function desktopUpdatePromptOptions(
  version: string,
  actions: { onLater: () => void; onRelaunch: () => void },
): AppToastOptions {
  return {
    action: { label: "Relaunch", onClick: actions.onRelaunch },
    cancel: { label: "Later", onClick: actions.onLater },
    description: `Omnyo ${version} is downloaded. Relaunch to finish installing it, or choose Later and relaunch from Settings → Updates when you’re ready.`,
  };
}

export function DesktopUpdatePromptHost() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const promptedVersion = useRef<string | null>(null);

  const readyVersion =
    desktopInfo?.updateDownloaded === true
      ? (desktopInfo.pendingVersion ?? desktopInfo.latestVersion)
      : null;

  useEffect(() => {
    if (desktopApi === null) return;

    if (readyVersion === null) {
      if (promptedVersion.current === null) return;
      promptedVersion.current = null;
      appToast.dismiss(PROMPT_TOAST_ID);

      return;
    }

    if (
      promptedVersion.current === readyVersion ||
      readLaterVersion() === readyVersion
    )
      return;
    promptedVersion.current = readyVersion;
    appToast.message(DESKTOP_UPDATE_READY_TITLE, {
      ...desktopUpdatePromptOptions(readyVersion, {
        onLater: () => rememberLater(readyVersion),
        onRelaunch: () => relaunchIntoDesktopUpdate(desktopApi),
      }),
      duration: Infinity,
      id: PROMPT_TOAST_ID,
    });
  }, [desktopApi, readyVersion]);

  return null;
}
