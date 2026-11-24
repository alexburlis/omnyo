import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useTransition,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, type NavigateOptions } from "react-router-dom";
import { useStore } from "jotai";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { isRoutePath, resolveRouteHref } from "@/lib/route-paths";
import { getDesktopBrowserApi } from "@/lib/omnyo-desktop";
import { openPaneContentInSplit } from "@/lib/split-layout/openPaneContentInSplit";
import { paneContentForPathname } from "@/views/thread-detail/splitThreadNavigation";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { usePublishPluginDetailOpener } from "@/components/plugin/plugin-detail-opener";
import { useChatOpenHaptic } from "@/lib/visible-chat-haptics";
import { stripRoutePathSuffix } from "@omnyo/client-core/route-paths";

interface RouteNavigationProviderProps {
  children: ReactNode;
}

interface RouteAnchorProps extends Omit<ComponentPropsWithoutRef<"a">, "href"> {
  href: string | undefined;
}

interface RouteAnchorClickActionArgs {
  event: ReactMouseEvent<HTMLAnchorElement>;
}

interface RouteNavigateOptions {
  replace?: boolean;
  state?: NavigateOptions["state"];
}

type RouteNavigate = (path: string, options?: RouteNavigateOptions) => void;

interface RouteNavigation {
  navigate: RouteNavigate;
  activate: RouteNavigate;
  navigateImmediately: RouteNavigate;
  openInSplit: (path: string) => boolean;
}

const RouteNavigationContext = createContext<RouteNavigation | null>(null);

const PluginDetailRouteNavigationContext = createContext<
  ((pluginId: string) => boolean) | null
>(null);

const RouteNavigationPendingContext = createContext(false);

export function useIsRouteNavigationPending(): boolean {
  return useContext(RouteNavigationPendingContext);
}

export function useRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.navigate ?? navigateWithoutProvider
  );
}

export function useActivatedRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.activate ?? navigateWithoutProvider
  );
}

export function useImmediateRouteNavigate(): RouteNavigate {
  return (
    useContext(RouteNavigationContext)?.navigateImmediately ??
    navigateWithoutProvider
  );
}

function navigateWithoutProvider(path: string): void {
  throw new Error(
    `route navigation: no <RouteNavigationProvider> above the caller (navigating to "${path}")`,
  );
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

type RouteAnchorClickAction = "navigate" | "split" | null;

function routeAnchorClickAction({
  event,
}: RouteAnchorClickActionArgs): RouteAnchorClickAction {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }

  const target = event.currentTarget.getAttribute("target");

  if (target !== null && target !== "" && target !== "_self") {
    return null;
  }

  return event.metaKey || event.ctrlKey ? "split" : "navigate";
}

export function RouteNavigationProvider({
  children,
}: RouteNavigationProviderProps) {
  const navigate = useNavigate();
  const playChatOpenHaptic = useChatOpenHaptic();
  const store = useStore();
  const isCompact = useIsCompactViewport();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const [isNavigationPending, startNavigationTransition] = useTransition();

  const navigateImmediately = useCallback<RouteNavigate>((path, options) => {
    if (options === undefined) {
      navigateRef.current(path);

      return;
    }

    navigateRef.current(path, options);
  }, []);

  const navigateRoute = useCallback<RouteNavigate>(
    (path, options) => {
      startNavigationTransition(() => {
        navigateImmediately(path, options);
      });
    },
    [navigateImmediately, startNavigationTransition],
  );

  const activateRoute = useCallback<RouteNavigate>(
    (path, options) => {
      const target = paneContentForPathname(stripRoutePathSuffix(path));

      if (target?.kind === "thread") playChatOpenHaptic(target.threadId);

      navigateRoute(path, options);
    },
    [navigateRoute, playChatOpenHaptic],
  );

  const openInSplit = useCallback<RouteNavigation["openInSplit"]>(
    (path) => {
      const content = paneContentForPathname(stripRoutePathSuffix(path));

      if (content === null) return false;

      if (content.kind === "thread") playChatOpenHaptic(content.threadId);

      openPaneContentInSplit({
        store,
        navigate: navigateRoute,
        content,
        route: path,
        enabled: !isCompact,
      });

      return true;
    },
    [isCompact, navigateRoute, playChatOpenHaptic, store],
  );

  useEffect(() => {
    const browserApi = getDesktopBrowserApi();

    if (browserApi === null) {
      return;
    }

    return browserApi.onOpenTab(({ url }) => {
      if (!isRoutePath({ path: url })) {
        return;
      }

      navigateRoute(url);
    });
  }, [navigateRoute]);

  const value = useMemo<RouteNavigation>(
    () => ({
      navigate: navigateRoute,
      activate: activateRoute,
      navigateImmediately,
      openInSplit,
    }),
    [activateRoute, navigateImmediately, navigateRoute, openInSplit],
  );

  return (
    <RouteNavigationContext.Provider value={value}>
      <RouteNavigationPendingContext.Provider value={isNavigationPending}>
        {children}
      </RouteNavigationPendingContext.Provider>
    </RouteNavigationContext.Provider>
  );
}

export function PluginDetailRouteNavigationProvider({
  children,
  onOpenPluginDetail,
}: {
  children: ReactNode;
  onOpenPluginDetail: (pluginId: string) => boolean;
}) {
  const pane = useOptionalPaneContext();
  usePublishPluginDetailOpener(
    ({ pluginId }) => onOpenPluginDetail(pluginId),
    pane?.isFocused ?? true,
  );

  return (
    <PluginDetailRouteNavigationContext.Provider value={onOpenPluginDetail}>
      {children}
    </PluginDetailRouteNavigationContext.Provider>
  );
}

function anchorInScope(root: HTMLElement, anchor: HTMLAnchorElement): boolean {
  if (root.contains(anchor)) return true;
  const pluginId = root.getAttribute("data-omnyo-plugin");
  const overlay = anchor.closest("[data-omnyo-portaled-overlay]");

  return (
    pluginId !== null && overlay?.getAttribute("data-omnyo-plugin") === pluginId
  );
}

export function useRouteAnchorDelegate(): (
  event: ReactMouseEvent<HTMLElement>,
) => void {
  const navigation = useContext(RouteNavigationContext);
  const openPluginDetail = useContext(PluginDetailRouteNavigationContext);

  return useCallback(
    (event) => {
      if (navigation === null || event.defaultPrevented) return;

      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;

      if (anchor === null || !anchorInScope(event.currentTarget, anchor)) {
        return;
      }

      const target = anchor.getAttribute("target");

      if (target !== null && target !== "" && target !== "_self") return;

      if (event.button !== 0 || event.altKey || event.shiftKey) return;
      const origin = currentOrigin();

      if (origin === null) return;

      const route = resolveRouteHref({
        currentOrigin: origin,
        href: anchor.getAttribute("href") ?? "",
      });

      if (route === null) return;

      const content = paneContentForPathname(stripRoutePathSuffix(route.path));

      if (
        content?.kind === "plugin-detail" &&
        openPluginDetail?.(content.pluginId)
      ) {
        event.preventDefault();

        return;
      }

      const opensBeside =
        event.metaKey || event.ctrlKey || content?.kind === "plugin-detail";

      if (opensBeside) {
        if (navigation.openInSplit(route.path)) event.preventDefault();

        return;
      }

      event.preventDefault();
      navigation.activate(route.path);
    },
    [navigation, openPluginDetail],
  );
}

export function RouteAnchor({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: RouteAnchorProps) {
  const navigation = useContext(RouteNavigationContext);

  const route = useMemo(() => {
    const origin = currentOrigin();

    return origin === null || href === undefined
      ? null
      : resolveRouteHref({ currentOrigin: origin, href });
  }, [href]);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);

      if (route === null || navigation === null) {
        return;
      }

      const action = routeAnchorClickAction({ event });

      if (action === "split") {
        if (navigation.openInSplit(route.path)) event.preventDefault();

        return;
      }

      if (action === "navigate") {
        event.preventDefault();
        navigation.activate(route.path);
      }
    },
    [navigation, onClick, route],
  );

  return (
    <a
      {...anchorProps}
      href={href}
      rel={route === null ? rel : undefined}
      target={route === null ? target : undefined}
      onClick={handleClick}
    />
  );
}
