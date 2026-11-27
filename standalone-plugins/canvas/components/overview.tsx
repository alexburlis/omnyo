import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  experimental_useSidebarThreads,
} from "@omnyo/plugin-sdk/app";
import type { Board } from "../contract";
import type { Rect, Viewport } from "../lib/layout";
import { nextSemanticDetail } from "../lib/semantic";
import { rememberedHeights } from "../lib/measured-heights";
import type { SourceState } from "../source-contract";
import {
  fitOverviewSurface,
  intersects,
  projectFit,
  projectSurfaceOptions,
  worldWindow,
} from "./project-geometry";
import { ProjectSectionLayer, type ProjectLayerModel } from "./project-section";
import { useProjectSidebarData } from "./project-data";
import { useOverviewBoards } from "./overview-boards";
import { WorldSurface, type BoardCommands } from "./world";
import {
  layoutOverview,
  rectStyle,
  translate,
  overviewSectionHeaderHeight,
  type OverviewGeometry,
} from "./overview-layout";

const workspace = { hostId: null, environmentId: null };

const idle = () => {};

const noSources: readonly SourceState[] = [];

const detailZoom = 0.35;

const contentZoom = 0.1;

const sectionKeys = z.array(z.string());

export function CanvasOverview() {
  const navigate = experimental_useAppNavigate();

  const { projects, threads, status } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active", "shelved"],
  });

  const { entry, refresh } = useProjectSidebarData(projects);

  const sectionKey = JSON.stringify(
    entry.value
      ?.flatMap(({ project }) =>
        project?.archivedAt === null
          ? project.sections.filter((section) => section.archivedAt === null).map(({ id }) => id)
          : [],
      )
      .toSorted() ?? [],
  );

  const sectionIds = useMemo(() => sectionKeys.parse(JSON.parse(sectionKey)), [sectionKey]);
  const { boards, load } = useOverviewBoards(sectionIds);

  const [geometries, setGeometries] = useState<ReadonlyMap<string, OverviewGeometry>>(new Map());

  const [selected, setSelected] = useState<{ sectionId: string; nodeId: string } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hasOpened, setHasOpened] = useState(false);
  const commands = useRef<BoardCommands | null>(null);

  const setCommands = useCallback((next: BoardCommands) => {
    commands.current = next;
  }, []);

  const updateSize = useCallback((_: Viewport, next: typeof size) => {
    setSize((current) =>
      current.width === next.width && current.height === next.height ? current : next,
    );
  }, []);

  const reportLayout = useCallback(
    (sectionId: string, layer: ProjectLayerModel) => {
      const row = boards.get(sectionId);

      if (row?.kind !== "ready") return;
      setGeometries((current) => {
        const previous = current.get(sectionId);

        return previous?.board === row.board && previous.layout === layer.localLayout
          ? current
          : new Map(current).set(sectionId, { board: row.board, layout: layer.localLayout });
      });
    },
    [boards],
  );

  const { groups, layout } = useMemo(() => {
    const heights = new Map(
      [...boards.values()].flatMap((row) =>
        row.kind === "ready"
          ? [
              [
                row.board.threadId,
                new Map(
                  [...rememberedHeights(row.board.threadId)].map(([id, entry]) => [
                    id,
                    entry.height,
                  ]),
                ),
              ] as const,
            ]
          : [],
      ),
    );

    return layoutOverview({
      projects,
      threads,
      canvases: entry.value,
      boards,
      geometries,
      heights,
    });
  }, [boards, geometries, entry.value, projects, threads]);

  const selectNode = useCallback((sectionId: string, node: Board["nodes"][number]) => {
    setSelected({ sectionId, nodeId: node.id });
  }, []);

  function zoomTo(rect: Rect, detail: Rect = rect) {
    const viewport = projectFit(rect, size, true);

    if (viewport.zoom >= detailZoom) {
      commands.current?.restore(viewport);

      return;
    }

    const zoom = Math.max(detailZoom, Math.min(1, (size.width - 96) / detail.width));
    const visibleWidth = Math.min(detail.width, (size.width - 96) / zoom);
    commands.current?.restore({
      zoom,
      x: size.width / 2 - (detail.x + visibleWidth / 2) * zoom,
      y: 48 - detail.y * zoom,
    });
  }

  function render(viewport: Viewport) {
    const visible = worldWindow(viewport, size);
    const detail = nextSemanticDetail("evidence", viewport.zoom);
    const overview = viewport.zoom < detailZoom;
    const showContent = viewport.zoom >= contentZoom;

    return groups.map(({ id, name, sections, chats, views, bounds, offset }) => {
      const first = sections[0];

      return (
        <div
          key={id}
          className="cnv-overview-project"
          data-canvas-project={id}
          data-overview={overview}
          style={{ left: offset.x, top: offset.y }}
        >
          <button
            type="button"
            className="cnv-overview-group"
            aria-label={`Zoom to ${name} canvas`}
            style={rectStyle(translate(bounds, -offset.x, -offset.y))}
            onClick={() => zoomTo(bounds, first && translate(first.rect, offset.x, offset.y))}
          >
            <span className="cnv-overview-group-title">{name}</span>
          </button>
          {sections.map(({ section, board, rect, layout }) => {
            const worldRect = translate(rect, offset.x, offset.y);

            return (
              <div key={section.id} data-project-section-id={section.id}>
                <section
                  className="cnv-project-section cnv-overview-section"
                  style={rectStyle({
                    x: rect.x - 16,
                    y: rect.y - overviewSectionHeaderHeight,
                    width: rect.width + 32,
                    height: rect.height + overviewSectionHeaderHeight + 16,
                  })}
                  aria-label={section.title}
                >
                  <button
                    type="button"
                    className="cnv-overview-section-title"
                    onClick={() => zoomTo(worldRect)}
                  >
                    {section.title}
                  </button>
                </section>
                {showContent && board ? (
                  <div inert={overview}>
                    <ProjectSectionLayer
                      section={section}
                      board={board}
                      inView={viewport.zoom >= 0.45 && intersects(worldRect, visible)}
                      zoom={viewport.zoom}
                      detail={detail}
                      showContentAtAnyZoom
                      selected={selected?.sectionId === section.id ? selected.nodeId : null}
                      workspace={workspace}
                      sources={noSources}
                      onSelect={selectNode}
                      onSelectIsland={idle}
                      onGeometry={reportLayout}
                      onSources={idle}
                    />
                  </div>
                ) : board && layout ? (
                  board.nodes.map((node) => {
                    const nodeRect = layout.nodes.get(node.id);

                    return nodeRect ? (
                      <span
                        key={node.id}
                        className="cnv-overview-module"
                        aria-hidden
                        style={rectStyle(translate(nodeRect, section.x, section.y))}
                      >
                        <span>{node.title ?? node.kind}</span>
                      </span>
                    ) : null;
                  })
                ) : null}
              </div>
            );
          })}
          {chats.map(({ id, label, rect }) => (
            <button
              key={id}
              type="button"
              className="cnv-overview-item"
              style={rectStyle(rect)}
              onClick={() => navigate.toThread(id)}
            >
              <Icon name="MessageCircle" className="cnv-project-icon" aria-hidden />
              <span>{label}</span>
            </button>
          ))}
          {views.map(({ id, title, rect }) => (
            <button
              key={id}
              type="button"
              className="cnv-overview-item"
              style={rectStyle(rect)}
              onClick={() => zoomTo(translate(rect, offset.x, offset.y))}
            >
              <Icon name="Pin" className="cnv-project-icon" aria-hidden />
              <span>{title}</span>
            </button>
          ))}
        </div>
      );
    });
  }

  const failedSections = sectionIds.filter((id) => boards.get(id)?.kind === "error");
  const projectError = entry.error ?? entry.value?.find((row) => row.error !== null)?.error;

  const error =
    status === "error"
      ? "Projects could not load."
      : (projectError ??
        (failedSections.length > 0 ? "Some canvas sections could not load." : null));

  const loading =
    status !== "ready" || entry.value === null || sectionIds.some((id) => !boards.has(id));

  const showScene = !loading && groups.length > 0;

  if (showScene && !hasOpened) setHasOpened(true);

  return (
    <div className="cnv-panel cnv-project" role="region" aria-label="Canvas overview">
      {hasOpened || showScene ? (
        <div className="cnv-project-world">
          <WorldSurface
            layout={layout}
            {...projectSurfaceOptions}
            fitBounds={fitOverviewSurface}
            fitOnMount
            onViewportChange={updateSize}
            render={render}
            onSelect={() => setSelected(null)}
            onCommands={setCommands}
          />
        </div>
      ) : null}
      {error ? (
        <div className="cnv-project-toasts">
          <div className="cnv-project-toast" data-tone="destructive" role="alert">
            <span className="cnv-project-toast-text">{error}</span>
            {status === "error" ? null : (
              <button
                type="button"
                className="cnv-project-toast-action"
                onClick={() => {
                  if (projectError) refresh();

                  for (const id of failedSections) void load(id);
                }}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      ) : loading ? (
        <div className="cnv-notice" role="status">
          Loading canvases…
        </div>
      ) : groups.length === 0 ? (
        <div className="cnv-notice">No project canvases yet.</div>
      ) : null}
    </div>
  );
}
