import { describe, expect, it } from "vitest";
import {
  type AgentState,
  type ContextSchema,
  type GuardExpression,
  type JsonValue,
  type MachineDefinition,
  type TransitionDefinition,
  jsonObjectSchema,
  jsonValueSchema,
} from "../src/contracts/definition.js";
import { parseActionResult } from "../src/contracts/result.js";
import {
  applyContextPatch,
  canonicalJson,
  compileDraft,
  createEmptyDraft,
  evaluateGuard,
  parseDefinition,
  parseDraft,
  selectTransition,
  validateDefinition,
} from "../src/definition/index.js";
import { semanticHash, snapshotHash } from "../src/definition/hash.js";
import { createLocalCheckLoop, createReleaseLoopDraft } from "../templates/index.js";
import { agentGraph } from "./runtime-fixtures.js";

const local = (): MachineDefinition =>
  createLocalCheckLoop({ machineId: "mch_local", environmentId: "env_test" });

const contextSchema: ContextSchema = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    label: { type: "string" },
    locked: { type: "string", readOnly: true },
    maybe: { type: "null" },
  },
  required: ["count", "label", "locked"],
  additionalProperties: false,
};

const agent = (): AgentState => ({
  kind: "agent",
  id: "repair",
  title: "Repair",
  subtitle: "bounded repair",
  deadlineMs: 1800000,
  maxAttempts: 1,
  effect: "local-edit",
  effectTarget: "env_test",
  annotations: { category: "repository" },
  action: {
    prompt: "Repair and submit a result.",
    environmentId: "env_test",
    execution: { providerId: "codex", model: "gpt-6", reasoningLevel: "high" },
    permissionMode: "accept-edits",
    result: {
      outcomes: [
        {
          name: "repaired",
          fields: [{ name: "head", schema: { type: "string", minLength: 3 }, required: true }],
        },
      ],
    },
  },
});

describe("definition publication boundary", () => {
  it("keeps named integration outcomes unavailable to ordinary commands", () => {
    const definition = local();
    definition.transitions = definition.transitions.map((edge) =>
      edge.trigger.kind === "succeeded"
        ? { ...edge, trigger: { kind: "result", outcome: "published" } }
        : edge,
    );
    const codes = validateDefinition(definition).problems.map((problem) => problem.code);
    expect(codes).toContain("invalid-trigger");
    expect(codes).toContain("missing-outcome-route");
  });

  it("rejects unknown execution fields and shell injection modes instead of ignoring them", () => {
    const definition = local();
    const command = definition.states.find((state) => state.kind === "command")!;
    expect(
      validateDefinition({
        ...definition,
        states: definition.states.map((state) =>
          state.id === command.id
            ? { ...state, action: { ...command.action, shell: true, unsupported: "ignored?" } }
            : state,
        ),
      }).valid,
    ).toBe(false);
    expect(validateDefinition({ ...definition, extraPolicy: "ignored?" }).valid).toBe(false);
  });

  it.each(["failed", "timed-out"])("requires an explicit %s route for finite actions", (kind) => {
    const definition = local();
    definition.transitions = definition.transitions.filter((edge) => edge.trigger.kind !== kind);
    definition.layout.edgeLabels = {};
    expect(validateDefinition(definition).problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-outcome-route", path: "/states/1" }),
      ]),
    );
  });

  it("rejects duplicate priorities, invalid targets, and end-state dispatch", () => {
    const definition = local();
    definition.transitions.push({
      ...definition.transitions[0]!,
      id: "tr_competes",
      to: "missing",
    });
    definition.states.push({
      kind: "end",
      id: "done",
      title: "Done",
      outcome: "success",
      reason: "Finished",
    });
    definition.transitions.push({ ...definition.transitions[0]!, id: "tr_end", from: "done" });
    const result = validateDefinition(definition);
    expect(result.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["ambiguous-priority", "dangling-transition", "end-has-edges"]),
    );
  });

  it("rejects a non-yielding self-cycle but accepts a durable loop", () => {
    const definition = local();
    definition.states = [{ id: "spin", kind: "choice", title: "Spin", subtitle: "" }];
    definition.initialStateId = "spin";
    definition.transitions = [
      {
        id: "tr_spin",
        from: "spin",
        to: "spin",
        trigger: { kind: "always" },
        guard: null,
        contextPatch: [],
        priority: 0,
      },
    ];
    definition.layout = { initial: { x: 0, y: 0 }, nodes: {}, edges: {}, edgeLabels: {} };
    expect(validateDefinition(definition).problems.map((problem) => problem.code)).toContain(
      "non-yielding-cycle",
    );
    expect(validateDefinition(local()).valid).toBe(true);
  });

  it("rejects oversized, non-JSON, unsafe-key and deeply recursive imports before compiling", () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(jsonValueSchema.safeParse(unsafe).success).toBe(false);
    expect(jsonObjectSchema.safeParse(unsafe).success).toBe(false);

    interface RecursiveTestInput {
      next?: RecursiveTestInput;
    }

    const circular: RecursiveTestInput = {};
    circular.next = circular;

    for (const input of [
      unsafe,
      circular,
      { ...local(), description: "a".repeat(262145) },
      { ...local(), initialContext: { value: Infinity } },
    ])
      expect(validateDefinition(input).valid).toBe(false);
    let value: JsonValue = null;

    for (let i = 0; i < 70; i++) value = { value };
    expect(validateDefinition(value).problems[0]!.code).toBe("definition-limit");
    expect(() => parseDefinition({ ...local(), schemaVersion: 2 })).toThrow();
  });

  it("rejects guard complexity and undeclared writable paths at publish", () => {
    const definition = local();
    let guard: GuardExpression = { exists: { root: "context", segments: ["notDeclared"] } };

    for (let i = 0; i < 18; i++) guard = { not: guard };
    definition.transitions[0]!.guard = guard;
    definition.transitions[0]!.contextPatch = [{ op: "set", path: ["authority"], value: true }];
    const codes = validateDefinition(definition).problems.map((problem) => problem.code);
    expect(codes).toContain("guard-limit");
    expect(codes).toContain("unwritable-path");
  });

  it("does not permit automatic retries based on an unverified author assertion", () => {
    const definition = local();
    const command = definition.states.find((state) => state.kind === "command")!;
    command.maxAttempts = 2;
    expect(validateDefinition(definition).problems.map((problem) => problem.code)).toContain(
      "unsafe-retry",
    );
  });

  it("requires structured outcome routing for agents instead of a command success edge", () => {
    const definition = local();
    definition.states = definition.states.map((state) =>
      state.id === "check" ? { ...agent(), id: "check" } : state,
    );
    definition.transitions.push({
      id: "tr_missing_result",
      from: "check",
      to: "needs-person",
      trigger: { kind: "no-result" },
      guard: null,
      contextPatch: [],
      priority: 5,
    });
    const codes = validateDefinition(definition).problems.map((problem) => problem.code);
    expect(codes).toContain("missing-outcome-route");
    expect(codes).toContain("invalid-trigger");
    definition.transitions = definition.transitions.map((edge) =>
      edge.from === "check" && edge.trigger.kind === "succeeded"
        ? { ...edge, trigger: { kind: "result", outcome: "repaired" } }
        : edge,
    );
    expect(validateDefinition(definition).valid).toBe(true);
  });
});

describe("deterministic reduction", () => {
  it("selects by explicit priority and consumes one eligible edge without mutating the definition", () => {
    const definition = local();
    definition.contextSchema = contextSchema;
    definition.initialContext = { count: 3, label: "before", locked: "owner" };

    const preferred: TransitionDefinition = {
      ...definition.transitions[1]!,
      id: "tr_preferred",
      priority: 0,
      to: "needs-person",
      guard: { gte: [{ root: "context", segments: ["count"] }, 2] },
    };

    definition.transitions.push(preferred);
    const snapshot = canonicalJson(definition);
    const event = { type: "check.requested", payload: {} };
    expect(selectTransition(definition, "waiting", event, definition.initialContext)?.id).toBe(
      "tr_preferred",
    );
    expect(
      selectTransition(definition, "waiting", event, { ...definition.initialContext, count: 0 })
        ?.id,
    ).toBe("tr_check_signal");
    expect(
      selectTransition(
        definition,
        "waiting",
        { type: "unsubscribed", payload: {} },
        definition.initialContext,
      ),
    ).toBeNull();
    expect(canonicalJson(definition)).toBe(snapshot);
  });

  it("distinguishes missing from null and fails invalid comparisons visibly", () => {
    const scope = { context: { maybe: null } };
    expect(evaluateGuard({ exists: { root: "context", segments: ["missing"] } }, scope)).toBe(
      false,
    );
    expect(evaluateGuard({ eq: [{ root: "context", segments: ["maybe"] }, null] }, scope)).toBe(
      true,
    );
    expect(() =>
      evaluateGuard({ eq: [{ root: "context", segments: ["missing"] }, null] }, scope),
    ).toThrow("missing");
    expect(() =>
      evaluateGuard(
        { lt: [{ root: "event", segments: ["number"] }, "2"] },
        { context: {}, event: { number: 2 } },
      ),
    ).toThrow("matching numbers or strings");
    expect(
      evaluateGuard(
        {
          all: [
            { not: { exists: { root: "context", segments: ["missing"] } } },
            { any: [{ in: [{ root: "context", segments: ["maybe"] }, [null]] }] },
          ],
        },
        scope,
      ),
    ).toBe(true);
  });

  it("commits valid typed patches together and preserves input after invalid or read-only patches", () => {
    const context = { count: 1, label: "before", locked: "owner" };
    const scope = { context, event: { label: "after" } };
    expect(
      applyContextPatch(
        context,
        [
          { op: "set", path: ["count"], value: 2 },
          { op: "set", path: ["label"], value: { root: "event", segments: ["label"] } },
        ],
        scope,
        contextSchema,
      ),
    ).toEqual({ count: 2, label: "after", locked: "owner" });
    expect(() =>
      applyContextPatch(context, [{ op: "set", path: ["count"], value: -1 }], scope, contextSchema),
    ).toThrow("minimum");
    expect(() =>
      applyContextPatch(context, [{ op: "remove", path: ["label"] }], scope, contextSchema),
    ).toThrow("Required");
    expect(() =>
      applyContextPatch(
        context,
        [{ op: "set", path: ["locked"], value: "someone else" }],
        scope,
        contextSchema,
      ),
    ).toThrow("read only");
    expect(context).toEqual({ count: 1, label: "before", locked: "owner" });

    const nestedSchema: ContextSchema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { owner: { type: "string", readOnly: true }, label: { type: "string" } },
          required: ["owner", "label"],
          additionalProperties: false,
        },
      },
      required: ["settings"],
      additionalProperties: false,
    };

    const nested = { settings: { owner: "original", label: "before" } };
    expect(() =>
      applyContextPatch(
        nested,
        [{ op: "set", path: ["settings"], value: { owner: "forged", label: "after" } }],
        { context: nested },
        nestedSchema,
      ),
    ).toThrow("read only descendant");
    expect(
      applyContextPatch(
        nested,
        [{ op: "set", path: ["settings"], value: { owner: "original", label: "after" } }],
        { context: nested },
        nestedSchema,
      ),
    ).toEqual({ settings: { owner: "original", label: "after" } });
  });

  it("rejects missing, undeclared and invalid agent result fields before success", () => {
    const state = agent();
    expect(parseActionResult(state, { outcome: "repaired", payload: { head: "abc123" } })).toEqual({
      outcome: "repaired",
      payload: { head: "abc123" },
    });

    for (const input of [
      { outcome: "invented", payload: { head: "abc123" } },
      { outcome: "repaired", payload: {} },
      { outcome: "repaired", payload: { head: 3 } },
      { outcome: "repaired", payload: { head: "abc123", approved: true } },
      { outcome: "repaired", payload: { head: "a".repeat(17000) } },
    ])
      expect(() => parseActionResult(state, input)).toThrow();
  });

  it("keeps semantic identity stable across layout and label edits but binds executable changes", () => {
    const first = local();
    const moved = structuredClone(first);
    moved.layout.nodes.waiting = { x: 1000, y: 1000 };
    moved.name = "Another label";
    moved.states[0]!.title = "A new title";
    expect(semanticHash(moved)).toBe(semanticHash(first));
    expect(snapshotHash(moved)).not.toBe(snapshotHash(first));
    const command = moved.states.find((state) => state.kind === "command")!;
    command.action.argv.push({ literal: "different" });
    expect(semanticHash(moved)).not.toBe(semanticHash(first));
    expect(canonicalJson({ z: 1, a: { d: false, c: null } })).toBe(
      '{"a":{"c":null,"d":false},"z":1}',
    );
  });
});

describe("drafts and usable templates", () => {
  it("keeps incomplete fields in a draft and reports exactly one publish problem per field", () => {
    const draft = createReleaseLoopDraft({ machineId: "mch_release" });
    expect(parseDraft(draft)).toEqual(draft);
    const result = compileDraft(draft);
    expect(result.valid).toBe(false);
    expect(
      result.problems.filter((problem) => problem.path === "/states/3/action/execution"),
    ).toEqual([expect.objectContaining({ code: "missing-model" })]);
    expect(
      result.problems.filter((problem) => problem.path.startsWith("/states/2/action/argv")),
    ).toEqual([expect.objectContaining({ code: "missing-command" })]);
    expect(result.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["missing-environment", "missing-command"]),
    );
    expect(
      compileDraft(createEmptyDraft({ machineId: "mch_empty", name: "Empty" })).problems,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "no-initial" })]));

    const incomplete = createReleaseLoopDraft({ machineId: "mch_incomplete" });
    incomplete.transitions[0]!.guard = { eq: [{ root: "context", segments: ["sourceSha"] }] };

    const missingValue = compileDraft(incomplete).problems.filter((problem) =>
      problem.path.startsWith("/transitions/0/guard"),
    );

    expect(missingValue).toEqual([expect.objectContaining({ code: "guard-incomplete" })]);
  });

  it.each([null, undefined])(
    "defaults a draft permission of %s when compiling for publication",
    (permissionMode) => {
      const definition = agentGraph(local());

      const draft = {
        ...definition,
        states: definition.states.map((state) =>
          state.kind === "agent"
            ? { ...state, action: { ...state.action, permissionMode } }
            : state,
        ),
      };

      const result = compileDraft(JSON.parse(JSON.stringify(draft)));
      expect(result.valid).toBe(true);
      expect(
        result.definition?.states.find((state) => state.kind === "agent")?.action.permissionMode,
      ).toBe("full");
    },
  );

  it("publishes the configured release graph without treating operator intent as external authority", () => {
    const draft = createReleaseLoopDraft({ machineId: "mch_release", environmentId: "env_test" });

    for (const state of draft.states) {
      if (state.kind === "agent") {
        state.action.execution = { providerId: "codex", model: "gpt-6", reasoningLevel: "high" };
        state.action.permissionMode = "accept-edits";
      }

      if (state.kind === "command" && !state.action.argv.length)
        state.action.argv = [{ literal: "configured-existing-adapter" }];
    }

    const definition = parseDefinition(draft);
    expect(
      selectTransition(
        definition,
        "waiting",
        { type: "person.promote", payload: {} },
        definition.initialContext,
      )?.to,
    ).toBe("production-promotion");
    expect(definition.states.find((state) => state.id === "production-promotion")?.kind).toBe(
      "manual",
    );
    expect(definition.limits.repairAttemptsPerSubject).toBe(2);
    expect(
      selectTransition(
        definition,
        "fixer-agent",
        { type: "result", outcome: "pr-opened", payload: { prNumber: 3, headSha: "a".repeat(40) } },
        definition.initialContext,
      )?.to,
    ).toBe("land-fix");
  });
});
