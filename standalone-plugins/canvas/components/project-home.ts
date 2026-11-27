import type { ProjectCanvas, ProjectView } from "../project-contract";

export function projectOverviewId(projectId: string): string {
  return `view_overview_${projectId}`;
}

export function activeRegion(project: ProjectCanvas, regionId: string | null): boolean {
  return (
    regionId === null ||
    project.sections.some((section) => section.id === regionId && section.archivedAt === null)
  );
}

export function projectHomeViewId(project: ProjectCanvas): string {
  const home = project.views.find((view) => view.id === project.homeViewId);

  return home && activeRegion(project, home.regionId)
    ? home.id
    : projectOverviewId(project.projectId);
}

export function sectionOwnView(view: ProjectView): boolean {
  return (
    view.anchorKind === "section" &&
    view.regionId !== null &&
    view.anchorId === view.regionId &&
    view.rect.x === 0 &&
    view.rect.y === 0
  );
}
