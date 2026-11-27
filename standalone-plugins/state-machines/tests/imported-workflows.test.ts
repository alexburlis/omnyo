import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createImportedTextRunner } from "../src/imported/provider.js";
import {
  ImportedWorkflowService,
  contentDigest,
  type WorkflowTextRunner,
} from "../src/imported/service.js";
import { importedWorkflowHandlers } from "../src/imported/rpc.js";
import { assetsSchema, importedFlowSchema } from "../src/imported/contracts.js";
import { weeklyContentFeed, fictionalStartup } from "../templates/weekly-content-feed.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(runner: WorkflowTextRunner) {
  const db = new Database(":memory:");
  databases.push(db);

  return { db, service: new ImportedWorkflowService(db, runner) };
}

const input = {
  projectId: "project",
  importId: "import",
  packageDigest: "a".repeat(64),
  executionDigest: "b".repeat(64),
  flow: weeklyContentFeed,
  assets: { skills: [{ id: "weekly", text: "Use supplied evidence." }], inputs: fictionalStartup },
};

function admit(
  service: ImportedWorkflowService,
  binding = { hostId: "host", providerId: "codex", model: "fixture" },
  assets: Parameters<ImportedWorkflowService["admit"]>[0]["assets"] = input.assets,
) {
  const graph = service.import(input);

  return service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: graph.graphVersion,
    executionDigest: input.executionDigest,
    occurrenceKey: "week:2026-11-23",
    bindingRevision: 1,
    binding,
    assets,
  });
}

const lookup = { projectId: "project", importId: "import", occurrenceKey: "week:2026-11-23" };

function model(): WorkflowTextRunner & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    async run(request) {
      calls.push(request.requestId);
      const candidateId = String(request.assets.inputs.candidateId);
      const draft = request.assets.inputs.draft;

      if (draft)
        return JSON.stringify({
          candidateId,
          draftDigest: contentDigest(draft),
          outcome: candidateId === "candidate-3" ? "rejected" : "accepted",
          reason: "Fixture review",
        });

      return JSON.stringify({
        candidateId,
        canonicalTopic: candidateId,
        title: "Seed swapping",
        body: "Record seed names and planned swap dates.",
        sources: [],
      });
    },
  };
}

test("imports are inert, idempotent, separately identified and immutable", () => {
  const runner = model();
  const { service } = setup(runner);
  const first = service.import(input);
  expect(service.import(input)).toEqual(first);
  expect(first.origin).toBe("imported");
  expect(runner.calls).toHaveLength(0);
  expect(() => service.import({ ...input, flow: { kind: "prompt", prompt: "changed" } })).toThrow(
    "conflict",
  );
  const other = service.import({ ...input, importId: "second" });
  expect(other.graphId).not.toBe(first.graphId);
});

test("trusted RPC refuses ordinary callers and unsafe graph nodes", async () => {
  const { service } = setup(model());
  const handlers = importedWorkflowHandlers(service);
  expect(() =>
    handlers.sm_workflow_import(input, {
      experimental_caller: { kind: "client" },
      experimental_signal: new AbortController().signal,
    }),
  ).toThrow("coordinator");
  expect(() =>
    importedFlowSchema.parse({
      kind: "graph",
      engine: "restricted",
      startStepId: "shell",
      steps: [{ id: "shell", kind: "command", argv: ["touch", "/tmp/canary"] }],
    }),
  ).toThrow();
  expect(
    handlers.sm_workflow_import(input, {
      experimental_caller: { kind: "plugin", pluginId: "automations" },
      experimental_signal: new AbortController().signal,
    }),
  ).toBeDefined();
});

test("two-item checkpoint resumes after restart, replaces rejected candidate and closes exactly seven dates", async () => {
  const runner = model();
  const abort = new AbortController();
  const original = runner.run.bind(runner);
  runner.run = async (request) => {
    const output = await original(request);

    if (runner.calls.length === 4) abort.abort();

    return output;
  };

  const { service, db } = setup(runner);
  const first = admit(service);
  expect(admit(service).runId).toBe(first.runId);
  await expect(service.execute(lookup, abort.signal)).rejects.toThrow();
  expect(service.lookup(lookup)?.run?.accepted).toHaveLength(2);
  const restored = new ImportedWorkflowService(db, runner);
  const done = await restored.execute(lookup, new AbortController().signal);
  expect(done.status).toBe("complete");
  expect(done.accepted).toHaveLength(7);
  expect(done.cursor).toBe(8);
  expect(new Set(done.accepted.map((item) => item.date)).size).toBe(7);
  expect(done.accepted.every((item) => item.digest === item.review.draftDigest)).toBe(true);
  const count = runner.calls.length;
  await restored.execute(lookup, new AbortController().signal);
  expect(runner.calls).toHaveLength(count);
  expect(new Set(runner.calls).size).toBe(count);

  if (process.env.OMNYO_WORKFLOW_EVIDENCE === "1") {
    process.stdout.write(
      `${JSON.stringify({ proof: "fictional-weekly-recovery", runId: done.runId, graphId: done.graphId, graphVersion: done.graphVersion, occurrenceKey: done.occurrenceKey, initialAccepted: 2, accepted: done.accepted.map((item) => ({ candidateId: item.draft.candidateId, draftDigest: item.digest, reviewDigest: contentDigest(item.review), reviewedDraftDigest: item.review.draftDigest, date: item.date })), candidateCount: done.cursor, modelStubCalls: count, distinctRequestIds: new Set(runner.calls).size, manifestDigest: restored.export(lookup).manifestDigest })}\n`,
    );
  }
});

test("lost response preserves pending request and refuses blind replay", async () => {
  let calls = 0;

  const { db, service } = setup({
    async run() {
      calls++;
      throw new Error("lost response");
    },
  });

  admit(service);
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow(
    "lost response",
  );

  const restored = new ImportedWorkflowService(db, {
    async run() {
      calls++;

      return "{}";
    },
  });

  await expect(restored.execute(lookup, new AbortController().signal)).rejects.toThrow(
    "reconciled",
  );
  expect(calls).toBe(1);
});

test("stored unsafe changes are rejected before dispatch", async () => {
  const runner = model();
  const { service, db } = setup(runner);
  admit(service);
  db.prepare(
    "UPDATE sm_imported_graphs SET document=json_set(document,'$.flow.kind','command')",
  ).run();
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow();
  expect(runner.calls).toHaveLength(0);
});

test("revision CAS preserves old admission, origin and completed receipts", async () => {
  const runner = model();
  const { service } = setup(runner);
  const run = admit(service);
  const graph = service.lookup(lookup)!.graph;

  const update = {
    ...input,
    graphId: graph.graphId,
    expectedGraphVersion: 1,
    executionDigest: "c".repeat(64),
    flow: { kind: "prompt" as const, prompt: "New revision" },
  };

  const next = service.revise(update);
  expect(next.graphVersion).toBe(2);
  expect(next.origin).toBe("imported");
  expect(admit(service).runId).toBe(run.runId);
  expect(service.revise(update)).toEqual(next);
  expect(() =>
    service.revise({ ...update, flow: { kind: "prompt", prompt: "Conflicting revision" } }),
  ).toThrow("conflict");
  const complete = await service.execute(lookup, new AbortController().signal);
  expect(complete.graphVersion).toBe(run.graphVersion);
  expect(complete.accepted).toHaveLength(7);
});

test("cross-week and mismatched confirmation admissions are refused", () => {
  const { service } = setup(model());
  const run = admit(service);

  const {
    runId: _id,
    status: _status,
    cursor: _cursor,
    accepted: _accepted,
    outputs: _outputs,
    pending: _pending,
    error: _error,
    ...admission
  } = run;

  expect(() => service.admit({ ...admission, occurrenceKey: "week:2026-11-30" })).toThrow("week");
  expect(() => service.admit({ ...admission, bindingRevision: 2 })).toThrow("conflict");
  expect(() => service.admit({ ...admission, projectId: "foreign" })).toThrow("match");
});

test("modified accepted draft fails checkpoint integrity before a resumed request", async () => {
  const runner = model();
  const { service, db } = setup(runner);
  admit(service);
  await service.execute(lookup, new AbortController().signal);
  const count = runner.calls.length;
  db.prepare(
    "UPDATE sm_imported_runs SET document=json_set(document,'$.accepted[0].draft.body','Changed after review')",
  ).run();
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow("integrity");
  expect(runner.calls).toHaveLength(count);
});

test("unavailable model preflight stays explicit and never starts work", async () => {
  const runner = model();
  const { service } = setup(runner);
  expect(
    await service.preflight({ hostId: "host", providerId: "codex", model: "fixture" }),
  ).toMatchObject({ available: false });
  expect(runner.calls).toHaveLength(0);
});

test("legacy Apple bindings cannot be admitted or resumed", async () => {
  const runner = model();
  const { service, db } = setup(runner);
  const binding = { hostId: "host", providerId: "apple-foundation", model: "on-device" };
  expect(() => admit(service, binding)).toThrow("connected Codex or Claude Code");
  expect(await service.preflight(binding)).toMatchObject({ available: false });
  admit(service);
  db.prepare(
    "UPDATE sm_imported_runs SET document=json_set(document,'$.binding.providerId','apple-foundation','$.binding.model','on-device')",
  ).run();
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow(
    "connected Codex or Claude Code",
  );
  expect(runner.calls).toHaveLength(0);
});

test("exhausted candidate budget reports partial and cannot export", async () => {
  const { service } = setup(model());
  service.import({ ...input, flow: { ...weeklyContentFeed, maxCandidates: 7 } });
  const graph = service.lookup(lookup)!.graph;
  service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: 1,
    executionDigest: input.executionDigest,
    occurrenceKey: lookup.occurrenceKey,
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets: input.assets,
  });
  const partial = await service.execute(lookup, new AbortController().signal);
  expect(partial.status).toBe("partial");
  expect(partial.error).toBe("Candidate budget exhausted: 6/7 drafts accepted");
  expect(() => service.export(lookup)).toThrow("complete");
});

test("unsupplied reference is refused before review", async () => {
  const runner = model();
  runner.run = async (request) =>
    JSON.stringify({
      candidateId: request.assets.inputs.candidateId,
      canonicalTopic: "seed",
      title: "Seed",
      body: "Body",
      sources: ["https://untrusted.example/evidence"],
    });
  const { service } = setup(runner);
  admit(service);
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow(
    "unsupplied source",
  );
  expect(service.lookup(lookup)?.run?.accepted).toHaveLength(0);
});

test("export pins calendar and reviews; lost fake destination acknowledgment reconciles once", async () => {
  const { service } = setup(model());
  admit(service);
  await service.execute(lookup, new AbortController().signal);
  const artifact = service.export(lookup);
  expect(artifact.files).toHaveLength(9);
  expect(artifact.files.every((file) => file.digest === contentDigest(file.content))).toBe(true);
  expect(
    JSON.parse(artifact.files.find((file) => file.name === "calendar.json")!.content),
  ).toHaveLength(7);
  expect(
    JSON.parse(artifact.files.find((file) => file.name === "reviews.json")!.content),
  ).toHaveLength(7);
  let effects = 0;
  let recorded: { receiptId: string } | null = null;

  const destination = {
    async lookup() {
      return recorded;
    },
    async publish() {
      effects++;
      recorded = { receiptId: "fixture-receipt" };
      throw new Error("acknowledgment lost");
    },
  };

  await expect(service.handoff(lookup, "fixture-only", destination)).rejects.toThrow("lost");
  expect(await service.handoff(lookup, "fixture-only", destination)).toEqual(recorded);
  expect(await service.handoff(lookup, "fixture-only", destination)).toEqual(recorded);
  expect(effects).toBe(1);
});

test("prompt response reconciliation resumes without replaying the model request", async () => {
  let calls = 0;

  const { service } = setup({
    async run() {
      calls++;
      throw new Error("Response lost");
    },
  });

  const graph = service.import({
    ...input,
    flow: { kind: "prompt", prompt: "Write only supplied text" },
  });

  service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: 1,
    executionDigest: input.executionDigest,
    occurrenceKey: lookup.occurrenceKey,
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets: input.assets,
  });
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow("lost");
  const requestId = service.lookup(lookup)!.run!.pending!.requestId;
  expect(() =>
    service.reconcileRun({ ...lookup, requestId: "foreign", response: "Draft" }),
  ).toThrow("identity");
  service.reconcileRun({ ...lookup, requestId, response: "Recovered draft" });
  const done = await service.execute(lookup, new AbortController().signal);
  expect(done.outputs).toEqual(["Recovered draft"]);
  expect(done.status).toBe("complete");
  expect(calls).toBe(1);
});

test("unavailable capability refuses before reserving a model request", async () => {
  let calls = 0;

  const { service } = setup({
    async preflight() {
      return { available: false, message: "Unsupported transport" };
    },
    async run() {
      calls++;

      return "";
    },
  });

  admit(service);
  await expect(service.execute(lookup, new AbortController().signal)).rejects.toThrow(
    "Unsupported transport",
  );
  expect(service.lookup(lookup)?.run?.pending).toBeNull();
  expect(calls).toBe(0);
});

test("trusted calendar start and timezone stay separate from the week identity", async () => {
  const { service } = setup(model());

  const assets = {
    ...input.assets,
    inputs: { ...input.assets.inputs, calendarStart: "2026-11-26", timezone: "America/Toronto" },
  };

  const graph = service.import({ ...input, assets });
  service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: graph.graphVersion,
    executionDigest: input.executionDigest,
    occurrenceKey: lookup.occurrenceKey,
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets,
  });
  const done = await service.execute(lookup, new AbortController().signal);
  expect(done.occurrenceKey).toBe("week:2026-11-23");
  expect(done.accepted[0]?.date).toBe("2026-11-26");
  expect(done.accepted[6]?.date).toBe("2026-12-02");

  const calendar = JSON.parse(
    service.export(lookup).files.find((file) => file.name === "calendar.json")!.content,
  );

  expect(calendar).toHaveLength(7);
  expect(
    calendar.every((entry: { timezone: string }) => entry.timezone === "America/Toronto"),
  ).toBe(true);
});

test("canonical core weekly fixture has identical digest and executable flow", () => {
  const bytes = readFileSync(
    new URL("./fixtures/weekly-content-feed.omnyoworkflow", import.meta.url),
  );

  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "fbf37d66f254922f260f2aa28078511e256a84d3194d7d26c4f74ba36bfdbd57",
  );
  const fixture = z.object({ flow: importedFlowSchema }).parse(JSON.parse(bytes.toString("utf8")));
  expect(fixture.flow).toMatchObject({
    kind: "graph",
    engine: "weekly-content-feed",
    targetCount: 7,
  });
  expect(importedFlowSchema.parse(fixture.flow)).toEqual(fixture.flow);
});

test("one bounded rewrite is independently reviewed and resumes from its stored response", async () => {
  const abort = new AbortController();
  const requests: string[] = [];

  const { service, db } = setup({
    async run(request) {
      requests.push(request.requestId);
      const candidateId = String(request.assets.inputs.candidateId);
      const phase = request.requestId.split(":").at(-1);

      if (phase === "writer")
        return JSON.stringify({
          candidateId,
          canonicalTopic: "seed",
          title: "Seed swaps",
          body: "Original draft",
          sources: [],
        });

      if (phase === "reviewer")
        return JSON.stringify({
          candidateId,
          draftDigest: contentDigest(request.assets.inputs.draft),
          outcome: "revise",
          reason: "Use the supplied wording.",
        });

      if (phase === "rewrite") {
        expect(request.assets.inputs.reviewFeedback).toMatchObject({
          outcome: "revise",
          reason: "Use the supplied wording.",
        });
        abort.abort();

        return JSON.stringify({
          candidateId,
          canonicalTopic: "seed",
          title: "Seed swaps",
          body: "Revised draft",
          sources: [],
        });
      }

      expect(phase).toBe("review-rewrite");
      expect(request.assets.inputs.draft).toMatchObject({ body: "Revised draft" });

      return JSON.stringify({
        candidateId,
        draftDigest: contentDigest(request.assets.inputs.draft),
        outcome: "accepted",
        reason: "Checked revised content.",
      });
    },
  });

  const graph = service.import({
    ...input,
    flow: { ...weeklyContentFeed, targetCount: 1, maxCandidates: 1 },
  });

  service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: 1,
    executionDigest: input.executionDigest,
    occurrenceKey: lookup.occurrenceKey,
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets: input.assets,
  });
  await expect(service.execute(lookup, abort.signal)).rejects.toThrow();
  expect(requests).toHaveLength(3);

  const done = await new ImportedWorkflowService(db, {
    async run(request) {
      requests.push(request.requestId);
      expect(request.requestId.endsWith(":review-rewrite")).toBe(true);

      return JSON.stringify({
        candidateId: request.assets.inputs.candidateId,
        draftDigest: contentDigest(request.assets.inputs.draft),
        outcome: "accepted",
        reason: "Independent revised review.",
      });
    },
  }).execute(lookup, new AbortController().signal);

  expect(done.status).toBe("complete");
  expect(done.accepted[0]?.draft.body).toBe("Revised draft");
  expect(done.accepted[0]?.review.draftDigest).toBe(done.accepted[0]?.digest);
  expect(new Set(requests).size).toBe(4);
});

test("a second revision request ends the candidate and later drafts receive accepted topics", async () => {
  const phases: string[] = [];

  const { service } = setup({
    async run(request) {
      const phase = request.requestId.split(":").at(-1)!;
      const candidateId = String(request.assets.inputs.candidateId);
      phases.push(`${candidateId}:${phase}`);

      if (candidateId === "candidate-3" && phase === "writer")
        expect(request.assets.inputs.acceptedCanonicalTopics).toEqual(["topic-candidate-2"]);

      if (phase === "writer" || phase === "rewrite")
        return JSON.stringify({
          candidateId,
          canonicalTopic: `topic-${candidateId}`,
          title: "Title",
          body: "Draft",
          sources: [],
        });

      return JSON.stringify({
        candidateId,
        draftDigest: contentDigest(request.assets.inputs.draft),
        outcome: candidateId === "candidate-1" ? "revise" : "accepted",
        reason: "Fixture review",
      });
    },
  });

  const graph = service.import({
    ...input,
    flow: { ...weeklyContentFeed, targetCount: 2, maxCandidates: 3 },
  });

  service.admit({
    projectId: input.projectId,
    importId: input.importId,
    graphId: graph.graphId,
    graphVersion: 1,
    executionDigest: input.executionDigest,
    occurrenceKey: lookup.occurrenceKey,
    bindingRevision: 1,
    binding: { hostId: "host", providerId: "codex", model: "fixture" },
    assets: input.assets,
  });
  const done = await service.execute(lookup, new AbortController().signal);
  expect(done.status).toBe("complete");
  expect(done.accepted.map((item) => item.draft.candidateId)).toEqual([
    "candidate-2",
    "candidate-3",
  ]);
  expect(phases.filter((phase) => phase.startsWith("candidate-1"))).toEqual([
    "candidate-1:writer",
    "candidate-1:reviewer",
    "candidate-1:rewrite",
    "candidate-1:review-rewrite",
  ]);
});

test.each(["research", "notes"])(
  "runs a pinned %s brief through the real model request and export path",
  async (mode) => {
    const facts = Array.from(
      { length: 7 },
      (_, index) => `${index + 1}. Approved fact ${index + 1}`,
    ).join("\n");

    const site = "mosslight.example";
    const retrievedAt = "2026-11-20T12:00:00.000Z";
    const reference = "https://mosslight.example/guide";
    const keywords = ["seed labels", "SEED LABELS", "swap dates"];
    const captured: { instructions: string; inputs: z.infer<typeof assetsSchema>["inputs"] }[] = [];
    const transport = z.object({ attemptId: z.string(), prompt: z.string() });

    const modelRequest = z.object({
      instructions: z.string(),
      suppliedData: z.object({ inputs: assetsSchema.shape.inputs }),
    });

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        plugins: {
          callRpc(request) {
            expect(request.pluginId).toBe("provider-codex");

            if (request.method === "workflowModelCapabilities") return { available: true };
            expect(request.method).toBe("workflowModelComplete");
            const { attemptId, prompt } = transport.parse(request.input);

            const {
              suppliedData: { inputs },
              instructions,
            } = modelRequest.parse(JSON.parse(prompt));

            captured.push({ inputs, instructions });

            const review =
              inputs.workflowPhase === "reviewer" || inputs.workflowPhase === "review-rewrite";

            const fields = review
              ? {
                  outcome:
                    inputs.workflowPhase === "reviewer" && inputs.candidateId === "candidate-1"
                      ? "revise"
                      : "accepted",
                  reason: "Checked.",
                }
              : {
                  canonicalTopic: inputs.candidateId,
                  title: `Draft for ${String(inputs.candidateId)}`,
                  body: "A complete Markdown draft.",
                  sources: [reference],
                };

            return { ok: true, attemptId, text: JSON.stringify(fields) };
          },
        },
      },
    });

    try {
      const { service } = setup(createImportedTextRunner(host.api));

      const selected =
        mode === "research"
          ? {
              openSeoEvidence: JSON.stringify({
                source: "OpenSEO saved keywords",
                meaning: "Topic selection only.",
                site,
                retrievedAt,
                keywords: keywords.map((keyword) => ({ keyword, intent: null, volume: 17 })),
              }),
            }
          : {};

      const assets = {
        ...input.assets,
        inputs: {
          ...input.assets.inputs,
          "product-facts": facts,
          references: [reference],
          ...selected,
        },
      };

      admit(service, undefined, assets);
      const run = await service.execute(lookup, new AbortController().signal);
      expect(run.accepted).toHaveLength(7);
      const first = captured.filter(({ inputs }) => inputs.candidateId === "candidate-1");
      expect(first.map(({ inputs }) => inputs.workflowPhase)).toEqual([
        "writer",
        "reviewer",
        "rewrite",
        "review-rewrite",
      ]);
      expect(run.accepted[0]?.draft).toMatchObject({
        title: "Draft for candidate-1",
        sources: [reference],
      });

      const reviews = JSON.parse(
        service.export(lookup).files.find(({ name }) => name === "reviews.json")?.content ?? "",
      );

      expect(reviews).toHaveLength(7);

      if (mode === "notes") {
        expect(first.map(({ inputs }) => inputs["product-facts"])).toEqual(
          Array(4).fill("Approved fact 1"),
        );
        expect(run.accepted[0]?.draft.canonicalTopic).toBe("Approved fact 1");
        expect(reviews).toEqual(run.accepted.map(({ review }) => review));

        return;
      }

      const topic = run.accepted[0]?.draft.canonicalTopic;
      expect(topic).toBe("seed labels");
      expect(first.map(({ inputs }) => inputs.assignedKeyword)).toEqual(
        Array(4).fill({ canonicalTopic: topic, keyword: "seed labels" }),
      );
      expect(first[3]?.instructions).toContain(
        "Never infer product claims, search demand or measurement dates",
      );
      expect(first[3]?.inputs.draft).toMatchObject({
        canonicalTopic: topic,
        title: "Draft for candidate-1",
      });
      expect(
        captured.every(
          ({ inputs }) =>
            inputs["product-facts"] === facts &&
            !("openSeoEvidence" in inputs) &&
            !("assignedFact" in inputs),
        ),
      ).toBe(true);
      expect(
        captured.find(({ inputs }) => inputs.candidateId === "candidate-3")?.inputs.assignedKeyword,
      ).toBeUndefined();
      expect(reviews).toEqual(
        run.accepted.map(({ review }, index) =>
          index < 2
            ? {
                ...review,
                research: {
                  kind: "openseo",
                  keyword: index === 0 ? "seed labels" : "swap dates",
                  site,
                  retrievedAt,
                },
              }
            : review,
        ),
      );
    } finally {
      await host.harness.lifecycle.dispose();
    }
  },
);
