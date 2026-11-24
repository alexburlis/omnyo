import type { ThreadListEntry } from "@omnyo/domain";

export const LAUNCHER_PROJECT_CELLS = 5;

export const LAUNCHER_RANKING_WINDOW_MS = 14 * 86_400_000;

export interface RankableProject {
  id: string;
  threads: readonly Pick<
    ThreadListEntry,
    "parentThreadId" | "lastMessageAt" | "createdAt"
  >[];
}

export type DockMoreSelection =
  | { kind: "project"; projectId: string }
  | { kind: "no-project" };

export interface DockCells {
  cells: readonly string[];
  moreShows: DockMoreSelection | null;
}

interface ProjectRank {
  id: string;
  sidebarIndex: number;
  recentChats: number;
  latestActivity: number;
}

function rankProject(
  project: RankableProject,
  sidebarIndex: number,
  windowStart: number,
): ProjectRank {
  const recentActivity = project.threads
    .filter((thread) => thread.parentThreadId === null)
    .map((thread) => thread.lastMessageAt ?? thread.createdAt)
    .filter((activity) => activity >= windowStart);

  return {
    id: project.id,
    sidebarIndex,
    recentChats: recentActivity.length,
    latestActivity: recentActivity.reduce(
      (latest, activity) => Math.max(latest, activity),
      0,
    ),
  };
}

export function rankLauncherProjects(
  projects: readonly RankableProject[],
  now: number,
): readonly string[] {
  const windowStart = now - LAUNCHER_RANKING_WINDOW_MS;

  return projects
    .map((project, index) => rankProject(project, index, windowStart))
    .sort(
      (left, right) =>
        right.recentChats - left.recentChats ||
        right.latestActivity - left.latestActivity ||
        left.sidebarIndex - right.sidebarIndex,
    )
    .map((rank) => rank.id);
}

export function dockCells(
  ranked: readonly string[],
  selectedProjectId: string | null,
): DockCells {
  const cells = ranked.slice(0, LAUNCHER_PROJECT_CELLS);

  if (selectedProjectId === null) {
    return { cells, moreShows: { kind: "no-project" } };
  }

  return {
    cells,
    moreShows: cells.includes(selectedProjectId)
      ? null
      : { kind: "project", projectId: selectedProjectId },
  };
}
