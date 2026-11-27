import type { CSSProperties } from "react";
import type { Board } from "../contract";
import type { ProjectCanvas, ProjectChat, ProjectSection } from "../project-contract";
import { layoutBoard, type BoardLayout, type Rect } from "../lib/layout";
import { OPEN_CHAT_CARD_WIDTH, unionRects } from "./project-geometry";
import { activeRegion, projectOverviewId } from "./project-home";

export type OverviewBoard = { kind: "ready"; board: Board } | { kind: "error" };

export type OverviewGeometry = { board: Board; layout: BoardLayout };

const projectGap = 180;

const projectHeader = 176;

export const overviewSectionHeaderHeight = 104;

const projectInset = 56;

type Section = {
  section: ProjectSection;
  board: Board | null;
  layout: BoardLayout | null;
  rect: Rect;
};

type Chat = { id: string; label: string; rect: Rect };

type Group = {
  id: string;
  name: string;
  sections: readonly Section[];
  chats: readonly Chat[];
  views: readonly { id: string; title: string; rect: Rect }[];
};

export function translate(rect: Rect, x: number, y: number): Rect {
  return { ...rect, x: rect.x + x, y: rect.y + y };
}

export function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function chatRect(chat: ProjectChat, sections: readonly ProjectSection[]): Rect {
  const section = sections.find(({ id }) => id === chat.regionId);

  return {
    x: chat.x + (section?.x ?? 0),
    y: chat.y + (section?.y ?? 0),
    width: OPEN_CHAT_CARD_WIDTH,
    height: 74,
  };
}

function placeGroups(groups: readonly Group[]) {
  const columns = Math.ceil(Math.sqrt(groups.length));
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  return groups.map((group, index) => {
    if (index % columns === 0 && index > 0) {
      x = 0;
      y += rowHeight + projectGap;
      rowHeight = 0;
    }

    const content = unionRects([
      ...group.sections.map(({ rect }) => rect),
      ...group.chats.map(({ rect }) => rect),
      ...group.views.map(({ rect }) => rect),
    ]);

    const width = Math.max(520, content.width + projectInset * 2);
    const height = content.height + projectHeader + overviewSectionHeaderHeight + projectInset;
    const bounds = { x, y, width, height };

    const offset = {
      x: x - content.x + projectInset,
      y: y - content.y + projectHeader + overviewSectionHeaderHeight,
    };

    x += width + projectGap;
    rowHeight = Math.max(rowHeight, height);

    return { ...group, bounds, offset };
  });
}

function sectionBounds(section: ProjectSection, layout: BoardLayout | null): Rect {
  const rect = layout?.bounds;

  return rect && rect.width > 0 && rect.height > 0
    ? translate(rect, section.x, section.y)
    : { x: section.x, y: section.y, width: 520, height: 260 };
}

export function layoutOverview({
  projects,
  threads,
  canvases,
  boards,
  geometries,
  heights,
}: {
  projects: readonly { id: string; name: string }[];
  threads: readonly { id: string; isArchived: boolean; isHidden: boolean; displayTitle: string }[];
  canvases: readonly { projectId: string; project: ProjectCanvas | null }[] | null;
  boards: ReadonlyMap<string, OverviewBoard>;
  geometries: ReadonlyMap<string, OverviewGeometry>;
  heights: ReadonlyMap<string, ReadonlyMap<string, number>>;
}) {
  const byProject = new Map(canvases?.map((row) => [row.projectId, row.project]));

  const threadTitles = new Map(
    threads
      .filter((thread) => !thread.isArchived && !thread.isHidden)
      .map((thread) => [thread.id, thread.displayTitle]),
  );

  const groups: Group[] = [];

  for (const { id, name } of projects) {
    const project = byProject.get(id);

    if (!project || project.archivedAt !== null) continue;

    const sections = project.sections
      .filter((section) => section.archivedAt === null)
      .toSorted((left, right) => left.order - right.order);

    const items = sections.map((section): Section => {
      const row = boards.get(section.id);
      const board = row?.kind === "ready" ? row.board : null;
      const geometry = geometries.get(section.id);

      const layout = board
        ? geometry?.board === board
          ? geometry.layout
          : layoutBoard(board, heights.get(board.threadId) ?? new Map())
        : null;

      return { section, board, layout, rect: sectionBounds(section, layout) };
    });

    const chats = project.chats.flatMap((chat): Chat[] => {
      const label = threadTitles.get(chat.threadId);

      return chat.role === "spawned" && chat.state === "open" && label !== undefined
        ? [{ id: chat.threadId, label, rect: chatRect(chat, sections) }]
        : [];
    });

    const views =
      items.length === 0 && chats.length === 0
        ? project.views.filter(
            (view) => view.id !== projectOverviewId(id) && activeRegion(project, view.regionId),
          )
        : [];

    if (items.length + chats.length + views.length > 0)
      groups.push({ id, name, sections: items, chats, views });
  }

  const placed = placeGroups(groups.sort((left, right) => left.name.localeCompare(right.name)));

  const layout: BoardLayout = {
    nodes: new Map(),
    sections: placed.map(({ id, bounds }) => ({ name: id, rect: bounds })),
    islands: [],
    tracks: new Map(),
    slack: new Map(),
    bounds: unionRects(placed.map(({ bounds }) => bounds)),
  };

  return { groups: placed, layout };
}
