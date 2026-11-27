import type {
  DraftState,
  DraftTransition,
  EditorGuard,
  JsonValue,
  Path,
  StateKind,
  Trigger,
} from "../data/contract.js";

export const STATE_KINDS: readonly StateKind[] = [
  "agent",
  "command",
  "wait",
  "choice",
  "manual",
  "end",
];

export const KIND_LABEL: Record<StateKind, string> = {
  wait: "Wait",
  choice: "Choice",
  agent: "Agent",
  command: "Command",
  manual: "Manual",
  end: "End",
};

export const KIND_ICON: Record<StateKind, string> = {
  wait: "Clock",
  choice: "GitBranch",
  agent: "Bot",
  command: "Terminal",
  manual: "UserRound",
  end: "CircleCheck",
};

export const KIND_SHORTCUT: Record<StateKind, string> = {
  agent: "a",
  command: "c",
  wait: "w",
  choice: "h",
  manual: "m",
  end: "e",
};

export function triggerLabel(trigger: Trigger): string {
  switch (trigger.kind) {
    case "event":
      return trigger.eventType;
    case "timer":
      return "check";
    case "always":
      return "always";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "no-result":
      return "no result";
    case "budget-exhausted":
      return "budget exhausted";
    case "result":
      return trigger.outcome;
    case "decision":
      return trigger.decisionId;
  }
}

export function triggerValue(trigger: Trigger): string {
  if (trigger.kind === "event") return `event:${trigger.eventType}`;

  if (trigger.kind === "result") return `result:${trigger.outcome}`;

  if (trigger.kind === "decision") return `decision:${trigger.decisionId}`;

  return trigger.kind;
}

export function parseTriggerValue(value: string): Trigger | null {
  const [head, rest] = value.split(":", 2);

  if (head === "event" && rest !== undefined && rest.length > 0)
    return { kind: "event", eventType: rest };

  if (head === "result" && rest !== undefined && rest.length > 0)
    return { kind: "result", outcome: rest };

  if (head === "decision" && rest !== undefined && rest.length > 0)
    return { kind: "decision", decisionId: rest };

  switch (value) {
    case "timer":
    case "always":
    case "succeeded":
    case "failed":
    case "timed-out":
    case "cancelled":
    case "no-result":
    case "budget-exhausted":
      return { kind: value };
    default:
      return null;
  }
}

export function triggerOptions(state: DraftState): { value: string; label: string }[] {
  const base = (kinds: readonly Trigger["kind"][]) =>
    kinds.flatMap((kind) => {
      const trigger = parseTriggerValue(kind);

      return trigger === null ? [] : [{ value: kind, label: triggerLabel(trigger) }];
    });

  switch (state.kind) {
    case "agent":
      return [
        ...state.action.result.outcomes.map((outcome) => ({
          value: `result:${outcome.name}`,
          label: `result: ${outcome.name}`,
        })),
        ...base(["no-result", "failed", "timed-out", "cancelled", "budget-exhausted"]),
      ];
    case "command":
      return base(["succeeded", "failed", "timed-out", "cancelled"]);
    case "wait":
      return state.triggers.flatMap((trigger) =>
        trigger.kind === "event"
          ? [{ value: `event:${trigger.eventType}`, label: trigger.eventType }]
          : [{ value: "timer", label: "check" }],
      );
    case "manual":
      return state.decisions.map((decision) => ({
        value: `decision:${decision.id}`,
        label: decision.label,
      }));
    case "choice":
      return base(["always"]);
    case "end":
      return [];
  }
}

function pathLabel(path: Path): string {
  return [path.root, ...path.segments].join(".");
}

function valueLabel(value: JsonValue | undefined): string {
  if (value === undefined) return "…";

  return JSON.stringify(value);
}

const OPERATOR_SYMBOL = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" } as const;

export function guardSummary(guard: EditorGuard | null): string {
  if (guard === null) return "";

  if ("all" in guard) return guard.all.map((child) => wrap(child)).join(" and ");

  if ("any" in guard) return guard.any.map((child) => wrap(child)).join(" or ");

  if ("not" in guard) return `not ${wrap(guard.not)}`;

  if ("exists" in guard) return `${pathLabel(guard.exists)} exists`;

  if ("in" in guard)
    return `${pathLabel(guard.in[0])} in ${guard.in[1] === undefined ? "…" : JSON.stringify(guard.in[1])}`;

  if ("eq" in guard)
    return `${pathLabel(guard.eq[0])} ${OPERATOR_SYMBOL.eq} ${valueLabel(guard.eq[1])}`;

  if ("ne" in guard)
    return `${pathLabel(guard.ne[0])} ${OPERATOR_SYMBOL.ne} ${valueLabel(guard.ne[1])}`;

  if ("lt" in guard)
    return `${pathLabel(guard.lt[0])} ${OPERATOR_SYMBOL.lt} ${valueLabel(guard.lt[1])}`;

  if ("lte" in guard)
    return `${pathLabel(guard.lte[0])} ${OPERATOR_SYMBOL.lte} ${valueLabel(guard.lte[1])}`;

  if ("gt" in guard)
    return `${pathLabel(guard.gt[0])} ${OPERATOR_SYMBOL.gt} ${valueLabel(guard.gt[1])}`;

  return `${pathLabel(guard.gte[0])} ${OPERATOR_SYMBOL.gte} ${valueLabel(guard.gte[1])}`;
}

function wrap(guard: EditorGuard): string {
  const text = guardSummary(guard);

  return "all" in guard || "any" in guard ? `(${text})` : text;
}

export function edgeLabel(
  edge: Pick<DraftTransition, "id" | "trigger" | "guard">,
  labels: Readonly<Record<string, string>>,
): string {
  const base = labels[edge.id] ?? triggerLabel(edge.trigger);
  const guard = guardSummary(edge.guard);

  return guard.length > 0 ? `${base} · ${guard}` : base;
}

export function stateSubtitle(state: DraftState): string {
  if (state.kind === "end") return state.outcome === "success" ? "end" : "end · failure";

  if (state.subtitle.trim().length > 0) return state.subtitle;

  switch (state.kind) {
    case "command": {
      const text = state.action.argv
        .map((part) => ("literal" in part ? part.literal : `{${part.contextPath}}`))
        .join(" ");

      return text.length > 0 ? text : "no command";
    }

    case "agent":
      return state.action.execution?.model ?? "model not chosen";
    case "wait": {
      const first = state.triggers[0];

      if (first === undefined) return "no trigger";

      return first.kind === "event"
        ? `until ${first.eventType}`
        : `every ${Math.round(first.everyMs / 60_000)}m`;
    }

    case "choice":
      return "choose by guard";
    case "manual":
      return "manual";
  }
}
