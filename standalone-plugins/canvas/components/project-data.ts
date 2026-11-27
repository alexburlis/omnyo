import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  useRealtime,
  useRpc,
  type ExperimentalProjectSidebarItemsRegistration,
} from "@omnyo/plugin-sdk/app";
import { realtimeChannel, type CanvasRpcContract } from "../contract";
import { projectRealtimeChannel, type ProjectCanvas } from "../project-contract";
import { ModelCache } from "./model-cache";

type SidebarData = {
  projectId: string;
  project: ProjectCanvas | null;
  unseen: readonly string[];
  error: string | null;
};

const projectSignal = z.object({ projectId: z.string() });

const boardSignal = z.object({ threadId: z.string() });

const sidebarData = new ModelCache<readonly SidebarData[]>(
  "Canvas could not load. Retry.",
  "subscribed",
);

export function readProjectSummary(
  rpc: ReturnType<typeof useRpc<CanvasRpcContract>>,
  projectId: string,
) {
  return Promise.all([
    rpc.call("project.get", { projectId }),
    rpc.call("project.unseen", { projectId }),
  ]);
}

export function useProjectSidebarData(
  projects: Parameters<ExperimentalProjectSidebarItemsRegistration["useItems"]>[0]["projects"],
) {
  const rpc = useRpc<CanvasRpcContract>();

  const key = JSON.stringify(projects.map((project) => project.id).sort());
  const ids = useMemo(() => z.array(z.string()).parse(JSON.parse(key)), [key]);

  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => sidebarData.subscribe(key, listener), [key]),
    () => sidebarData.read(key),
  );

  const read = useCallback(async () => {
    const results: SidebarData[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const projectId = ids[cursor++];

          if (projectId === undefined) return;

          try {
            const [project, unseen] = await readProjectSummary(rpc, projectId);

            results.push({ projectId, project, unseen: unseen.sectionIds, error: null });
          } catch (reason) {
            results.push({
              projectId,
              project: null,
              unseen: [],
              error: reason instanceof Error ? reason.message : "Canvas could not load. Retry.",
            });
          }
        }
      }),
    );

    return results;
  }, [rpc, ids]);

  const refresh = useCallback(() => sidebarData.load(key, read, true), [key, read]);
  useEffect(() => sidebarData.load(key, read), [key, read]);
  useRealtime(projectRealtimeChannel, (payload) => {
    const event = projectSignal.safeParse(payload);

    if (event.success && ids.includes(event.data.projectId)) refresh();
  });
  useRealtime(realtimeChannel, (payload) => {
    const event = boardSignal.safeParse(payload);

    if (
      event.success &&
      entry.value?.some((row) =>
        row.project?.sections.some((section) => section.id === event.data.threadId),
      )
    )
      refresh();
  });

  return { entry, refresh };
}
