import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  experimental_useAppContext,
  experimental_useAppNavigate,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  type PluginCommandRegistration,
  type PluginContentScriptRegistration,
  type PluginContentScriptContext,
  type PluginRpcResult,
  type PluginThreadActionDataInput,
  type PluginThreadActionRegistration,
} from "@omnyo/plugin-sdk/app";
import { realtimeChannel, type CanvasRpcContract } from "../contract";
import { projectRealtimeChannel } from "../project-contract";
import { projectPath } from "./project-route";
import { ModelCache } from "./model-cache";
import { ReturnBoard } from "./project-return";
import { useProjectHistory } from "./project-history";

type ActionRow = PluginRpcResult<CanvasRpcContract["project.actions"]>[number];

const actionCache = new ModelCache<readonly ActionRow[]>("Canvas actions could not load. Retry.");

const openEvent = "canvas-project-open";

const adoptionEvent = "canvas-project-adopted";

const boardSignal = z.object({ threadId: z.string() });

const projectSignal = z.object({ projectId: z.string() });

const openInput = z.object({ projectId: z.string().nullable() });

const adoptionInput = z.object({ projectId: z.string(), sectionId: z.string() });

type RowMarkScope = {
  context: PluginContentScriptContext;
  setStatus: NonNullable<PluginContentScriptContext["experimental_setThreadRowStatus"]>;
  marked: Set<string>;
};

type RowMarkState = { scope: RowMarkScope | null; error: string | null };

let rowMarks: RowMarkState = { scope: null, error: null };

const rowMarkListeners = new Set<() => void>();

function publishRowMarks(scope: RowMarkScope | null, error: string | null) {
  rowMarks = { scope, error };

  for (const listener of rowMarkListeners) listener();
}

function clearRowMarks(scope: RowMarkScope) {
  for (const threadId of scope.marked) scope.setStatus(threadId, null);
  scope.marked.clear();
}

export const projectRowMarksScript: PluginContentScriptRegistration = {
  id: "project-canvas-row-marks",
  mount(context) {
    const setStatus = context.experimental_setThreadRowStatus;

    if (!setStatus) {
      const message = "Canvas row marks require thread row status support in this Omnyo client.";
      publishRowMarks(null, message);
      throw new Error(message);
    }

    const scope: RowMarkScope = { context, setStatus, marked: new Set() };

    const dispose = () => {
      clearRowMarks(scope);
      context.signal.removeEventListener("abort", dispose);

      if (rowMarks.scope === scope) publishRowMarks(null, null);
    };

    if (context.signal.aborted) return dispose;
    context.signal.addEventListener("abort", dispose, { once: true });
    publishRowMarks(scope, null);

    return dispose;
  },
};

function useAdoptedChatMarks() {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => {
      rowMarkListeners.add(listener);

      return () => {
        rowMarkListeners.delete(listener);
      };
    }, []),
    () => rowMarks,
  );

  const { threads } = experimental_useSidebarThreads();

  const actions = useProjectActions({
    threadIds:
      state.scope === null
        ? []
        : threads.filter((thread) => !thread.isHidden).map((thread) => thread.id),
  });

  useEffect(() => {
    const scope = state.scope;

    if (!scope || scope.context.signal.aborted || actions.rows === null) return;

    const linked = new Set(
      actions.rows
        .filter((row) => row.link?.sectionId && !row.link.chat)
        .map((row) => row.threadId),
    );

    for (const threadId of scope.marked)
      if (!linked.has(threadId)) {
        scope.setStatus(threadId, null);
        scope.marked.delete(threadId);
      }

    for (const threadId of linked)
      if (!scope.marked.has(threadId)) {
        scope.setStatus(threadId, { icon: "GridView", label: "In project canvas" });
        scope.marked.add(threadId);
      }
  }, [state.scope, actions.rows]);
  useEffect(() => {
    const scope = state.scope;

    return () => {
      if (scope) clearRowMarks(scope);
    };
  }, [state.scope]);

  return state.error ?? actions.error;
}

export const projectPaletteAction: PluginCommandRegistration = {
  id: "open-project-canvas",
  title: "Open project canvas",
  run: ({ projectId }) => {
    window.dispatchEvent(new CustomEvent(openEvent, { detail: { projectId } }));
  },
};

function useProjectActions({ threadIds }: PluginThreadActionDataInput) {
  const rpc = useRpc<CanvasRpcContract>();
  const remember = useProjectHistory();
  const key = [...new Set(threadIds)].sort().join("\n");
  const ids = useMemo(() => (key === "" ? [] : key.split("\n")), [key]);

  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => actionCache.subscribe(key, listener), [key]),
    () => actionCache.read(key),
  );

  const read = useCallback(async () => {
    const batches: Array<Promise<ActionRow[]>> = [];

    for (let index = 0; index < ids.length; index += 200)
      batches.push(rpc.call("project.actions", { threadIds: ids.slice(index, index + 200) }));

    return (await Promise.all(batches)).flat();
  }, [rpc, ids]);

  const refresh = useCallback(() => actionCache.load(key, read, true), [key, read]);
  useEffect(() => actionCache.load(key, read), [key, read]);
  useRealtime(projectRealtimeChannel, (payload) => {
    const event = projectSignal.safeParse(payload);

    if (event.success && entry.value?.some((row) => row.projectId === event.data.projectId))
      refresh();
  });
  useRealtime(realtimeChannel, (payload) => {
    const event = boardSignal.safeParse(payload);

    if (
      event.success &&
      (ids.includes(event.data.threadId) ||
        entry.value?.some((row) => row.link?.sectionId === event.data.threadId))
    )
      refresh();
  });

  return { rows: entry.value, error: entry.error, rpc, refresh, remember };
}

export const projectThreadAction: PluginThreadActionRegistration<
  ReturnType<typeof useProjectActions>
> = {
  id: "project-canvas",
  title: "Project canvas",
  icon: "GridView",
  group: "1_open",
  order: 40,
  useData: useProjectActions,
  item: ({ thread, data, navigate }) => {
    const row = data.rows?.find((entry) => entry.threadId === thread.id);

    if (!row)
      return data.error
        ? {
            label: "Retry Canvas actions",
            detail: data.error,
            icon: "GridView",
            run: data.refresh,
          }
        : null;

    if (row.link) {
      const link = row.link;

      const subPath = link.chat
        ? projectPath(row.projectId, { kind: "c", id: thread.id })
        : link.sectionId
          ? projectPath(row.projectId, { kind: "s", id: link.sectionId })
          : row.projectId;

      return {
        label: link.chat ? "Show on canvas" : "Open in project canvas",
        icon: "GridView",
        run: () => navigate.toPluginPanel("p", { subPath }),
      };
    }

    const boardTitle = row.boardTitle;

    if (boardTitle === null) return null;

    return {
      label: "Add board to project canvas",
      icon: "GridView",
      run: async () => {
        const project = await data.rpc.call("project.get", { projectId: row.projectId });

        const result = await data.rpc.call("project.adopt", {
          projectId: row.projectId,
          threadId: thread.id,
          title: boardTitle,
          actor: "human",
          expectedRevision: project.revision,
        });

        await data.remember(result);
        const section = result.sections.find((entry) => entry.originThreadId === thread.id);

        if (!section) throw new Error("The adopted section could not be found.");
        data.refresh();
        window.dispatchEvent(
          new CustomEvent(adoptionEvent, {
            detail: { projectId: row.projectId, sectionId: section.id },
          }),
        );
        navigate.toPluginPanel("p", {
          subPath: projectPath(row.projectId, { kind: "s", id: section.id }),
        });
      },
    };
  },
};

export function ProjectEntryPoints() {
  const navigate = experimental_useAppNavigate();
  const context = experimental_useAppContext();
  const rpc = useRpc<CanvasRpcContract>();
  const [error, setError] = useState<string | null>(null);
  const rowMarkError = useAdoptedChatMarks();
  const visibleError = error ?? rowMarkError;
  const [adoption, setAdoption] = useState<z.infer<typeof adoptionInput> | null>(null);
  const [returning, setReturning] = useState<z.infer<typeof adoptionInput> | null>(null);

  useEffect(() => {
    const open = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const input = openInput.safeParse(event.detail);

      if (input.success) navigate.toPluginPanel("p", { subPath: input.data.projectId ?? "" });
    };

    const adopted = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const input = adoptionInput.safeParse(event.detail);

      if (input.success) setAdoption(input.data);
    };

    window.addEventListener(openEvent, open);
    window.addEventListener(adoptionEvent, adopted);

    return () => {
      window.removeEventListener(openEvent, open);
      window.removeEventListener(adoptionEvent, adopted);
    };
  }, [navigate]);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (
        context.threadId === null ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");

      if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("target")) return;
      const match = /^#canvas-view-([A-Za-z0-9_-]+)$/u.exec(anchor.getAttribute("href") ?? "");
      const viewId = match?.[1];

      if (!viewId) return;
      event.preventDefault();
      event.stopPropagation();

      const request =
        context.projectId === null
          ? rpc.call("project.view.resolve", { viewId })
          : rpc.call("project.view.resolve", { viewId, projectId: context.projectId });

      void request.then(
        (view) => {
          if (view === null) {
            setError("That canvas view is no longer available.");

            return;
          }

          setError(null);
          navigate.toPluginPanel("p", {
            subPath: projectPath(view.projectId, { kind: "v", id: view.viewId }),
          });
        },
        (reason) =>
          setError(reason instanceof Error ? reason.message : "The canvas view could not open."),
      );
    };

    document.addEventListener("click", click, true);

    return () => document.removeEventListener("click", click, true);
  }, [context.projectId, context.threadId, navigate, rpc]);

  if (returning)
    return (
      <ReturnBoard
        projectId={returning.projectId}
        sectionId={returning.sectionId}
        onClose={() => setReturning(null)}
        onReturned={() => {
          setAdoption(null);
          setReturning(null);
        }}
      />
    );

  if (visibleError === null && adoption === null) return null;

  return (
    <>
      <div
        className="cnv-toolbar cnv-state"
        role={visibleError ? "alert" : "status"}
        style={{
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
        }}
      >
        {visibleError ?? "Board added to the project canvas."}
        {adoption ? (
          <button type="button" className="cnv-button" onClick={() => setReturning(adoption)}>
            Undo
          </button>
        ) : null}
        <button
          type="button"
          className="cnv-button"
          onClick={() => {
            setError(null);
            setAdoption(null);
          }}
        >
          Dismiss
        </button>
      </div>
    </>
  );
}
