import { useMemo } from "react";
import type {
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
} from "@omnyo/server-contract";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { arrangeByStoredOrder } from "@/lib/stored-order";
import {
  EMPTY_INBOX_TRIAGE,
  EMPTY_RAIL_ATTENTION,
  inboxTriage,
  railAttentionByRootProject,
  railRoots,
  type RailRoot,
  sumRailAttention,
  type InboxTriageCounts,
  type RailAttentionCounts,
} from "./railAttention";

export interface ProjectRailEntry {
  project: ProjectWithThreadsResponse;
  counts: RailAttentionCounts;
  roots: readonly RailRoot[];
}

export interface ProjectRailCatalog {
  entries: readonly ProjectRailEntry[];
  inbox: RailAttentionCounts;
  triage: InboxTriageCounts;
  attentionRoots: readonly RailRoot[];
}

const EMPTY_PROJECT_RAIL_CATALOG: ProjectRailCatalog = {
  entries: [],
  inbox: EMPTY_RAIL_ATTENTION,
  triage: EMPTY_INBOX_TRIAGE,
  attentionRoots: [],
};

export function selectProjectRailCatalog(
  catalog: SidebarBootstrapResponse | undefined,
): ProjectRailCatalog {
  if (catalog === undefined) return EMPTY_PROJECT_RAIL_CATALOG;

  const { ordered: projects } = arrangeByStoredOrder({
    items: [...catalog.projects, catalog.personalProject],
    getId: (project) => project.id,
    storedOrder: catalog.orderedProjectIds,
  });

  const threads = projects.flatMap((project) => project.threads);
  const roots = railRoots(threads);
  const counts = railAttentionByRootProject(roots);
  const rootsByProject = new Map<string, RailRoot[]>();

  for (const root of roots) {
    const projectId = root.thread.projectId;
    const group = rootsByProject.get(projectId);

    if (group === undefined) rootsByProject.set(projectId, [root]);
    else group.push(root);
  }

  return {
    entries: projects.map((project) => ({
      project,
      counts: counts.get(project.id) ?? EMPTY_RAIL_ATTENTION,
      roots: rootsByProject.get(project.id) ?? [],
    })),
    inbox: sumRailAttention(counts.values()),
    triage: inboxTriage(threads),
    attentionRoots: roots.filter(
      (root) => root.state === "failed" || root.state === "needs",
    ),
  };
}

export function useProjectRailCatalog(): ProjectRailCatalog {
  const { data } = useSidebarNavigation();

  return useMemo(() => selectProjectRailCatalog(data), [data]);
}
