import { usePathname, useRouter } from "expo-router";
import { useEffect } from "react";
import { webViewShellHref } from "@/screens/shell/hrefs";
import { useProfiles } from "./ProfilesProvider";

export function ThreadOpenSignalHandler() {
  const { connection } = useProfiles();
  const router = useRouter();
  const pathname = usePathname();
  const realtime = connection?.client?.realtime ?? null;
  const profileId = connection?.profile.id;
  useEffect(() => {
    if (!realtime || profileId === undefined || pathname === "/webview") return;

    return realtime.onThreadOpen((signal) => {
      if (pathnameIsThread(pathname, signal.threadId)) return;
      router.push(
        webViewShellHref({ profileId, path: `/threads/${signal.threadId}` }),
      );
    });
  }, [realtime, router, pathname, profileId]);

  return null;
}

function pathnameIsThread(pathname: string, threadId: string): boolean {
  return (
    pathname === `/threads/${threadId}` ||
    pathname.endsWith(`/threads/${threadId}`)
  );
}
