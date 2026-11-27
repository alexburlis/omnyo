import type { ProjectCanvas, ProjectView } from "../../project-contract";

export function synthesizedOverview(projectId: string): ProjectView {
  return {
    id: `view_overview_${projectId}`,
    projectId,
    title: "Overview",
    order: 0,
    anchorKind: "free",
    regionId: null,
    anchorId: null,
    rect: { x: 0, y: 0, width: 1200, height: 800 },
    createdBy: "system",
    createdAt: 0,
  };
}

export function emptyServerCanvas(projectId: string): ProjectCanvas {
  return {
    projectId,
    revision: 0,
    homeViewId: `view_overview_${projectId}`,
    archivedAt: null,
    sections: [],
    views: [synthesizedOverview(projectId)],
    chats: [],
  };
}

export function archivedAdoptedCanvas(
  projectId: string,
  sectionId = "sec_retired",
  viewId = "view_retired",
): ProjectCanvas {
  return {
    ...emptyServerCanvas(projectId),
    revision: 2,
    sections: [
      {
        id: sectionId,
        projectId,
        title: "Retired",
        question: null,
        x: 0,
        y: 0,
        order: 1,
        locked: false,
        archivedAt: 1,
        originThreadId: "origin",
        createdBy: "human",
        createdAt: 1,
      },
    ],
    views: [
      synthesizedOverview(projectId),
      {
        id: viewId,
        projectId,
        title: "Retired",
        order: 1,
        anchorKind: "section",
        regionId: sectionId,
        anchorId: sectionId,
        rect: { x: 0, y: 0, width: 340, height: 208 },
        createdBy: "human",
        createdAt: 1,
      },
    ],
    chats: [
      {
        threadId: "origin",
        projectId,
        regionId: sectionId,
        anchorKind: "section",
        anchorId: sectionId,
        x: 0,
        y: 0,
        role: "origin",
        state: "open",
        createdAt: 1,
      },
    ],
  };
}
