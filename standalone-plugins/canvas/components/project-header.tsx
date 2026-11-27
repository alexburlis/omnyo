import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useRpc,
  type PluginNavPanelProps,
} from "@omnyo/plugin-sdk/app";
import type { CanvasRpcContract } from "../contract";
import { useIsCompactViewport } from "../ui/components/ui/hooks/use-compact-viewport";
import { readProjectRoute } from "./project-route";

const headerAction = z.object({
  projectId: z.string(),
  action: z.enum(["save", "contents", "jump", "changes", "sources", "fit", "fullscreen"]),
});

type HeaderState = {
  place: string | null;
  contents: boolean;
  changes: boolean;
  sources: boolean;
  fullScreen: boolean;
  empty: boolean;
};

const closedHeader: HeaderState = {
  place: null,
  contents: false,
  changes: false,
  sources: false,
  fullScreen: false,
  empty: false,
};

const headerStates = new Map<string, HeaderState>();

const headerListeners = new Set<() => void>();

function publishHeader(projectId: string, next: HeaderState) {
  const current = headerStates.get(projectId);

  if (
    current?.place === next.place &&
    current.contents === next.contents &&
    current.changes === next.changes &&
    current.sources === next.sources &&
    current.fullScreen === next.fullScreen &&
    current.empty === next.empty
  )
    return;
  headerStates.set(projectId, next);

  for (const listener of headerListeners) listener();
}

function subscribeHeader(listener: () => void) {
  headerListeners.add(listener);

  return () => {
    headerListeners.delete(listener);
  };
}

export function useProjectHeader(
  projectId: string,
  state: HeaderState,
  onAction: (action: z.infer<typeof headerAction>["action"]) => void,
) {
  useEffect(
    () => publishHeader(projectId, state),
    [
      projectId,
      state.place,
      state.contents,
      state.changes,
      state.sources,
      state.fullScreen,
      state.empty,
    ],
  );
  useEffect(() => () => publishHeader(projectId, closedHeader), [projectId]);
  useEffect(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value = headerAction.safeParse(event.detail);

      if (value.success && value.data.projectId === projectId) onAction(value.data.action);
    };

    window.addEventListener("canvas-project-action", receive);

    return () => window.removeEventListener("canvas-project-action", receive);
  });
}

function headerCommand(projectId: string, action: z.infer<typeof headerAction>["action"]) {
  window.dispatchEvent(new CustomEvent("canvas-project-action", { detail: { projectId, action } }));
}

export function ProjectCanvasHeader({ subPath }: PluginNavPanelProps) {
  return subPath === "" ? (
    <span className="cnv-project-overview-heading">Canvas</span>
  ) : (
    <ProjectTools subPath={subPath} />
  );
}

function ProjectTools({ subPath }: Pick<PluginNavPanelProps, "subPath">) {
  const { projectId } = readProjectRoute(subPath);
  const [name, setName] = useState<string | null>(null);
  const rpc = useRpc<CanvasRpcContract>();
  const navigate = experimental_useAppNavigate();
  const compact = useIsCompactViewport();

  const state = useSyncExternalStore(
    subscribeHeader,
    () => headerStates.get(projectId) ?? closedHeader,
  );

  useEffect(() => {
    if (projectId === "") {
      setName(null);

      return;
    }

    void rpc.call("project.info", { projectId }).then(
      (value) => setName(value.name),
      () => setName(null),
    );
  }, [rpc, projectId]);

  const tools: Array<{
    action: "changes" | "sources" | "fullscreen";
    icon: string;
    title: string;
    label: string;
    pressed: boolean;
    disabled: boolean;
  }> = [
    {
      action: "changes",
      icon: "Clock",
      title: "Project changes",
      label: "Project changes",
      pressed: state.changes,
      disabled: false,
    },
    {
      action: "sources",
      icon: "Plug02",
      title: state.empty ? "Add a section to connect sources" : "Sources",
      label: "Sources",
      pressed: state.sources,
      disabled: state.empty,
    },
  ];

  const place = compact ? null : state.place;

  if (!compact)
    tools.push({
      action: "fullscreen",
      icon: state.fullScreen ? "Minimize2" : "Maximize2",
      title: state.fullScreen ? "Exit full screen" : "Full screen",
      label: "Full screen",
      pressed: state.fullScreen,
      disabled: false,
    });

  return (
    <div
      className="cnv-project-toolbar"
      data-compact={compact}
      role="toolbar"
      aria-label="Canvas tools"
    >
      <button
        type="button"
        className="cnv-tool"
        title="Canvas overview"
        aria-label="Canvas overview"
        onClick={() => navigate.toPluginPanel("p")}
      >
        <Icon name="ArrowLeft" className="cnv-project-icon" aria-hidden />
      </button>
      <button
        type="button"
        className="cnv-project-crumb"
        title="Jump to a section or view"
        aria-label={`${name ?? "Project"} canvas${place ? `, ${place}` : ""}. Jump to a section or view`}
        disabled={projectId === ""}
        onClick={() => headerCommand(projectId, "jump")}
      >
        <Icon name="GridView" className="cnv-project-icon" aria-hidden />
        {compact ? null : (
          <>
            <span className="cnv-project-crumb-project">{name ?? "Canvas"}</span>
            {place ? (
              <>
                <Icon name="ChevronRight" className="cnv-project-crumb-separator" aria-hidden />
                <span className="cnv-project-crumb-place">{place}</span>
              </>
            ) : null}
            <Icon name="ChevronDown" className="cnv-project-crumb-caret" aria-hidden />
          </>
        )}
      </button>
      <span className="cnv-project-toolbar-spacer" />
      <button
        type="button"
        className="cnv-tool"
        data-labelled={!compact}
        aria-pressed={state.contents}
        aria-label="Contents"
        title="Contents (C)"
        disabled={projectId === ""}
        onClick={() => headerCommand(projectId, "contents")}
      >
        <Icon name="ListView" className="cnv-project-icon" aria-hidden />
        {compact ? null : <span>Contents</span>}
      </button>
      {compact ? null : (
        <button
          type="button"
          className="cnv-tool"
          data-labelled
          aria-label="Save view"
          title="Save what you see as a view (B)"
          disabled={projectId === ""}
          onClick={() => headerCommand(projectId, "save")}
        >
          <Icon name="Pin" className="cnv-project-icon" aria-hidden />
          <span>Save view</span>
        </button>
      )}
      <span className="cnv-tool-divider" aria-hidden="true" />
      {tools.map((tool) => (
        <button
          key={tool.action}
          type="button"
          className="cnv-tool"
          aria-pressed={tool.pressed}
          aria-label={tool.label}
          title={tool.title}
          disabled={projectId === "" || tool.disabled}
          onClick={() => headerCommand(projectId, tool.action)}
        >
          <Icon name={tool.icon} className="cnv-project-icon" aria-hidden />
        </button>
      ))}
    </div>
  );
}
