import { useLocation, useMatch } from "react-router-dom";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { isSkillsRoutePath, isToolsRoutePath } from "@/lib/route-paths";

interface RouteState {
  entryStartedAt: number;
  projectId: string | undefined;
  threadId: string | undefined;
  isThreadView: boolean;
  isArchivedView: boolean;
  isToolsView: boolean;
  isSkillsView: boolean;
  isRootView: boolean;
  isProjectlessView: boolean;
}

const entryStartedAtByLocation = new WeakMap<object, number>();

export function useRouteState(): RouteState {
  const location = useLocation();
  let entryStartedAt = entryStartedAtByLocation.get(location);

  if (entryStartedAt === undefined) {
    entryStartedAt = Date.now();
    entryStartedAtByLocation.set(location, entryStartedAt);
  }

  const projectMatch = useMatch("/projects/:projectId/*");

  const projectThreadMatch = useMatch(
    "/projects/:projectId/threads/:threadId/*",
  );

  const projectlessThreadMatch = useMatch("/threads/:threadId/*");
  const projectlessArchivedMatch = useMatch("/archived");
  const projectArchivedMatch = useMatch("/projects/:projectId/archived");

  const isToolsPath =
    isToolsRoutePath(location.pathname) ||
    location.pathname === "/tools" ||
    location.pathname.startsWith("/tools/");

  const isRootView = location.pathname === "/";

  const isUnsupportedPersonalProjectThread =
    projectThreadMatch?.params.projectId === PERSONAL_PROJECT_ID;

  const projectlessThreadId = projectlessThreadMatch?.params.threadId;

  const threadId =
    projectlessThreadId ??
    (isUnsupportedPersonalProjectThread
      ? undefined
      : projectThreadMatch?.params.threadId);

  const projectRouteProjectId = projectMatch?.params.projectId;

  const projectId =
    projectlessThreadId !== undefined || Boolean(projectlessArchivedMatch)
      ? PERSONAL_PROJECT_ID
      : isUnsupportedPersonalProjectThread
        ? undefined
        : projectRouteProjectId;

  return {
    entryStartedAt,
    projectId,
    threadId,
    isThreadView:
      Boolean(projectlessThreadMatch) ||
      (Boolean(projectThreadMatch) && !isUnsupportedPersonalProjectThread),
    isArchivedView:
      Boolean(projectArchivedMatch) || Boolean(projectlessArchivedMatch),
    isToolsView: isToolsPath || location.pathname === "/automations",
    isSkillsView: isSkillsRoutePath(location.pathname),
    isRootView,
    isProjectlessView:
      isRootView ||
      projectlessThreadId !== undefined ||
      Boolean(projectlessArchivedMatch),
  };
}
