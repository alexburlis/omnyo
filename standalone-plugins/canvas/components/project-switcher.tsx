import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import { readProjectSummary } from "./project-data";
import { ModelCache } from "./model-cache";

export type OtherCanvas = { projectId: string; name: string; unread: boolean };

type CanvasRow = { projectId: string; unread: boolean };

const canvases = new ModelCache<readonly CanvasRow[]>("Other canvases could not load.");

export function useOtherCanvases(projectId: string, search: string) {
  const rpc = useRpc<CanvasRpcContract>();
  const { projects } = experimental_useSidebarThreads();

  const key = projects
    .map((project) => project.id)
    .filter((id) => id !== projectId)
    .sort()
    .join(",");

  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => canvases.subscribe(key, listener), [key]),
    () => canvases.read(key),
  );

  const read = useCallback(async () => {
    const ids = key === "" ? [] : key.split(",");
    const rows: CanvasRow[] = [];
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];

          if (id === undefined) return;

          const [project, unseen] = await readProjectSummary(rpc, id);

          if (project.sections.some((section) => section.archivedAt === null))
            rows.push({ projectId: id, unread: unseen.sectionIds.length > 0 });
        }
      }),
    );

    return rows;
  }, [rpc, key]);

  useEffect(() => canvases.load(key, read), [key, read]);

  const retry = useCallback(() => canvases.load(key, read, true), [key, read]);

  const list = useMemo(() => {
    const query = search.toLowerCase();

    return projects.flatMap((project): OtherCanvas[] => {
      const row = entry.value?.find((item) => item.projectId === project.id);

      return row && project.name.toLowerCase().includes(query)
        ? [{ projectId: project.id, name: project.name, unread: row.unread }]
        : [];
    });
  }, [entry.value, projects, search]);

  return { canvases: list, error: entry.error, retry };
}

export function OtherCanvases({
  canvases: list,
  error,
  searching,
  onOpen,
  onRetry,
}: {
  canvases: readonly OtherCanvas[];
  error: string | null;
  searching: boolean;
  onOpen(projectId: string): void;
  onRetry(): void;
}) {
  if (list.length === 0 && error === null) return null;

  return (
    <details
      key={searching ? "searching" : "browsing"}
      role="treeitem"
      tabIndex={-1}
      aria-label="Other canvases"
      aria-expanded={searching}
      open={searching}
      className="cnv-project-section-row"
      onToggle={(event) =>
        event.currentTarget.setAttribute("aria-expanded", String(event.currentTarget.open))
      }
    >
      <summary tabIndex={-1}>
        <Icon name="ChevronRight" className="cnv-project-row-caret" aria-hidden />
        <span className="cnv-project-row">
          <Icon name="GridView" className="cnv-project-icon" aria-hidden />
          <span className="cnv-project-row-label">Other canvases</span>
          {list.length > 0 ? <span className="cnv-project-tag">{list.length}</span> : null}
        </span>
      </summary>
      <div role="group">
        {error ? (
          <button
            role="treeitem"
            tabIndex={-1}
            type="button"
            className="cnv-project-row"
            onClick={onRetry}
          >
            <Icon name="CircleAlert" className="cnv-project-icon" aria-hidden />
            <span className="cnv-project-row-label">{error} Try again</span>
          </button>
        ) : null}
        {list.map((canvas) => (
          <button
            key={canvas.projectId}
            role="treeitem"
            tabIndex={-1}
            type="button"
            className="cnv-project-row"
            title={`Open the ${canvas.name} canvas`}
            onClick={() => onOpen(canvas.projectId)}
          >
            <Icon name="GridView" className="cnv-project-icon" aria-hidden />
            <span className="cnv-project-row-label">{canvas.name}</span>
            {canvas.unread ? <span className="cnv-project-tag">New</span> : null}
          </button>
        ))}
      </div>
    </details>
  );
}
