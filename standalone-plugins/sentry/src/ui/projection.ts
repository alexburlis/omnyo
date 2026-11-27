import type { z } from "zod";
import {
  builtinModelDefaults,
  type InboxStatus,
  type Route,
  type rpcContract,
} from "../../contract";
import { isActiveRun } from "../run-state";

export type InboxTargets = z.infer<typeof rpcContract.targets.output>;

export function repositoryCount(routes: readonly Pick<Route, "hostId" | "repositoryPath">[]) {
  return new Set(routes.map((route) => JSON.stringify([route.hostId, route.repositoryPath]))).size;
}

export function projectInbox({
  status,
  targets,
  targetsLoaded,
  selectedProject,
  selected,
  search,
  severity,
  sort,
  routeId,
}: {
  status: InboxStatus | null;
  targets: InboxTargets;
  targetsLoaded: boolean;
  selectedProject: string;
  selected: string;
  search: string;
  severity: string;
  sort: string;
  routeId: string;
}) {
  const routes = status?.routes ?? [];
  const routesById = new Map(routes.map((route) => [route.id, route]));
  const projectsById = new Map(targets.projects.map((project) => [project.id, project]));

  const scopedRoutes = routes.filter(
    (route) => !selectedProject || route.projectId === selectedProject,
  );

  const manualRoutes = scopedRoutes.filter((route) => !selected || route.id === selected);
  const selectedRoute = manualRoutes.find((route) => route.id === routeId) ?? manualRoutes[0];

  const runs = (status?.runs ?? []).filter(
    (run) =>
      (!selected || run.route.id === selected) &&
      (!selectedProject || run.route.projectId === selectedProject),
  );

  const active = status?.runs.filter((run) => isActiveRun(run.state)).length ?? 0;
  const query = search.trim().toLowerCase();

  const incidents = (status?.incidents ?? [])
    .filter(
      (incident) =>
        (!selected || incident.matchedRouteIds.includes(selected)) &&
        (!severity || incident.level === severity) &&
        (!selectedProject ||
          incident.matchedRouteIds.some(
            (id) => routesById.get(id)?.projectId === selectedProject,
          )) &&
        [
          incident.shortId,
          incident.exceptionType,
          incident.environment,
          incident.release ?? "",
          ...incident.matchedRouteIds.map((id) => routesById.get(id)?.name ?? ""),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? a.firstSeen.localeCompare(b.firstSeen)
        : sort === "severity"
          ? Number(b.level === "fatal") - Number(a.level === "fatal") ||
            b.lastSeen.localeCompare(a.lastSeen)
          : b.lastSeen.localeCompare(a.lastSeen),
    );

  const missingProject = (id: string) => targetsLoaded && !projectsById.has(id);

  const projectName = (id: string) =>
    missingProject(id) ? "Deleted project (" + id + ")" : (projectsById.get(id)?.name ?? id);

  const projectIds = [...new Set(routes.map((route) => route.projectId))];
  const focusedProject = selectedProject || (projectIds.length === 1 ? projectIds[0] : "");
  const issueCounts = new Map(status?.projectIssueCounts?.map((row) => [row.projectId, row.count]));

  const issueCount = (id: string) =>
    issueCounts.get(id) ??
    status?.incidents.filter((issue) =>
      issue.matchedRouteIds.some((routeId) => routesById.get(routeId)?.projectId === id),
    ).length ??
    0;

  return {
    models: status?.models ?? builtinModelDefaults,
    routes,
    scopedRoutes,
    manualRoutes,
    selectedRoute,
    runs,
    active,
    incidents,
    freshness: status?.badge.freshness,
    projectIds,
    focusedProject,
    missingProject,
    projectName,
    issueCount,
  };
}

export function dateLabel(value: string | null | undefined) {
  if (!value) return "Not synced";
  const date = new Date(value);

  return Number.isNaN(date.valueOf())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}
