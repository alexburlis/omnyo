import type { PluginSidebarThreadGroup } from "@omnyo/plugin-sdk/app";
import {
  isProjectRoot,
  type ChatNode,
  type ProjectGroup,
  type ProjectSection,
  type ProjectSectionKey,
  type RootEntry,
} from "./grouping.ts";

export type ChatGroup = Pick<PluginSidebarThreadGroup, "id" | "projectId" | "name">;

export interface ChatRowEntry {
  kind: "chat";
  entry: RootEntry;
}

export interface ChatFolder {
  kind: "group";
  group: ChatGroup;
  members: RootEntry[];
}

export type SectionRow = ChatRowEntry | ChatFolder;

export interface PlacedSection {
  key: ProjectSectionKey;
  label: string;
  folded: boolean;
  count: number;
  rows: SectionRow[];
}

export interface PlacedProject {
  projectId: string;
  sections: PlacedSection[];
  shelf: PlacedSection | null;
}

const OUTSIDE_FOLDERS: ReadonlySet<ProjectSectionKey> = new Set(["pinned", "shelf"]);

export function groupOfNode(
  node: ChatNode,
  groups: ReadonlyMap<string, ChatGroup>,
): ChatGroup | null {
  const { groupId, parentThreadId, projectId } = node.thread;

  if (groupId === null || parentThreadId !== null || !isProjectRoot(node)) return null;
  const group = groups.get(groupId);

  return group !== undefined && group.projectId === projectId ? group : null;
}

function countRows(rows: readonly SectionRow[]): number {
  let count = 0;

  for (const row of rows) {
    if (row.kind === "group") count += row.members.length;
    else if (isProjectRoot(row.entry.node)) count += 1;
  }

  return count;
}

function chatRows(section: ProjectSection): PlacedSection {
  const rows = section.entries.map((entry): SectionRow => ({ kind: "chat", entry }));

  return {
    key: section.key,
    label: section.label,
    folded: section.folded,
    count: countRows(rows),
    rows,
  };
}

export function placeGroups(
  sections: readonly ProjectSection[],
  groups: readonly ChatGroup[],
): PlacedSection[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const members = new Map<string, RootEntry[]>();

  const folderOf = (section: ProjectSection, entry: RootEntry) =>
    OUTSIDE_FOLDERS.has(section.key) ? null : groupOfNode(entry.node, byId);

  for (const section of sections) {
    for (const entry of section.entries) {
      const group = folderOf(section, entry);

      if (group === null) continue;
      const list = members.get(group.id);

      if (list === undefined) members.set(group.id, [entry]);
      else list.push(entry);
    }
  }

  const placed = new Set<string>();

  return sections.flatMap((section) => {
    const rows: SectionRow[] = [];

    for (const entry of section.entries) {
      const group = folderOf(section, entry);

      if (group === null) {
        rows.push({ kind: "chat", entry });
        continue;
      }

      if (placed.has(group.id)) continue;
      placed.add(group.id);
      rows.push({ kind: "group", group, members: members.get(group.id) ?? [entry] });
    }

    if (rows.length === 0) return [];

    return [
      {
        key: section.key,
        label: section.label,
        folded: section.folded,
        count: countRows(rows),
        rows,
      },
    ];
  });
}

export function placeProject(project: ProjectGroup, groups: readonly ChatGroup[]): PlacedProject {
  return {
    projectId: project.projectId,
    sections: placeGroups(project.sections, groups),
    shelf: project.shelf === null ? null : chatRows(project.shelf),
  };
}

export function groupFoldKey(groupId: string): string {
  return `group:${groupId}`;
}
