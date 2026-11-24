import type { Href, useRouter } from "expo-router";

interface NavigationStateReader {
  getState(): { routes: readonly { name: string }[] } | undefined;
}

export function dismissToShell(
  router: ReturnType<typeof useRouter>,
  navigation: NavigationStateReader,
  href: Href,
): void {
  const routes = navigation.getState()?.routes ?? [];

  if (routes.length <= 1 || routes.some((route) => route.name === "webview")) {
    router.dismissTo(href);

    return;
  }

  router.dismissAll();
  router.replace(href);
}
