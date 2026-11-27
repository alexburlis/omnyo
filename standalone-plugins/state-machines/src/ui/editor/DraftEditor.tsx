import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useIsCompactViewport } from "../../../components/omnyo/components/ui/hooks/use-compact-viewport.js";
import type { DraftView, EditorDraft, StateKind } from "../data/contract.js";
import { useDraft, useEnvironments, useMachines } from "../data/hooks.js";
import { Canvas } from "../graph/Canvas.js";
import {
  addStateOperation,
  addTransitionOperation,
  deleteStatesOperation,
  deleteTransitionsOperation,
  duplicateStateOperation,
  moveStatesOperation,
  reorderTransitionOperation,
  updateMachineOperation,
} from "../graph/edit-model.js";
import { DraftOverview, selectionForProblem } from "../inspector/DraftOverview.js";
import { StateInspector } from "../inspector/StateInspector.js";
import { TransitionInspector } from "../inspector/TransitionInspector.js";
import { Outline } from "../outline/Outline.js";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  EmptyState,
  ErrorAlert,
  Pill,
  Sheet,
  Skeleton,
} from "../primitives.js";
import type { Selection } from "../routes.js";
import { FloatingPanel, MachineTabs, Page, useAnnounce, useGo } from "../shell.js";
import { ContextEditor } from "./ContextEditor.js";
import { PublishDialog } from "./PublishDialog.js";
import { type DraftEditorController, useDraftEditor } from "./useDraftEditor.js";

export function DraftEditorScreen({
  machineId,
  selection,
}: {
  machineId: string;
  selection: Selection;
}) {
  const draft = useDraft(machineId);

  if (draft.error !== null && draft.data === undefined)
    return (
      <Page
        crumbs={[
          { label: "State machines", route: { screen: "list" } },
          { label: "Draft", route: null },
        ]}
        title="Draft"
      >
        {draft.error.code === "NOT_FOUND" ? (
          <EmptyState title="This machine doesn't exist or was removed." />
        ) : (
          <ErrorAlert error={draft.error} onRetry={draft.refetch} subject="machine" />
        )}
      </Page>
    );

  if (draft.data === undefined)
    return (
      <Page
        crumbs={[
          { label: "State machines", route: { screen: "list" } },
          { label: "Draft", route: null },
        ]}
        title="Draft"
      >
        <Skeleton rows={6} height={48} />
      </Page>
    );

  return <DraftEditorLoaded key={machineId} initial={draft.data} selection={selection} />;
}

const SAVE_LABEL = {
  saved: "Saved",
  saving: "Saving…",
  retrying: "Not saved — retrying",
  failed: "Not saved — retrying",
  rejected: "Save rejected",
  conflict: "Not saved — conflict",
} as const;

function DraftEditorLoaded({ initial, selection }: { initial: DraftView; selection: Selection }) {
  const editor = useDraftEditor(initial);
  const go = useGo();
  const announce = useAnnounce();
  const compact = useIsCompactViewport();
  const machines = useMachines(null);
  const machine = machines.data?.find((item) => item.machineId === initial.machineId);
  const projectId = machine?.projectId ?? null;
  const environments = useEnvironments(projectId);
  const draft = editor.state.draft;
  const [view, setView] = useState<"graph" | "outline">(compact ? "outline" : "graph");
  const [multi, setMulti] = useState<ReadonlySet<string>>(new Set());
  const [publishOpen, setPublishOpen] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [reapplyFailed, setReapplyFailed] = useState<string[] | null>(null);
  const [confirmLoadLatest, setConfirmLoadLatest] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; transitions: number } | null>(
    null,
  );

  const [infoOpen, setInfoOpen] = useState(false);
  const panelOpen = selection !== null || infoOpen;
  const titleInput = useRef<HTMLInputElement | null>(null);
  const [renameName, setRenameName] = useState<string | null>(null);

  const select = useCallback(
    (next: Selection) => {
      go({ screen: "draft", machineId: initial.machineId, selection: next }, { replace: true });
    },
    [go, initial.machineId],
  );

  useEffect(() => {
    if (selection === null) return;

    const exists =
      selection.kind === "state"
        ? draft.states.some((state) => state.id === selection.id)
        : draft.transitions.some((edge) => edge.id === selection.id);

    if (!exists) select(null);
  }, [draft.states, draft.transitions, select, selection]);

  useEffect(() => {
    if (published === null) return;

    const timer = window.setTimeout(() => setPublished(null), 5000);

    return () => window.clearTimeout(timer);
  }, [published]);

  const problemMarks = useMemo(() => {
    const marks = new Map<string, "error" | "warning" | "info">();

    for (const problem of editor.problems) {
      const target = selectionForProblem(problem, draft);

      if (target === null) continue;

      const key = `${target.kind === "state" ? "state" : "tr"}:${target.id}`;

      if (marks.get(key) !== "error") marks.set(key, problem.severity);
    }

    return marks;
  }, [draft, editor.problems]);

  const errorCount = editor.problems.filter((problem) => problem.severity === "error").length;

  const stateTitles = useMemo(
    () => new Map(draft.states.map((state) => [state.id, state.title])),
    [draft.states],
  );

  const publishedOnce = editor.baseVersionNumber !== null;

  const requestDelete = (target: Exclude<Selection, null>, extra: readonly string[]) => {
    if (target.kind === "transition") {
      editor.dispatch(deleteTransitionsOperation([target.id]));
      select(null);

      return;
    }

    const ids = [...new Set([target.id, ...extra])];

    const transitions = draft.transitions.filter(
      (edge) => ids.includes(edge.from) || (edge.to !== null && ids.includes(edge.to)),
    ).length;

    if (transitions > 2) {
      setConfirmDelete({ ids, transitions });

      return;
    }

    editor.dispatch(deleteStatesOperation(ids));
    announce(`Deleted ${ids.length === 1 ? "state" : `${ids.length} states`}.`);
    select(null);
  };

  const addState = (kind: StateKind, at: { x: number; y: number } | null) => {
    editor.dispatch(
      addStateOperation(kind, at, (id) => {
        window.setTimeout(() => {
          select({ kind: "state", id });
          window.setTimeout(() => titleInput.current?.focus(), 50);
        }, 0);
      }),
    );
  };

  const closePanel = () => {
    setInfoOpen(false);

    if (selection !== null) select(null);
  };

  const addTransition = (from: string, to: string | null) => {
    editor.dispatch(
      addTransitionOperation(from, to, (id) =>
        window.setTimeout(() => select({ kind: "transition", id }), 0),
      ),
    );
  };

  const inspector = (
    <InspectorBody
      editor={editor}
      draft={draft}
      selection={selection}
      projectId={projectId}
      environments={environments.data}
      stateTitles={stateTitles}
      publishedOnce={publishedOnce}
      onSelect={select}
      onAddTransition={(from) => addTransition(from, null)}
      onDelete={requestDelete}
      titleRef={(element) => {
        titleInput.current = element;
      }}
    />
  );

  const externalWriteSteps = draft.states.flatMap((state) =>
    (state.kind === "agent" || state.kind === "command") && state.effect === "external-write"
      ? [state.title]
      : [],
  );

  return (
    <Page
      flush
      crumbs={[
        { label: "State machines", route: { screen: "list" } },
        { label: draft.name, route: { screen: "machine", machineId: initial.machineId } },
        { label: "Draft", route: null },
      ]}
      title={
        renameName === null ? (
          <button
            type="button"
            className="stm-title-button"
            aria-label={`Rename ${draft.name}`}
            onClick={() => setRenameName(draft.name)}
          >
            {draft.name}
          </button>
        ) : (
          <input
            className="stm-input stm-title-input"
            aria-label="Machine title"
            autoFocus
            maxLength={60}
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            onBlur={() => {
              const next = renameName.trim();

              setRenameName(null);

              if (next.length > 0 && next !== draft.name)
                editor.dispatch(
                  updateMachineOperation("Rename machine", (current: EditorDraft) => ({
                    ...current,
                    name: next,
                  })),
                );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();

              if (event.key === "Escape") setRenameName(null);
            }}
          />
        )
      }
      titleExtra={
        <span className="stm-row stm-row--tight">
          <Pill tone="info" icon="Edit">
            Draft
          </Pill>
          <span className="stm-text-sm stm-text-muted">
            {editor.baseVersionNumber === null
              ? "Not published yet"
              : `Based on v${editor.baseVersionNumber}`}
          </span>
          <span className="stm-text-sm stm-text-muted" aria-hidden="true">
            ·
          </span>
          <span className={`stm-save stm-save--${editor.saveStatus}`} role="status">
            {SAVE_LABEL[editor.saveStatus]}
          </span>
        </span>
      }
      actions={
        <>
          {editor.problems.length > 0 ? (
            <Button
              icon="AlertCircle"
              onClick={() => {
                select(null);
                setInfoOpen(true);
              }}
            >
              {editor.problems.length} problem{editor.problems.length === 1 ? "" : "s"}
              {errorCount > 0 ? <Chip tone="danger">{errorCount} blocking</Chip> : null}
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon="ArrowUpRight"
            disabled={errorCount > 0 || editor.saveStatus === "conflict"}
            disabledReason={
              errorCount > 0
                ? "Fix the errors in the problem list first."
                : "Resolve the save conflict first."
            }
            onClick={() => setPublishOpen(true)}
          >
            Publish…
          </Button>
        </>
      }
      tabs={<MachineTabs machineId={initial.machineId} active="draft" />}
      banner={
        <>
          {published === null ? null : (
            <Alert
              tone="info"
              actions={
                <Button onClick={() => go({ screen: "machine", machineId: initial.machineId })}>
                  Go to overview
                </Button>
              }
            >
              Published v{published}. Start an instance from the overview.
            </Alert>
          )}
          {editor.saveStatus === "conflict" ? (
            <Alert
              tone="warning"
              title="This draft was changed somewhere else."
              actions={
                <>
                  <Button
                    variant="primary"
                    onClick={() =>
                      void editor.reapplyMine().then((failed) => {
                        if (failed.length > 0) setReapplyFailed(failed);
                      })
                    }
                  >
                    Reapply my changes
                  </Button>
                  <Button onClick={() => setConfirmLoadLatest(true)}>Load latest</Button>
                </>
              }
            />
          ) : null}
          {editor.saveStatus === "failed" ? (
            <Alert tone="danger" title="Changes aren't saved yet. Keep this page open." />
          ) : null}
          {editor.saveStatus === "rejected" && editor.saveError !== null ? (
            <ErrorAlert
              error={editor.saveError}
              onRetry={() => void editor.flush()}
              subject="draft"
            />
          ) : null}
          {reapplyFailed === null ? null : (
            <Alert
              tone="warning"
              title="Some changes couldn't be reapplied."
              actions={<Button onClick={() => setReapplyFailed(null)}>Done</Button>}
            >
              <ul className="stm-list">
                {reapplyFailed.map((label, index) => (
                  <li key={`${label}:${index}`}>Couldn't reapply: {label}</li>
                ))}
              </ul>
            </Alert>
          )}
        </>
      }
    >
      <div className="stm-workspace">
        <div className="stm-workspace-main">
          <div className="stm-row stm-view-switch-row">
            <div className="stm-toggle-group stm-view-switch" role="group" aria-label="View">
              <button
                type="button"
                className="stm-toggle"
                aria-pressed={view === "graph"}
                onClick={() => setView("graph")}
              >
                Graph
              </button>
              <button
                type="button"
                className="stm-toggle"
                aria-pressed={view === "outline"}
                onClick={() => setView("outline")}
              >
                Outline
              </button>
            </div>
            <button
              type="button"
              className="stm-toggle stm-details-toggle"
              aria-pressed={panelOpen}
              onClick={() => (panelOpen ? closePanel() : setInfoOpen(true))}
            >
              Draft details
            </button>
          </div>
          {view === "graph" ? (
            <Canvas
              definition={draft}
              mode={compact ? "readonly" : "edit"}
              label={draft.name}
              selection={selection}
              onSelect={select}
              problems={problemMarks}
              multiSelection={multi}
              onMultiSelectionChange={setMulti}
              occludeRight={panelOpen && !compact}
              edit={{
                onMove: (positions) => editor.dispatch(moveStatesOperation(positions)),
                onConnect: (from, to) => addTransition(from, to),
                onDelete: requestDelete,
                onAddState: (kind, at) => addState(kind, at),
                onDuplicate: (id) =>
                  editor.dispatch(
                    duplicateStateOperation(id, (copy) =>
                      window.setTimeout(() => select({ kind: "state", id: copy }), 0),
                    ),
                  ),
                onRename: (id) => {
                  select({ kind: "state", id });
                  window.setTimeout(() => titleInput.current?.focus(), 50);
                },
                onUndo: editor.undo,
                onRedo: editor.redo,
              }}
            />
          ) : (
            <Outline
              definition={draft}
              label={draft.name}
              selection={selection}
              onSelect={select}
              onAddState={(kind) => addState(kind, null)}
              onAddTransition={(from) => addTransition(from, null)}
            />
          )}
        </div>
        {compact ? (
          <Sheet open={panelOpen} onOpenChange={(open) => !open && closePanel()} label="Inspector">
            {inspector}
          </Sheet>
        ) : panelOpen ? (
          <FloatingPanel label="Inspector" onClose={closePanel}>
            {inspector}
          </FloatingPanel>
        ) : null}
      </div>
      {publishOpen ? (
        <PublishDialog
          machineId={initial.machineId}
          flush={editor.flush}
          getRevision={editor.getRevision}
          externalWriteSteps={externalWriteSteps}
          onClose={() => setPublishOpen(false)}
          onPublished={(number) => {
            setPublishOpen(false);
            setPublished(number);
            announce(`Published v${number}.`);
            void editor.loadLatest();
          }}
        />
      ) : null}
      <Dialog
        open={confirmLoadLatest}
        onOpenChange={setConfirmLoadLatest}
        title="Load the latest draft?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLoadLatest(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmLoadLatest(false);
                void editor.loadLatest();
              }}
            >
              Discard my unsaved changes
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">
          Your {editor.state.pending.length} unsaved change
          {editor.state.pending.length === 1 ? "" : "s"} will be discarded.
        </p>
      </Dialog>
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={
          confirmDelete === null
            ? ""
            : `Delete ${confirmDelete.ids.length === 1 ? (stateTitles.get(confirmDelete.ids[0] ?? "") ?? "state") : `${confirmDelete.ids.length} states`} and ${confirmDelete.transitions} transitions?`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDelete !== null)
                  editor.dispatch(deleteStatesOperation(confirmDelete.ids));

                setConfirmDelete(null);
                select(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="stm-text-sm">You can undo this.</p>
      </Dialog>
    </Page>
  );
}

function InspectorBody({
  editor,
  draft,
  selection,
  projectId,
  environments,
  stateTitles,
  publishedOnce,
  onSelect,
  onAddTransition,
  onDelete,
  titleRef,
}: {
  editor: DraftEditorController;
  draft: EditorDraft;
  selection: Selection;
  projectId: string | null;
  environments: ReturnType<typeof useEnvironments>["data"];
  stateTitles: ReadonlyMap<string, string>;
  publishedOnce: boolean;
  onSelect(selection: Selection): void;
  onAddTransition(from: string): void;
  onDelete(selection: Exclude<Selection, null>, extra: readonly string[]): void;
  titleRef(element: HTMLInputElement | null): void;
}) {
  if (selection?.kind === "state") {
    const index = draft.states.findIndex((state) => state.id === selection.id);
    const state = draft.states[index];

    if (state === undefined) return null;

    return (
      <>
        <StateInspector
          state={state}
          stateIndex={index}
          editable
          published={publishedOnce}
          isInitial={draft.initialStateId === state.id}
          problems={editor.problems}
          outgoing={draft.transitions.filter((edge) => edge.from === state.id)}
          incoming={draft.transitions.filter((edge) => edge.to === state.id)}
          edgeLabels={draft.layout.edgeLabels}
          stateTitles={stateTitles}
          contextSchema={draft.contextSchema}
          environments={environments}
          projectId={projectId}
          standingAuthority={null}
          dispatch={editor.dispatch}
          onSelectTransition={(id) => onSelect({ kind: "transition", id })}
          onAddTransition={() => onAddTransition(state.id)}
          onReorder={(id, direction) => editor.dispatch(reorderTransitionOperation(id, direction))}
          titleRef={titleRef}
        />
        <div className="stm-inspector-footer">
          <Button
            variant="destructive"
            icon="Trash2"
            onClick={() => onDelete({ kind: "state", id: state.id }, [])}
          >
            Delete state
          </Button>
        </div>
      </>
    );
  }

  if (selection?.kind === "transition") {
    const index = draft.transitions.findIndex((edge) => edge.id === selection.id);
    const edge = draft.transitions[index];

    if (edge === undefined) return null;

    return (
      <TransitionInspector
        edge={edge}
        index={index}
        states={draft.states}
        editable
        problems={editor.problems}
        edgeLabels={draft.layout.edgeLabels}
        hasCustomRoute={draft.layout.edges[edge.id] !== undefined}
        contextSchema={draft.contextSchema}
        dispatch={editor.dispatch}
        onDelete={() => onDelete({ kind: "transition", id: edge.id }, [])}
        onSelectState={(id) => onSelect({ kind: "state", id })}
      />
    );
  }

  return (
    <>
      <DraftOverview
        draft={draft}
        problems={editor.problems}
        changeSummary={editor.serverView.changeSummary}
        baseVersion={editor.baseVersionNumber}
        onSelect={onSelect}
      />
      <ContextEditor draft={draft} editable dispatch={editor.dispatch} />
    </>
  );
}
