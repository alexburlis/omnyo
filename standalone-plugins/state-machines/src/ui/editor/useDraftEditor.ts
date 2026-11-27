import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { compileDraft } from "../../definition/draft.js";
import {
  errorFromCatch,
  newRequestId,
  type SmError,
  TRANSPORT_ERROR,
  useSmClient,
} from "../data/client.js";
import type { DraftView, EditorDraft, Problem } from "../data/contract.js";
import { useQueryStore } from "../data/query.js";
import {
  applyOperation,
  createEditorState,
  type EditOperation,
  type EditorState,
  markSaved,
  reapply,
  redo,
  undo,
} from "../graph/edit-model.js";

export type SaveStatus = "saved" | "saving" | "retrying" | "failed" | "rejected" | "conflict";

export interface DraftEditorController {
  state: EditorState;
  revision: number;
  baseVersionNumber: number | null;
  saveStatus: SaveStatus;
  saveError: SmError | null;
  problems: Problem[];
  serverView: DraftView;
  dispatch(operation: EditOperation): void;
  undo(): void;
  redo(): void;
  reapplyMine(): Promise<string[]>;
  loadLatest(): Promise<void>;
  flush(): Promise<boolean>;
  getRevision(): number;
}

const DEBOUNCE_MS = 600;

function toProblem(
  problem: { code: string; path: string; message: string; severity: "error" | "warning" | "info" },
  draft: EditorDraft,
): Problem {
  const stateMatch = /^\/states\/(\d+)/.exec(problem.path);
  const transitionMatch = /^\/transitions\/(\d+)/.exec(problem.path);
  const state = stateMatch?.[1] === undefined ? undefined : draft.states[Number(stateMatch[1])];

  const edge =
    transitionMatch?.[1] === undefined ? undefined : draft.transitions[Number(transitionMatch[1])];

  return {
    code: problem.code,
    path: problem.path,
    message: problem.message,
    severity: problem.severity,
    stateId: state?.id ?? null,
    transitionId: edge?.id ?? null,
  };
}

export function localProblems(draft: EditorDraft): Problem[] {
  return compileDraft(draft).problems.map((problem) => toProblem(problem, draft));
}

export function useDraftEditor(initial: DraftView): DraftEditorController {
  const client = useSmClient();
  const store = useQueryStore();
  const [state, setState] = useState(() => createEditorState(initial.document));
  const [serverView, setServerView] = useState(initial);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<SmError | null>(null);
  const stateRef = useRef(state);
  const revisionRef = useRef(initial.draftRevision);
  const inflight = useRef<Promise<boolean> | null>(null);

  const requestRef = useRef<{
    id: string;
    count: number;
    document: EditorDraft;
    expectedRevision: number;
  } | null>(null);

  const failures = useRef(0);
  const timer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const conflictRef = useRef(false);

  stateRef.current = state;

  const save = useCallback(async (): Promise<boolean> => {
    if (inflight.current !== null) return inflight.current;

    if (conflictRef.current) return false;

    const snapshot = stateRef.current;

    const request =
      requestRef.current ??
      (snapshot.pending.length === 0
        ? null
        : {
            id: newRequestId(),
            count: snapshot.pending.length,
            document: snapshot.draft,
            expectedRevision: revisionRef.current,
          });

    if (request === null) return true;

    requestRef.current = request;
    setSaveStatus("saving");

    const run = (async () => {
      try {
        const view = await client.call("sm_machine_draft_save", {
          machineId: initial.machineId,
          expectedRevision: request.expectedRevision,
          document: request.document,
          requestId: request.id,
        });

        revisionRef.current = view.draftRevision;
        requestRef.current = null;
        failures.current = 0;
        setServerView(view);
        setSaveError(null);
        setState((current) => markSaved(current, view.document, request.count));
        setSaveStatus(stateRef.current.pending.length > request.count ? "saving" : "saved");
        store.set(`draft:${initial.machineId}`, view);

        return true;
      } catch (caught) {
        const failure = errorFromCatch(caught instanceof Error ? caught : null);

        setSaveError(failure);

        if (failure.code !== TRANSPORT_ERROR) {
          requestRef.current = null;
          failures.current = 0;

          if (failure.code === "REVISION_CONFLICT") {
            conflictRef.current = true;
            setSaveStatus("conflict");
          } else {
            setSaveStatus("rejected");
          }

          return false;
        }

        failures.current += 1;
        setSaveStatus(failures.current >= 3 ? "failed" : "retrying");

        const delay = Math.min(30_000, 1000 * 2 ** (failures.current - 1));

        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          void saveRef.current();
        }, delay);

        return false;
      } finally {
        inflight.current = null;
      }
    })();

    inflight.current = run;

    return run;
  }, [client, initial.machineId, store]);

  const saveRef = useRef(save);

  saveRef.current = save;

  useEffect(() => {
    if (state.pending.length === 0 || conflictRef.current || requestRef.current !== null) return;

    if (timer.current !== null) window.clearTimeout(timer.current);

    timer.current = window.setTimeout(() => void saveRef.current(), DEBOUNCE_MS);

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [state]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (stateRef.current.pending.length > 0) event.preventDefault();
    };

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);

    if (inflight.current !== null) await inflight.current;

    return save();
  }, [save]);

  const dispatch = useCallback((operation: EditOperation) => {
    setState((current) => applyOperation(current, operation));
  }, []);

  const reapplyMine = useCallback(async () => {
    const latest = await client.call("sm_machine_draft_get", { machineId: initial.machineId });
    const result = reapply(latest.document, stateRef.current.pending);

    revisionRef.current = latest.draftRevision;
    conflictRef.current = false;
    requestRef.current = null;
    setServerView(latest);
    setSaveError(null);
    setState({ draft: result.draft, undo: [], redo: [], pending: result.applied });
    setSaveStatus(result.applied.length > 0 ? "saving" : "saved");

    return result.failed.map((operation) => operation.label);
  }, [client, initial.machineId]);

  const loadLatest = useCallback(async () => {
    const latest = await client.call("sm_machine_draft_get", { machineId: initial.machineId });

    revisionRef.current = latest.draftRevision;
    conflictRef.current = false;
    requestRef.current = null;
    setServerView(latest);
    setSaveError(null);
    setState(createEditorState(latest.document));
    setSaveStatus("saved");
    store.set(`draft:${initial.machineId}`, latest);
  }, [client, initial.machineId, store]);

  const getRevision = useCallback(() => revisionRef.current, []);

  const problems = useMemo(() => localProblems(state.draft), [state.draft]);

  return {
    state,
    revision: revisionRef.current,
    baseVersionNumber: serverView.baseVersionNumber,
    saveStatus,
    saveError,
    problems,
    serverView,
    dispatch,
    undo: () => setState((current) => undo(current)),
    redo: () => setState((current) => redo(current)),
    reapplyMine,
    loadLatest,
    flush,
    getRevision,
  };
}
