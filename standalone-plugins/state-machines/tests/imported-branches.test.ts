import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { ImportedWorkflowService, type WorkflowTextRunner } from "../src/imported/service.js";
import {
  importedFlowSchema,
  validateImportedFlow,
  type ImportedFlow,
} from "../src/imported/contracts.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const flow = {
  kind: "graph",
  engine: "restricted",
  startStepId: "draft",
  steps: [
    { id: "draft", kind: "model", prompt: "initial", nextStepId: "validate" },
    {
      id: "validate",
      kind: "validate-text",
      maxBytes: 4,
      nextStepId: "choose",
      failureStepId: "shorten",
    },
    {
      id: "choose",
      kind: "decision",
      operand: "equals",
      value: "OK",
      nextStepId: "accept",
      otherwiseStepId: "revise",
    },
    { id: "accept", kind: "model", prompt: "accepted", nextStepId: "export" },
    { id: "revise", kind: "model", prompt: "revised", nextStepId: "export" },
    { id: "shorten", kind: "model", prompt: "shortened", nextStepId: "export" },
    { id: "export", kind: "export" },
  ],
};

function setup(
  runner: WorkflowTextRunner,
  specification: ImportedFlow = importedFlowSchema.parse(flow),
) {
  const db = new Database(":memory:");
  databases.push(db);
  const service = new ImportedWorkflowService(db, runner);

  const graph = service.import({
    projectId: "project",
    importId: "branch",
    packageDigest: "a".repeat(64),
    executionDigest: "b".repeat(64),
    flow: specification,
    assets: { skills: [], inputs: {} },
  });

  service.admit({
    projectId: "project",
    importId: "branch",
    graphId: graph.graphId,
    graphVersion: 1,
    executionDigest: graph.executionDigest,
    occurrenceKey: "manual",
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets: { skills: [], inputs: {} },
  });

  return { db, service };
}

const lookup = { projectId: "project", importId: "branch", occurrenceKey: "manual" };

test.each([
  ["OK", "accepted"],
  ["NO", "revised"],
  ["ééé", "shortened"],
])("text %s selects %s using UTF-8 size and exact decision", async (initial, selected) => {
  const calls: string[] = [];

  const { service } = setup({
    async run(input) {
      calls.push(input.prompt);

      return input.prompt === "initial" ? initial : input.prompt;
    },
  });

  const done = await service.execute(lookup, new AbortController().signal);
  expect(done.status).toBe("complete");
  expect(done.outputs).toEqual([initial, selected]);
  expect(calls).toEqual(["initial", selected]);
});

test("restart replays recorded text branches without another initial model call", async () => {
  const calls: string[] = [];
  const abort = new AbortController();

  const runner: WorkflowTextRunner = {
    async run(input) {
      calls.push(input.prompt);

      if (input.prompt === "initial") abort.abort();

      return input.prompt === "initial" ? "OK" : input.prompt;
    },
  };

  const { service, db } = setup(runner);
  await expect(service.execute(lookup, abort.signal)).rejects.toThrow();
  const resumed = new ImportedWorkflowService(db, runner);
  expect((await resumed.execute(lookup, new AbortController().signal)).outputs).toEqual([
    "OK",
    "accepted",
  ]);
  expect(calls).toEqual(["initial", "accepted"]);
});

test("every reachable branch must be acyclic, have prior text and end in export", () => {
  const invalid = [
    {
      ...flow,
      steps: flow.steps.map((step) =>
        step.id === "shorten" ? { ...step, nextStepId: "validate" } : step,
      ),
    },
    { ...flow, startStepId: "validate", steps: flow.steps.filter((step) => step.id !== "draft") },
    { ...flow, steps: flow.steps.filter((step) => step.id !== "export") },
    { ...flow, steps: [...flow.steps, { id: "orphan", kind: "export" }] },
  ];

  for (const candidate of invalid)
    expect(() => validateImportedFlow(importedFlowSchema.parse(candidate))).toThrow();
});

test("contains decisions inspect literal text only", async () => {
  const parsed = importedFlowSchema.parse(flow);

  if (parsed.kind !== "graph" || parsed.engine !== "restricted") throw new Error("fixture");

  const modified: ImportedFlow = {
    ...parsed,
    steps: parsed.steps.map((step) =>
      step.kind === "decision" ? { ...step, operand: "contains", value: "K" } : step,
    ),
  };

  validateImportedFlow(modified);

  const { service } = setup(
    {
      async run(input) {
        return input.prompt === "initial" ? "OK" : input.prompt;
      },
    },
    modified,
  );

  expect((await service.execute(lookup, new AbortController().signal)).outputs).toEqual([
    "OK",
    "accepted",
  ]);
});

test("edited recorded output cannot redirect a resumed branch", async () => {
  const abort = new AbortController();
  let calls = 0;

  const runner: WorkflowTextRunner = {
    async run() {
      calls++;
      abort.abort();

      return "OK";
    },
  };

  const { service, db } = setup(runner);
  await expect(service.execute(lookup, abort.signal)).rejects.toThrow();
  db.prepare("UPDATE sm_imported_runs SET document=json_set(document,'$.outputs[0]','NO')").run();
  await expect(
    new ImportedWorkflowService(db, runner).execute(lookup, new AbortController().signal),
  ).rejects.toThrow("integrity");
  expect(calls).toBe(1);
});

test("an empty reconciled text is a valid value for deterministic branching", async () => {
  let calls = 0;

  const runner: WorkflowTextRunner = {
    async run(input) {
      calls++;

      if (input.prompt === "initial") throw new Error("lost");

      return input.prompt;
    },
  };

  const { service } = setup(runner);
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow("lost");
  const requestId = service.lookup(lookup)!.run!.pending!.requestId;
  service.reconcileRun({ ...lookup, requestId, response: "" });
  expect((await service.execute(lookup, new AbortController().signal)).outputs).toEqual([
    "",
    "revised",
  ]);
  expect(calls).toBe(2);
});
