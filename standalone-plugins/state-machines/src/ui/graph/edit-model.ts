import { DEFAULT_AGENT_PERMISSION_MODE } from "../../definition/draft.js";
import type { DraftState, DraftTransition, EditorDraft, StateKind } from "../data/contract.js";
import { autoPosition, type Point, snap } from "./geometry.js";

export interface EditOperation {
  label: string;
  apply(draft: EditorDraft): EditorDraft;
}

export class EditConflictError extends Error {
  override name = "EditConflictError";
}

export interface EditorState {
  draft: EditorDraft;
  undo: EditorDraft[];
  redo: EditorDraft[];
  pending: EditOperation[];
}

const HISTORY_LIMIT = 100;

export function createEditorState(draft: EditorDraft): EditorState {
  return { draft, undo: [], redo: [], pending: [] };
}

export function applyOperation(state: EditorState, operation: EditOperation): EditorState {
  const next = operation.apply(state.draft);

  if (next === state.draft) return state;

  return {
    draft: next,
    undo: [...state.undo.slice(-(HISTORY_LIMIT - 1)), state.draft],
    redo: [],
    pending: [...state.pending, operation],
  };
}

export function undo(state: EditorState): EditorState {
  const previous = state.undo.at(-1);

  if (previous === undefined) return state;

  const label = `Undo ${state.pending.at(-1)?.label ?? "change"}`;
  const snapshot = previous;

  return {
    draft: previous,
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, state.draft],
    pending: [...state.pending, { label, apply: () => snapshot }],
  };
}

export function redo(state: EditorState): EditorState {
  const next = state.redo.at(-1);

  if (next === undefined) return state;

  const snapshot = next;

  return {
    draft: next,
    undo: [...state.undo, state.draft],
    redo: state.redo.slice(0, -1),
    pending: [...state.pending, { label: "Redo change", apply: () => snapshot }],
  };
}

export function markSaved(
  state: EditorState,
  saved: EditorDraft,
  savedOperations: number,
): EditorState {
  const remaining = state.pending.slice(savedOperations);
  let draft = saved;

  for (const operation of remaining) draft = operation.apply(draft);

  return { ...state, draft, pending: remaining };
}

export interface ReapplyResult {
  draft: EditorDraft;
  applied: EditOperation[];
  failed: EditOperation[];
}

export function reapply(latest: EditorDraft, operations: readonly EditOperation[]): ReapplyResult {
  let draft = latest;
  const applied: EditOperation[] = [];
  const failed: EditOperation[] = [];

  for (const operation of operations) {
    if (operation.label.startsWith("Undo ") || operation.label === "Redo change") {
      failed.push(operation);
      continue;
    }

    try {
      draft = operation.apply(draft);
      applied.push(operation);
    } catch (caught) {
      if (caught instanceof EditConflictError) failed.push(operation);
      else throw caught;
    }
  }

  return { draft, applied, failed };
}

function requireState(draft: EditorDraft, id: string): DraftState {
  const state = draft.states.find((candidate) => candidate.id === id);

  if (state === undefined) throw new EditConflictError(`State ${id} no longer exists`);

  return state;
}

function requireTransition(draft: EditorDraft, id: string): DraftTransition {
  const transition = draft.transitions.find((candidate) => candidate.id === id);

  if (transition === undefined) throw new EditConflictError(`Transition ${id} no longer exists`);

  return transition;
}

export function uniqueStateId(draft: EditorDraft, base: string): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40) || "state";

  const taken = new Set(draft.states.map((state) => state.id));

  if (!taken.has(slug)) return slug;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${slug}-${index}`;

    if (!taken.has(candidate)) return candidate;
  }

  return `${slug}-${Date.now().toString(36)}`;
}

export function newTransitionId(): string {
  return `tr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

const KIND_TITLES: Record<StateKind, string> = {
  wait: "Wait",
  choice: "Choice",
  agent: "Agent step",
  command: "Command step",
  manual: "Needs a person",
  end: "End",
};

const ACTION_DEFAULTS = {
  maxAttempts: 3,
  effect: "local-read",
  effectTarget: "workspace",
  annotations: { category: null },
} as const;

export function blankState(kind: StateKind, id: string, title: string): DraftState {
  switch (kind) {
    case "wait":
      return { kind, id, title, subtitle: "", triggers: [] };
    case "choice":
      return { kind, id, title, subtitle: "" };
    case "agent":
      return {
        kind,
        id,
        title,
        subtitle: "",
        ...ACTION_DEFAULTS,
        annotations: { category: null },
        effect: "local-edit",
        deadlineMs: 30 * 60_000,
        action: {
          prompt: null,
          execution: null,
          permissionMode: DEFAULT_AGENT_PERMISSION_MODE,
          environmentId: null,
          result: { outcomes: [] },
        },
      };
    case "command":
      return {
        kind,
        id,
        title,
        subtitle: "",
        ...ACTION_DEFAULTS,
        annotations: { category: null },
        deadlineMs: 10 * 60_000,
        action: {
          argv: [],
          shell: false,
          cwd: "",
          environmentId: null,
          successExitCodes: [0],
          retrySafety: "never",
        },
      };
    case "manual":
      return {
        kind,
        id,
        title,
        subtitle: "manual",
        prompt: "Choose how to continue.",
        decisions: [],
      };
    case "end":
      return { kind, id, title, outcome: "success", reason: "" };
  }
}

export function addStateOperation(
  kind: StateKind,
  position: Point | null,
  created: (id: string) => void,
): EditOperation {
  return {
    label: `Add ${KIND_TITLES[kind].toLowerCase()}`,
    apply(draft) {
      const title = KIND_TITLES[kind];
      const id = uniqueStateId(draft, title);
      const at = position ?? autoPosition(draft.states.length);

      created(id);

      return {
        ...draft,
        initialStateId: draft.initialStateId ?? id,
        states: [...draft.states, blankState(kind, id, title)],
        layout: {
          ...draft.layout,
          nodes: { ...draft.layout.nodes, [id]: { x: snap(at.x), y: snap(at.y) } },
        },
      };
    },
  };
}

export function updateStateOperation(
  id: string,
  label: string,
  update: (state: DraftState) => DraftState,
): EditOperation {
  return {
    label,
    apply(draft) {
      const current = requireState(draft, id);
      const next = update(current);

      if (next === current) return draft;

      return { ...draft, states: draft.states.map((state) => (state.id === id ? next : state)) };
    },
  };
}

export function renameStateIdOperation(from: string, to: string): EditOperation {
  return {
    label: `Rename state id to ${to}`,
    apply(draft) {
      requireState(draft, from);

      if (from === to) return draft;

      if (draft.states.some((state) => state.id === to))
        throw new EditConflictError(`State id ${to} is already used`);

      const nodes = { ...draft.layout.nodes };
      const position = nodes[from];

      delete nodes[from];

      if (position !== undefined) nodes[to] = position;

      return {
        ...draft,
        initialStateId: draft.initialStateId === from ? to : draft.initialStateId,
        states: draft.states.map((state) => (state.id === from ? { ...state, id: to } : state)),
        transitions: draft.transitions.map((edge) => ({
          ...edge,
          from: edge.from === from ? to : edge.from,
          to: edge.to === from ? to : edge.to,
        })),
        layout: { ...draft.layout, nodes },
      };
    },
  };
}

export function moveStatesOperation(positions: ReadonlyMap<string, Point>): EditOperation {
  const snapshot = new Map(positions);

  return {
    label: snapshot.size === 1 ? "Move state" : `Move ${snapshot.size} states`,
    apply(draft) {
      const nodes = { ...draft.layout.nodes };
      let changed = false;

      for (const [id, point] of snapshot) {
        requireState(draft, id);

        const next = { x: snap(point.x), y: snap(point.y) };
        const current = nodes[id];

        if (current?.x === next.x && current.y === next.y) continue;

        nodes[id] = next;
        changed = true;
      }

      return changed ? { ...draft, layout: { ...draft.layout, nodes } } : draft;
    },
  };
}

export function deleteStatesOperation(ids: readonly string[]): EditOperation {
  const doomed = new Set(ids);

  return {
    label: ids.length === 1 ? "Delete state" : `Delete ${ids.length} states`,
    apply(draft) {
      for (const id of doomed) requireState(draft, id);

      const nodes = { ...draft.layout.nodes };
      const edges = { ...draft.layout.edges };
      const edgeLabels = { ...draft.layout.edgeLabels };

      const transitions = draft.transitions.filter((edge) => {
        const remove = doomed.has(edge.from) || (edge.to !== null && doomed.has(edge.to));

        if (remove) {
          delete edges[edge.id];
          delete edgeLabels[edge.id];
        }

        return !remove;
      });

      for (const id of doomed) delete nodes[id];

      const states = draft.states.filter((state) => !doomed.has(state.id));

      return {
        ...draft,
        initialStateId:
          draft.initialStateId !== null && doomed.has(draft.initialStateId)
            ? null
            : draft.initialStateId,
        states,
        transitions,
        layout: { ...draft.layout, nodes, edges, edgeLabels },
      };
    },
  };
}

export function duplicateStateOperation(id: string, created: (id: string) => void): EditOperation {
  return {
    label: "Duplicate state",
    apply(draft) {
      const source = requireState(draft, id);
      const copyId = uniqueStateId(draft, source.id);
      const position = draft.layout.nodes[id] ?? autoPosition(draft.states.length);

      created(copyId);

      return {
        ...draft,
        states: [
          ...draft.states,
          { ...structuredClone(source), id: copyId, title: `${source.title} copy` },
        ],
        layout: {
          ...draft.layout,
          nodes: { ...draft.layout.nodes, [copyId]: { x: position.x + 24, y: position.y + 24 } },
        },
      };
    },
  };
}

export function defaultTrigger(source: DraftState): DraftTransition["trigger"] {
  switch (source.kind) {
    case "agent": {
      const outcome = source.action.result.outcomes[0];

      return outcome === undefined
        ? { kind: "no-result" }
        : { kind: "result", outcome: outcome.name };
    }

    case "command":
      return { kind: "succeeded" };
    case "wait": {
      const trigger = source.triggers[0];

      if (trigger?.kind === "event") return { kind: "event", eventType: trigger.eventType };

      return { kind: "timer" };
    }

    case "manual": {
      const decision = source.decisions[0];

      return decision === undefined
        ? { kind: "always" }
        : { kind: "decision", decisionId: decision.id };
    }

    case "choice":
    case "end":
      return { kind: "always" };
  }
}

export function nextPriority(draft: EditorDraft, from: string): number {
  const used = draft.transitions.filter((edge) => edge.from === from).map((edge) => edge.priority);

  return used.length === 0 ? 0 : Math.min(10000, Math.max(...used) + 10);
}

export function addTransitionOperation(
  from: string,
  to: string | null,
  created: (id: string) => void,
): EditOperation {
  return {
    label: "Add transition",
    apply(draft) {
      const source = requireState(draft, from);

      if (to !== null) requireState(draft, to);

      const id = newTransitionId();

      created(id);

      return {
        ...draft,
        transitions: [
          ...draft.transitions,
          {
            id,
            from,
            to,
            trigger: defaultTrigger(source),
            guard: null,
            contextPatch: [],
            priority: nextPriority(draft, from),
          },
        ],
      };
    },
  };
}

export function updateTransitionOperation(
  id: string,
  label: string,
  update: (edge: DraftTransition) => DraftTransition,
): EditOperation {
  return {
    label,
    apply(draft) {
      const current = requireTransition(draft, id);
      const next = update(current);

      if (next === current) return draft;

      if (next.from !== current.from) requireState(draft, next.from);

      if (next.to !== null && next.to !== current.to) requireState(draft, next.to);

      return {
        ...draft,
        transitions: draft.transitions.map((edge) => (edge.id === id ? next : edge)),
      };
    },
  };
}

export function reorderTransitionOperation(id: string, direction: -1 | 1): EditOperation {
  return {
    label: direction < 0 ? "Move transition up" : "Move transition down",
    apply(draft) {
      const current = requireTransition(draft, id);

      const siblings = draft.transitions
        .filter((edge) => edge.from === current.from)
        .sort((a, b) => a.priority - b.priority);

      const index = siblings.findIndex((edge) => edge.id === id);
      const swap = siblings[index + direction];

      if (swap === undefined) return draft;

      const reordered = [...siblings];

      reordered[index] = swap;
      reordered[index + direction] = current;

      const priorities = new Map(reordered.map((edge, order) => [edge.id, order * 10]));

      return {
        ...draft,
        transitions: draft.transitions.map((edge) => {
          const priority = priorities.get(edge.id);

          return priority === undefined ? edge : { ...edge, priority };
        }),
      };
    },
  };
}

export function deleteTransitionsOperation(ids: readonly string[]): EditOperation {
  const doomed = new Set(ids);

  return {
    label: ids.length === 1 ? "Delete transition" : `Delete ${ids.length} transitions`,
    apply(draft) {
      for (const id of doomed) requireTransition(draft, id);

      const edges = { ...draft.layout.edges };
      const edgeLabels = { ...draft.layout.edgeLabels };

      for (const id of doomed) {
        delete edges[id];
        delete edgeLabels[id];
      }

      return {
        ...draft,
        transitions: draft.transitions.filter((edge) => !doomed.has(edge.id)),
        layout: { ...draft.layout, edges, edgeLabels },
      };
    },
  };
}

export function setInitialOperation(id: string): EditOperation {
  return {
    label: "Set initial state",
    apply(draft) {
      requireState(draft, id);

      return draft.initialStateId === id ? draft : { ...draft, initialStateId: id };
    },
  };
}

export function setEdgeLabelOperation(id: string, label: string): EditOperation {
  return {
    label: "Edit transition label",
    apply(draft) {
      requireTransition(draft, id);

      const edgeLabels = { ...draft.layout.edgeLabels };

      if (label.trim().length === 0) delete edgeLabels[id];
      else edgeLabels[id] = label;

      return { ...draft, layout: { ...draft.layout, edgeLabels } };
    },
  };
}

export function resetEdgeRouteOperation(id: string): EditOperation {
  return {
    label: "Reset route",
    apply(draft) {
      requireTransition(draft, id);

      if (draft.layout.edges[id] === undefined) return draft;

      const edges = { ...draft.layout.edges };

      delete edges[id];

      return { ...draft, layout: { ...draft.layout, edges } };
    },
  };
}

export function updateMachineOperation(
  label: string,
  update: (draft: EditorDraft) => EditorDraft,
): EditOperation {
  return { label, apply: update };
}
