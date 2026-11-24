import { useEffect, useRef } from "react";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  matchPath,
  NavigationType,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { z } from "zod";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useRouteState } from "@/hooks/useRouteState";
import { createJsonLocalStorage } from "@/lib/browser-storage";
import { PLUGIN_PANEL_ROUTE_PATH } from "@/lib/route-paths";

const SIDEBAR_SCOPE_STORAGE_KEY = "omnyo.sidebar.scope";

const sidebarScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox") }).strict(),
  z
    .object({ kind: z.literal("project"), projectId: z.string().min(1) })
    .strict(),
]);

export type SidebarScope = z.infer<typeof sidebarScopeSchema>;

export const INBOX_SIDEBAR_SCOPE: SidebarScope = { kind: "inbox" };

function isSidebarScope(value: unknown): value is SidebarScope {
  return sidebarScopeSchema.safeParse(value).success;
}

function isSameSidebarScope(left: SidebarScope, right: SidebarScope): boolean {
  if (left.kind === "inbox" || right.kind === "inbox") {
    return left.kind === right.kind;
  }

  return left.projectId === right.projectId;
}

const storedSidebarScopeAtom = atomWithStorage<SidebarScope>(
  SIDEBAR_SCOPE_STORAGE_KEY,
  INBOX_SIDEBAR_SCOPE,
  createJsonLocalStorage(isSidebarScope),
  { getOnInit: true },
);

export const sidebarScopeAtom = atom(
  (get) => get(storedSidebarScopeAtom),
  (get, set, next: SidebarScope) => {
    if (isSameSidebarScope(get(storedSidebarScopeAtom), next)) return;
    set(storedSidebarScopeAtom, next);
  },
);

function catalogHasProject(
  catalog: SidebarBootstrapResponse,
  projectId: string,
): boolean {
  return (
    catalog.personalProject.id === projectId ||
    catalog.projects.some((project) => project.id === projectId)
  );
}

function catalogThreadProjectId(
  catalog: SidebarBootstrapResponse,
  threadId: string,
): string | undefined {
  for (const project of [...catalog.projects, catalog.personalProject]) {
    const thread = project.threads.find(
      (candidate) => candidate.id === threadId,
    );

    if (thread !== undefined) return thread.projectId;
  }

  return undefined;
}

function useLoadedSidebarCatalog(): SidebarBootstrapResponse | undefined {
  const { data, isPlaceholderData } = useSidebarNavigation();

  return isPlaceholderData ? undefined : data;
}

function resolveSidebarScope(
  stored: SidebarScope,
  catalog: SidebarBootstrapResponse | undefined,
): SidebarScope {
  if (stored.kind === "inbox" || catalog === undefined) return stored;

  return catalogHasProject(catalog, stored.projectId)
    ? stored
    : INBOX_SIDEBAR_SCOPE;
}

export function useSidebarScope(): SidebarScope {
  const stored = useAtomValue(sidebarScopeAtom);
  const catalog = useLoadedSidebarCatalog();

  return resolveSidebarScope(stored, catalog);
}

export function useSetSidebarScope(): (scope: SidebarScope) => void {
  return useSetAtom(sidebarScopeAtom);
}

export interface LocationProject {
  key: string;
  projectId: string;
}

const PROJECT_ROUTE_PATH = "/projects/:projectId/*";

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function pluginPageProject(
  pathname: string,
  catalog: SidebarBootstrapResponse,
): LocationProject | null {
  const match = matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname);

  if (match === null) return null;

  const [firstSegment = ""] = pathname
    .slice(match.pathnameBase.length)
    .split("/")
    .filter((segment) => segment.length > 0);

  const projectId = decodePathSegment(firstSegment);

  if (projectId === null || !catalogHasProject(catalog, projectId)) {
    return null;
  }

  const { pluginId, panelPath } = match.params;

  return { key: `panel:${pluginId}/${panelPath}/${projectId}`, projectId };
}

export function resolveLocationProject({
  pathname,
  route,
  catalog,
}: {
  pathname: string;
  route: { threadId: string | undefined; projectId: string | undefined };
  catalog: SidebarBootstrapResponse | undefined;
}): LocationProject | null {
  if (catalog === undefined) return null;

  if (route.threadId !== undefined) {
    const projectId =
      catalogThreadProjectId(catalog, route.threadId) ?? route.projectId;

    return projectId !== undefined && catalogHasProject(catalog, projectId)
      ? { key: `thread:${route.threadId}`, projectId }
      : null;
  }

  if (matchPath(PROJECT_ROUTE_PATH, pathname) !== null) {
    const { projectId } = route;

    return projectId !== undefined && catalogHasProject(catalog, projectId)
      ? { key: `project:${projectId}`, projectId }
      : null;
  }

  return pluginPageProject(pathname, catalog);
}

export function useLocationProject(): LocationProject | null {
  const { pathname } = useLocation();
  const { threadId, projectId } = useRouteState();
  const catalog = useLoadedSidebarCatalog();

  return resolveLocationProject({
    pathname,
    route: { threadId, projectId },
    catalog,
  });
}

export const SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE = {
  keepsSidebarScope: true,
} as const;

const sidebarScopeKeepingNavigationStateSchema = z.object({
  keepsSidebarScope: z.literal(true),
});

export function useSidebarScopeFollowsLocation(): void {
  const location = useLocationProject();
  const { state: navigationState } = useLocation();
  const navigationType = useNavigationType();

  const keepsScope =
    navigationType !== NavigationType.Pop &&
    sidebarScopeKeepingNavigationStateSchema.safeParse(navigationState).success;

  const store = useStore();
  const stored = useAtomValue(sidebarScopeAtom);
  const catalog = useLoadedSidebarCatalog();
  const lastKeyRef = useRef<string | undefined>(undefined);
  const locationKey = location?.key;
  const locationProjectId = location?.projectId;

  useEffect(() => {
    if (
      locationKey === undefined ||
      locationProjectId === undefined ||
      locationKey === lastKeyRef.current
    ) {
      return;
    }

    lastKeyRef.current = locationKey;

    if (keepsScope) return;

    const scope = resolveSidebarScope(store.get(sidebarScopeAtom), catalog);

    if (scope.kind === "inbox" || scope.projectId === locationProjectId) {
      return;
    }

    store.set(sidebarScopeAtom, {
      kind: "project",
      projectId: locationProjectId,
    });
  }, [catalog, keepsScope, locationKey, locationProjectId, store, stored]);
}
