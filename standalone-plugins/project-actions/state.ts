import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Config, Run, State } from "./contract";

export type Snapshot = Config & { runs: Run[]; states: State[] };

export type LoadProject = (projectId: string) => Promise<Snapshot>;

interface ProjectState {
  snapshot: Snapshot;
  loadError: string | null;
}

interface Entry {
  value: ProjectState;
  listeners: Set<() => void>;
  pending: Promise<void> | null;
  nextLoad: LoadProject | null;
}

const projects = new Map<string, Entry>();

function emptyEntry(): Entry {
  return {
    value: { snapshot: { revision: 0, actions: [], runs: [], states: [] }, loadError: null },
    listeners: new Set(),
    pending: null,
    nextLoad: null,
  };
}

const noProject = emptyEntry();

function entryFor(projectId: string): Entry {
  let entry = projects.get(projectId);

  if (!entry) {
    entry = emptyEntry();
    projects.set(projectId, entry);
  }

  return entry;
}

function publish(entry: Entry, value: ProjectState) {
  entry.value = value;

  for (const listener of entry.listeners) listener();
}

async function refreshProject(projectId: string, load: LoadProject) {
  const entry = entryFor(projectId);

  entry.nextLoad = load;

  if (entry.pending) return entry.pending;
  entry.pending = (async () => {
    try {
      while (entry.nextLoad) {
        const nextLoad = entry.nextLoad;
        entry.nextLoad = null;

        try {
          const snapshot = await nextLoad(projectId);

          if (snapshot.revision >= entry.value.snapshot.revision)
            publish(entry, { snapshot, loadError: null });
        } catch {
          publish(entry, { ...entry.value, loadError: "Could not refresh project actions." });
        }
      }
    } finally {
      entry.pending = null;
    }
  })();

  return entry.pending;
}

export function useProjectActions(projectId: string | null, load: LoadProject) {
  const entry = projectId === null ? noProject : entryFor(projectId);

  const subscribe = useCallback(
    (listener: () => void) => {
      entry.listeners.add(listener);

      return () => {
        entry.listeners.delete(listener);
      };
    },
    [entry],
  );

  const getSnapshot = useCallback(() => entry.value, [entry]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(
    () => (projectId === null ? Promise.resolve() : refreshProject(projectId, load)),
    [projectId, load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
