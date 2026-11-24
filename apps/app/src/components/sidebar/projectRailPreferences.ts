import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import { arrayMove } from "@dnd-kit/sortable";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import type { SidebarScope } from "./sidebarScope";

export const sidebarHiddenGroupsAtom = createSyncedPreferenceAtom(
  "sidebar.hiddenGroups",
);

const PROJECT_GROUP_PREFIX = "project:";

export function hiddenProjectGroupKey(projectId: string): string {
  return `${PROJECT_GROUP_PREFIX}${projectId}`;
}

export function hiddenProjectIdsOf(
  hiddenGroups: readonly string[],
): ReadonlySet<string> {
  return new Set(
    hiddenGroups
      .filter((key) => key.startsWith(PROJECT_GROUP_PREFIX))
      .map((key) => key.slice(PROJECT_GROUP_PREFIX.length)),
  );
}

export interface HiddenRailProjects {
  hiddenIds: ReadonlySet<string>;
  hide: (projectId: string) => void;
  show: (projectId: string) => void;
}

export function useHiddenRailProjects(): HiddenRailProjects {
  const [hiddenGroups, setHiddenGroups] = useAtom(sidebarHiddenGroupsAtom);

  const hiddenIds = useMemo(
    () => hiddenProjectIdsOf(hiddenGroups),
    [hiddenGroups],
  );

  const hide = useCallback(
    (projectId: string) => {
      const key = hiddenProjectGroupKey(projectId);

      setHiddenGroups((previous) =>
        previous.includes(key) ? previous : [...previous, key],
      );
    },
    [setHiddenGroups],
  );

  const show = useCallback(
    (projectId: string) => {
      const key = hiddenProjectGroupKey(projectId);

      setHiddenGroups((previous) =>
        previous.includes(key)
          ? previous.filter((entry) => entry !== key)
          : previous,
      );
    },
    [setHiddenGroups],
  );

  return { hiddenIds, hide, show };
}

export interface PartitionedRailEntries<TEntry> {
  visible: TEntry[];
  hidden: TEntry[];
  selectedHidden: TEntry | null;
}

export function partitionRailEntries<TEntry>({
  entries,
  getId,
  hiddenIds,
  scope,
}: {
  entries: readonly TEntry[];
  getId: (entry: TEntry) => string;
  hiddenIds: ReadonlySet<string>;
  scope: SidebarScope;
}): PartitionedRailEntries<TEntry> {
  const visible: TEntry[] = [];
  const hidden: TEntry[] = [];
  let selectedHidden: TEntry | null = null;

  for (const entry of entries) {
    const id = getId(entry);

    if (!hiddenIds.has(id)) {
      visible.push(entry);
      continue;
    }

    hidden.push(entry);

    if (scope.kind === "project" && scope.projectId === id) {
      selectedHidden = entry;
    }
  }

  return { visible, hidden, selectedHidden };
}

export interface RailProjectReorder {
  order: string[];
  previousProjectId: string | null;
  nextProjectId: string | null;
}

export function railProjectReorder(
  ids: readonly string[],
  activeId: string,
  overId: string,
): RailProjectReorder | null {
  if (activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);

  if (from === -1 || to === -1) return null;
  const order = arrayMove([...ids], from, to);

  return {
    order,
    previousProjectId: order[to - 1] ?? null,
    nextProjectId: order[to + 1] ?? null,
  };
}

export type RailMoveDirection = "up" | "down";

export function neighbourInDirection(
  visibleIds: readonly string[],
  projectId: string,
  direction: RailMoveDirection,
): string | null {
  const index = visibleIds.indexOf(projectId);

  if (index === -1) return null;

  return visibleIds[direction === "up" ? index - 1 : index + 1] ?? null;
}
