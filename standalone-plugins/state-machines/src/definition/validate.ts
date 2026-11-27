import { sentryWorkflowOutcomes } from "../contracts/sentry-workflow.js";
import {
  type ContextSchema,
  type GuardExpression,
  type MachineDefinition,
  type Path,
  type StateDefinition,
  type TransitionDefinition,
  type ValueSchema,
  isBoundedJson,
  machineDefinitionSchema,
} from "../contracts/definition.js";
import { triggerKey } from "../contracts/events.js";
import { parseContextPath, schemaAtPath, validateValue } from "./values.js";

export interface DefinitionProblem {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface DefinitionValidation {
  valid: boolean;
  definition: MachineDefinition | null;
  problems: DefinitionProblem[];
}

const pointer = (path: readonly PropertyKey[]): string =>
  `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

function inspectSchema(
  schema: ValueSchema,
  path: string,
  add: (code: string, path: string, message: string) => void,
): void {
  if (schema.type === "object") {
    if (
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((key) => !Object.hasOwn(schema.properties, key))
    )
      add("invalid-schema", path, "Required fields must be unique declared properties");

    for (const [key, child] of Object.entries(schema.properties))
      inspectSchema(child, `${path}/properties/${key}`, add);
  } else if (schema.type === "array") inspectSchema(schema.items, `${path}/items`, add);
  else if (schema.type === "string" && (schema.minLength ?? 0) > (schema.maxLength ?? Infinity))
    add("invalid-schema", path, "Minimum length exceeds maximum length");
  else if (
    (schema.type === "number" || schema.type === "integer") &&
    (schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)
  )
    add("invalid-schema", path, "Minimum exceeds maximum");
}

function inspectGuard(
  guard: GuardExpression,
  path: string,
  context: ContextSchema,
  add: (code: string, path: string, message: string) => void,
  depth = 1,
  counter = { nodes: 0 },
): void {
  if (++counter.nodes > 256 || depth > 16) {
    add("guard-limit", path, "Guards permit depth 16 and 256 nodes");

    return;
  }

  if ("all" in guard || "any" in guard) {
    const key = "all" in guard ? "all" : "any";
    const children = "all" in guard ? guard.all : "any" in guard ? guard.any : [];
    children.forEach((child, i) =>
      inspectGuard(child, `${path}/${key}/${i}`, context, add, depth + 1, counter),
    );
  } else if ("not" in guard)
    inspectGuard(guard.not, `${path}/not`, context, add, depth + 1, counter);
  else {
    const source: Path =
      "exists" in guard
        ? guard.exists
        : "eq" in guard
          ? guard.eq[0]
          : "ne" in guard
            ? guard.ne[0]
            : "lt" in guard
              ? guard.lt[0]
              : "lte" in guard
                ? guard.lte[0]
                : "gt" in guard
                  ? guard.gt[0]
                  : "gte" in guard
                    ? guard.gte[0]
                    : guard.in[0];

    if (source.root === "context" && !schemaAtPath(context, source.segments))
      add("unknown-context-path", path, "Guard references an undeclared context path");
  }
}

function cyclicComponents(states: StateDefinition[], edges: TransitionDefinition[]): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];

  const targets = new Map(
    states.map((state) => [
      state.id,
      edges.flatMap((edge) => (edge.from === state.id ? [edge.to] : [])),
    ]),
  );

  const visit = (id: string): void => {
    indices.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    active.add(id);

    for (const target of targets.get(id) ?? []) {
      if (!targets.has(target)) continue;

      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }

    if (low.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string;

    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== id);

    if (component.length > 1 || (targets.get(id) ?? []).includes(id)) components.push(component);
  };

  states.forEach((state) => {
    if (!indices.has(state.id)) visit(state.id);
  });

  return components;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Imported definition JSON is validated before becoming executable.
export function validateDefinition(input: unknown): DefinitionValidation {
  const problems: DefinitionProblem[] = [];

  const add = (
    code: string,
    path: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void => {
    problems.push({ code, path, message, severity });
  };

  if (!isBoundedJson(input, 262144, 64))
    return {
      valid: false,
      definition: null,
      problems: [
        {
          code: "definition-limit",
          path: "/",
          message: "Definition must be safe JSON, at most 256 KiB and 64 levels",
          severity: "error",
        },
      ],
    };
  const parsed = machineDefinitionSchema.safeParse(input);

  if (!parsed.success)
    return {
      valid: false,
      definition: null,
      problems: parsed.error.issues.map((issue) => ({
        code: issue.path[0] === "schemaVersion" ? "unsupported-schema" : "invalid-field",
        path: pointer(issue.path),
        message: issue.message,
        severity: "error",
      })),
    };
  const definition = parsed.data;
  const stateIds = new Set<string>();
  const edgeIds = new Set<string>();
  definition.states.forEach((state, i) => {
    if (stateIds.has(state.id))
      add("duplicate-state", `/states/${i}/id`, "State IDs must be unique");
    stateIds.add(state.id);
  });

  if (!stateIds.has(definition.initialStateId))
    add("no-initial", "/initialStateId", "Initial state does not exist");
  inspectSchema(definition.contextSchema, "/contextSchema", add);

  for (const issue of validateValue(
    definition.contextSchema,
    definition.initialContext,
    "/initialContext",
  ))
    add("invalid-context", issue.path, issue.message);
  const priorities = new Set<string>();
  definition.transitions.forEach((edge, i) => {
    const at = `/transitions/${i}`;

    if (edgeIds.has(edge.id))
      add("duplicate-transition", `${at}/id`, "Transition IDs must be unique");
    edgeIds.add(edge.id);

    if (!stateIds.has(edge.from))
      add("dangling-transition", `${at}/from`, "Source state does not exist");

    if (!stateIds.has(edge.to))
      add("dangling-transition", `${at}/to`, "Target state does not exist");
    const key = `${edge.from}:${triggerKey(edge.trigger)}:${edge.priority}`;

    if (priorities.has(key))
      add(
        "ambiguous-priority",
        `${at}/priority`,
        "Competing transitions require distinct priorities",
      );
    priorities.add(key);

    if (edge.guard) inspectGuard(edge.guard, `${at}/guard`, definition.contextSchema, add);
    edge.contextPatch.forEach((patch, j) => {
      if (!schemaAtPath(definition.contextSchema, patch.path, true))
        add(
          "unwritable-path",
          `${at}/contextPatch/${j}/path`,
          "Patch path must be declared writable context",
        );
    });
  });
  definition.states.forEach((state, i) => {
    const at = `/states/${i}`;
    const outgoing = definition.transitions.filter((edge) => edge.from === state.id);
    const integrationOutcomes = sentryWorkflowOutcomes(state);

    const hasRoute = (kind: string): boolean =>
      outgoing.some((edge) => triggerKey(edge.trigger) === kind && edge.guard === null);

    if (state.kind === "end" && outgoing.length)
      add("end-has-edges", at, "End states cannot have outgoing transitions");

    if (state.kind === "choice") {
      if (!hasRoute("always"))
        add("choice-no-default", at, "Choice needs an unconditional default route");

      const defaultEdge = outgoing
        .filter((edge) => edge.trigger.kind === "always" && edge.guard === null)
        .sort((a, b) => a.priority - b.priority)[0];

      if (defaultEdge && outgoing.some((edge) => edge.priority > defaultEdge.priority))
        add("choice-default-order", at, "The default must have the last priority");
    }

    if (state.kind === "agent" || state.kind === "command") {
      for (const kind of ["failed", "timed-out"])
        if (!hasRoute(kind))
          add("missing-outcome-route", at, `Action needs an unconditional ${kind} route`);

      if (state.kind === "command") {
        if (integrationOutcomes) {
          for (const outcome of integrationOutcomes)
            if (
              !outgoing.some(
                (edge) => edge.trigger.kind === "result" && edge.trigger.outcome === outcome,
              )
            )
              add("missing-outcome-route", at, `Sentry workflow needs a route for ${outcome}`);
        } else if (!hasRoute("succeeded"))
          add("missing-outcome-route", at, "Command needs an unconditional success route");
        const first = state.action.argv[0];

        if (!first || !("literal" in first) || !first.literal.trim())
          add("missing-command", `${at}/action/argv`, "Program must be a nonempty literal");

        if (
          state.action.cwd.startsWith("/") ||
          /^[a-zA-Z]:/.test(state.action.cwd) ||
          state.action.cwd.split(/[\\/]/).includes("..")
        )
          add(
            "invalid-cwd",
            `${at}/action/cwd`,
            "Working directory must stay relative to the bound workspace",
          );
        state.action.argv.forEach((arg, j) => {
          if ("contextPath" in arg) {
            try {
              const schema = schemaAtPath(
                definition.contextSchema,
                parseContextPath(arg.contextPath),
              );

              if (!schema || !["string", "number", "integer", "boolean"].includes(schema.type))
                add(
                  "invalid-argv-path",
                  `${at}/action/argv/${j}`,
                  "An argv argument must reference a declared scalar",
                );
            } catch {
              add("invalid-argv-path", `${at}/action/argv/${j}`, "Invalid context path");
            }
          } else if (arg.literal.includes("\0"))
            add("invalid-argv", `${at}/action/argv/${j}`, "Arguments cannot contain NUL");
        });

        if (state.maxAttempts > 1 && state.action.retrySafety === "never")
          add(
            "unsafe-retry",
            `${at}/maxAttempts`,
            "Unverified commands cannot retry automatically",
          );
      } else {
        const outcomes = new Set<string>();
        state.action.result.outcomes.forEach((outcome, j) => {
          if (outcomes.has(outcome.name))
            add(
              "duplicate-outcome",
              `${at}/action/result/outcomes/${j}`,
              "Result outcomes must be unique",
            );
          outcomes.add(outcome.name);

          if (!hasRoute(`result:${outcome.name}`))
            add("missing-outcome-route", at, `Agent needs a route for ${outcome.name}`);
          const fields = new Set<string>();
          outcome.fields.forEach((field, k) => {
            if (fields.has(field.name))
              add(
                "duplicate-result-field",
                `${at}/action/result/outcomes/${j}/fields/${k}`,
                "Result fields must be unique",
              );
            fields.add(field.name);
            inspectSchema(
              field.schema,
              `${at}/action/result/outcomes/${j}/fields/${k}/schema`,
              add,
            );
          });
        });

        if (!hasRoute("no-result"))
          add("missing-outcome-route", at, "Agent needs an unconditional no-result route");

        if (
          outgoing.some((edge) => edge.trigger.kind === "budget-exhausted") &&
          !hasRoute("budget-exhausted")
        )
          add(
            "missing-outcome-route",
            at,
            "A bounded repair profile needs an unconditional budget-exhausted route",
          );
      }
    }

    if (state.kind === "manual") {
      const decisions = new Set<string>();
      state.decisions.forEach((decision, j) => {
        if (decisions.has(decision.id))
          add("duplicate-decision", `${at}/decisions/${j}`, "Decision IDs must be unique");
        decisions.add(decision.id);

        if (!hasRoute(`decision:${decision.id}`))
          add(
            "missing-decision-route",
            `${at}/decisions/${j}`,
            "Decision needs an unconditional route",
          );
      });
    }

    for (const edge of outgoing) {
      const trigger = edge.trigger;
      const key = triggerKey(edge.trigger);

      const permitted =
        state.kind === "end"
          ? false
          : state.kind === "choice"
            ? trigger.kind === "always"
            : state.kind === "wait"
              ? trigger.kind === "timer"
                ? state.triggers.some((item) => item.kind === "check")
                : trigger.kind === "event" &&
                  state.triggers.some(
                    (item) => item.kind === "event" && item.eventType === trigger.eventType,
                  )
              : state.kind === "manual"
                ? trigger.kind === "decision" &&
                  state.decisions.some((decision) => decision.id === trigger.decisionId)
                : state.kind === "command"
                  ? integrationOutcomes
                    ? [
                        "failed",
                        "timed-out",
                        "cancelled",
                        "no-result",
                        "budget-exhausted",
                      ].includes(key) ||
                      (trigger.kind === "result" && integrationOutcomes.includes(trigger.outcome))
                    : ["succeeded", "failed", "timed-out", "cancelled"].includes(key)
                  : ["failed", "timed-out", "cancelled", "no-result", "budget-exhausted"].includes(
                      key,
                    ) ||
                    (trigger.kind === "result" &&
                      state.action.result.outcomes.some(
                        (outcome) => outcome.name === trigger.outcome,
                      ));

      if (!permitted)
        add(
          "invalid-trigger",
          `/transitions/${definition.transitions.indexOf(edge)}/trigger`,
          "Trigger is not available in the source state",
        );
    }
  });

  for (const component of cyclicComponents(definition.states, definition.transitions))
    if (
      component.every((id) => definition.states.find((state) => state.id === id)?.kind === "choice")
    )
      add(
        "non-yielding-cycle",
        "/transitions",
        `Cycle has no wait or finite action: ${component.join(", ")}`,
      );
  const reachable = new Set([definition.initialStateId]);

  for (let changed = true; changed;) {
    changed = false;

    for (const edge of definition.transitions)
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
  }

  definition.states.forEach((state, i) => {
    if (!reachable.has(state.id))
      add(
        "unreachable-state",
        `/states/${i}`,
        "State is unreachable from the initial state",
        "warning",
      );
  });

  for (const id of Object.keys(definition.layout.nodes))
    if (!stateIds.has(id))
      add("unknown-layout-state", `/layout/nodes/${id}`, "Layout state does not exist");

  for (const id of [
    ...Object.keys(definition.layout.edges),
    ...Object.keys(definition.layout.edgeLabels),
  ])
    if (!edgeIds.has(id))
      add("unknown-layout-transition", `/layout/edges/${id}`, "Layout transition does not exist");

  return { valid: !problems.some((problem) => problem.severity === "error"), definition, problems };
}

export class DefinitionValidationError extends Error {
  override name = "DefinitionValidationError";
  constructor(readonly problems: DefinitionProblem[]) {
    super(
      problems
        .flatMap((problem) =>
          problem.severity === "error" ? [`${problem.path}: ${problem.message}`] : [],
        )
        .join("; "),
    );
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Published execution requires parsing arbitrary import JSON.
export function parseDefinition(input: unknown): MachineDefinition {
  const result = validateDefinition(input);

  if (!result.valid || !result.definition) throw new DefinitionValidationError(result.problems);

  return result.definition;
}
