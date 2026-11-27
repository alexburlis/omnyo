import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateMachineDatabase } from "../data/store.js";
import { row } from "../data/store.js";
import { canonicalJson } from "../definition/canonical.js";
import {
  supportsSubscription,
  unsupportedBinding,
  assetsSchema,
  admitInputSchema,
  draftSchema,
  importInputSchema,
  importRecordSchema,
  lookupInputSchema,
  reviewSchema,
  runSchema,
  reviseInputSchema,
  exportSchema,
  reconcileInputSchema,
  validateImportedFlow,
  type ImportedRun,
} from "./contracts.js";
import { frozenOpenSeoEvidence, openSeoFocus } from "./open-seo-evidence.js";

export const contentDigest = <T>(value: T): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export interface WorkflowTextRunner {
  preflight?(
    binding: z.infer<typeof admitInputSchema>["binding"],
  ): Promise<{ available: boolean; code?: string; message?: string }>;
  run(input: {
    requestId: string;
    binding: z.infer<typeof admitInputSchema>["binding"];
    prompt: string;
    assets: z.infer<typeof assetsSchema>;
    signal: AbortSignal;
  }): Promise<string>;
}

const dateSchema = z.iso.date();

const weekInputSchema = z.object({ weekStart: dateSchema, calendarStart: dateSchema.optional() });

const timezoneInputSchema = z.object({ timezone: z.string().min(1).max(128).default("UTC") });

const referenceInputSchema = z.object({
  references: z.array(z.string().url()).max(100).optional(),
});

export interface WorkflowDestination {
  lookup(key: string): Promise<{ receiptId: string } | null>;
  publish(key: string, manifest: z.infer<typeof exportSchema>): Promise<{ receiptId: string }>;
}

export class ImportedWorkflowService {
  private readonly active = new Set<string>();
  constructor(
    private readonly db: StateMachineDatabase,
    private readonly runner: WorkflowTextRunner,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS sm_imported_graphs (project_id TEXT NOT NULL, import_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id,import_id))",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS sm_imported_versions (graph_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(graph_id,version))",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS sm_imported_handoffs (effect_key TEXT PRIMARY KEY, receipt_id TEXT, pending INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS sm_imported_responses (request_id TEXT PRIMARY KEY, response TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS sm_imported_runs (project_id TEXT NOT NULL, import_id TEXT NOT NULL, occurrence_key TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id,import_id,occurrence_key))",
    );
  }
  import(raw: z.input<typeof importInputSchema>) {
    const input = importInputSchema.parse(raw);
    validateImportedFlow(input.flow);

    return this.db.transaction(() => {
      const existing = this.lookup({ projectId: input.projectId, importId: input.importId });

      if (existing) {
        const original = row(
          importRecordSchema,
          this.db
            .prepare("SELECT document FROM sm_imported_versions WHERE graph_id=? AND version=1")
            .get(existing.graph.graphId),
        );

        if (!original) throw new Error("Original import receipt is unavailable");

        const {
          graphId: _id,
          graphVersion: _version,
          origin: _origin,
          status: _status,
          ...saved
        } = original;

        if (canonicalJson(saved) !== canonicalJson(input))
          throw new Error("Import identity conflict");

        return original;
      }

      const graph = importRecordSchema.parse({
        ...input,
        graphId: `mch_${randomUUID()}`,
        graphVersion: 1,
        origin: "imported",
        status: "disabled",
      });

      this.db
        .prepare("INSERT INTO sm_imported_graphs VALUES(?,?,?)")
        .run(input.projectId, input.importId, JSON.stringify(graph));

      this.db
        .prepare("INSERT INTO sm_imported_versions VALUES(?,?,?)")
        .run(graph.graphId, graph.graphVersion, JSON.stringify(graph));

      return graph;
    })();
  }
  revise(raw: z.input<typeof reviseInputSchema>) {
    const input = reviseInputSchema.parse(raw);
    validateImportedFlow(input.flow);

    return this.db.transaction(() => {
      const current = this.lookup({ projectId: input.projectId, importId: input.importId });

      if (!current || current.graph.graphId !== input.graphId)
        throw new Error("Imported graph identity mismatch");
      const { expectedGraphVersion, ...content } = input;

      const next = importRecordSchema.parse({
        ...content,
        graphVersion: expectedGraphVersion + 1,
        origin: "imported",
        status: "disabled",
      });

      const existing = row(
        importRecordSchema,
        this.db
          .prepare("SELECT document FROM sm_imported_versions WHERE graph_id=? AND version=?")
          .get(input.graphId, next.graphVersion),
      );

      if (existing && canonicalJson(existing) === canonicalJson(next)) return existing;

      if (current.graph.graphVersion !== expectedGraphVersion)
        throw new Error("Imported graph revision conflict");
      this.db
        .prepare("INSERT INTO sm_imported_versions VALUES(?,?,?)")
        .run(next.graphId, next.graphVersion, JSON.stringify(next));
      this.db
        .prepare("UPDATE sm_imported_graphs SET document=? WHERE project_id=? AND import_id=?")
        .run(JSON.stringify(next), next.projectId, next.importId);

      return next;
    })();
  }
  lookup(raw: z.input<typeof lookupInputSchema>) {
    const input = lookupInputSchema.parse(raw);

    const graph = row(
      importRecordSchema,
      this.db
        .prepare("SELECT document FROM sm_imported_graphs WHERE project_id=? AND import_id=?")
        .get(input.projectId, input.importId),
    );

    if (!graph) return null;
    validateImportedFlow(graph.flow);

    const run = input.occurrenceKey
      ? row(
          runSchema,
          this.db
            .prepare(
              "SELECT document FROM sm_imported_runs WHERE project_id=? AND import_id=? AND occurrence_key=?",
            )
            .get(input.projectId, input.importId, input.occurrenceKey),
        )
      : null;

    if (run) {
      const topics = new Set<string>();
      const dates = new Set<string>();

      for (const item of run.accepted) {
        const topic = item.draft.canonicalTopic.trim().toLocaleLowerCase("en-US");

        if (
          contentDigest(item.draft) !== item.digest ||
          item.review.draftDigest !== item.digest ||
          item.review.candidateId !== item.draft.candidateId ||
          item.review.outcome !== "accepted" ||
          topics.has(topic) ||
          dates.has(item.date)
        )
          throw new Error("Accepted checkpoint integrity failed");
        topics.add(topic);
        dates.add(item.date);
      }
    }

    return { graph, run };
  }
  admit(raw: z.input<typeof admitInputSchema>): ImportedRun {
    const input = admitInputSchema.parse(raw);

    if (!supportsSubscription(input.binding)) throw new Error(unsupportedBinding.message);

    return this.db.transaction(() => {
      const existing = this.lookup({
        projectId: input.projectId,
        importId: input.importId,
        occurrenceKey: input.occurrenceKey,
      });

      if (existing?.run) {
        const {
          runId: _runId,
          status: _status,
          cursor: _cursor,
          accepted: _accepted,
          outputs: _outputs,
          pending: _pending,
          error: _error,
          ...saved
        } = existing.run;

        if (canonicalJson(saved) !== canonicalJson(input))
          throw new Error("Occurrence identity conflict");

        return existing.run;
      }

      if (
        !existing ||
        existing.graph.graphId !== input.graphId ||
        existing.graph.graphVersion !== input.graphVersion ||
        existing.graph.executionDigest !== input.executionDigest
      )
        throw new Error("Pinned imported graph does not match");

      if (
        existing.graph.flow.kind === "graph" &&
        existing.graph.flow.engine === "weekly-content-feed"
      ) {
        const { weekStart } = weekInputSchema.parse(input.assets.inputs);

        if (!input.occurrenceKey.endsWith(`:${weekStart}`))
          throw new Error("Occurrence does not match the pinned week");
      }

      const run = runSchema.parse({
        ...input,
        runId: `wrun_${randomUUID()}`,
        status: "ready",
        cursor: 0,
        accepted: [],
        outputs: [],
        pending: null,
        error: null,
      });

      this.db
        .prepare("INSERT INTO sm_imported_runs VALUES(?,?,?,?)")
        .run(input.projectId, input.importId, input.occurrenceKey, JSON.stringify(run));

      return run;
    })();
  }
  private save(run: ImportedRun): void {
    runSchema.parse(run);
    this.db
      .prepare(
        "UPDATE sm_imported_runs SET document=? WHERE project_id=? AND import_id=? AND occurrence_key=?",
      )
      .run(JSON.stringify(run), run.projectId, run.importId, run.occurrenceKey);
  }
  async preflight(binding: z.infer<typeof admitInputSchema>["binding"]) {
    if (!supportsSubscription(binding)) return unsupportedBinding;

    return this.runner.preflight
      ? this.runner.preflight(binding)
      : {
          available: false,
          code: "capability_unavailable",
          message: "Restricted subscription capability is unavailable",
        };
  }
  async execute(raw: z.input<typeof lookupInputSchema>, signal: AbortSignal): Promise<ImportedRun> {
    const input = lookupInputSchema.parse(raw);
    const saved = this.lookup(input);

    if (!saved?.run) throw new Error("Run has not been admitted");
    const { run } = saved;

    const graph = row(
      importRecordSchema,
      this.db
        .prepare("SELECT document FROM sm_imported_versions WHERE graph_id=? AND version=?")
        .get(run.graphId, run.graphVersion),
    );

    if (!graph || graph.executionDigest !== run.executionDigest)
      throw new Error("Pinned graph version is unavailable");
    validateImportedFlow(graph.flow);

    if (run.status === "complete") return run;

    if (this.active.has(run.runId)) throw new Error("Run already executing");

    if (!supportsSubscription(run.binding)) throw new Error(unsupportedBinding.message);

    if (run.pending && this.response(run.pending.requestId) === null)
      throw new Error("Pending model response must be reconciled before resume");
    this.active.add(run.runId);

    try {
      if (this.runner.preflight) {
        const capability = await this.runner.preflight(run.binding);

        if (!capability.available)
          throw new Error(
            capability.message ?? "Restricted subscription capability is unavailable",
          );
      }

      run.status = "running";
      run.error = null;
      this.save(run);

      if (graph.flow.kind === "graph" && graph.flow.engine === "weekly-content-feed") {
        const flow = graph.flow;
        const { weekStart, calendarStart } = weekInputSchema.parse(run.assets.inputs);

        const evidence = frozenOpenSeoEvidence(run.assets.inputs);

        while (run.accepted.length < flow.targetCount && run.cursor < flow.maxCandidates) {
          signal.throwIfAborted();
          const candidateId = `candidate-${run.cursor + 1}`;
          const focus = openSeoFocus(evidence, run.cursor);

          const text = await this.text(
            run,
            "writer",
            candidateId,
            null,
            flow.writer.prompt,
            signal,
          );

          let draft = this.readDraft(text, candidateId, run.assets, focus?.canonicalTopic);

          let review = this.readReview(
            await this.text(run, "reviewer", candidateId, draft, flow.reviewer.prompt, signal),
            draft,
          );

          if (review.outcome === "revise") {
            const rewritten = await this.text(
              run,
              "rewrite",
              candidateId,
              draft,
              `${flow.writer.prompt}\nRevise the supplied draft using reviewFeedback. Preserve candidateId and return the same draft JSON structure.`,
              signal,
              review,
            );

            draft = this.readDraft(rewritten, candidateId, run.assets, focus?.canonicalTopic);
            review = this.readReview(
              await this.text(
                run,
                "review-rewrite",
                candidateId,
                draft,
                flow.reviewer.prompt,
                signal,
              ),
              draft,
            );
          }

          const digest = contentDigest(draft);

          const duplicate = run.accepted.some(
            (item) =>
              item.draft.canonicalTopic.trim().toLocaleLowerCase("en-US") ===
              draft.canonicalTopic.trim().toLocaleLowerCase("en-US"),
          );

          if (review.outcome === "accepted" && !duplicate) {
            const date = new Date(`${calendarStart ?? weekStart}T00:00:00.000Z`);
            date.setUTCDate(date.getUTCDate() + run.accepted.length);

            const accepted: ImportedRun["accepted"][number] = {
              draft,
              digest,
              review,
              date: date.toISOString().slice(0, 10),
            };

            if (focus) accepted.research = focus.research;
            run.accepted.push(accepted);
          }

          run.cursor++;
          this.save(run);
        }

        run.status = run.accepted.length === flow.targetCount ? "complete" : "partial";

        if (run.status === "partial")
          run.error = `Candidate budget exhausted: ${run.accepted.length}/${flow.targetCount} drafts accepted`;
      } else if (graph.flow.kind === "prompt") {
        if (run.cursor === 0) {
          const output = await this.text(run, "model", "step-0", null, graph.flow.prompt, signal);
          run.outputs.push(output);
          run.cursor = 1;
          this.save(run);
        }

        run.status = "complete";
      } else {
        const flow = graph.flow;
        let stepId = flow.startStepId;
        let modelIndex = 0;
        let previous = "";

        for (;;) {
          signal.throwIfAborted();
          const step = flow.steps.find((item) => item.id === stepId);

          if (!step) throw new Error("Pinned restricted step is missing");

          if (step.kind === "export") {
            if (modelIndex !== run.outputs.length)
              throw new Error("Recorded outputs do not match the selected branch");
            break;
          }

          if (step.kind === "model") {
            const recorded = run.outputs[modelIndex];

            if (recorded !== undefined) {
              if (recorded !== this.response(`${run.runId}:step-${modelIndex}:model`))
                throw new Error("Recorded model output integrity failed");
              previous = recorded;
            } else {
              previous = await this.text(
                run,
                "model",
                `step-${modelIndex}`,
                null,
                step.prompt,
                signal,
              );
              run.outputs.push(previous);
              run.cursor = run.outputs.length;
              this.save(run);
            }

            modelIndex++;
            stepId = step.nextStepId;
          } else if (step.kind === "validate-text") {
            stepId =
              new TextEncoder().encode(previous).byteLength <= step.maxBytes
                ? step.nextStepId
                : step.failureStepId;
          } else {
            const matches =
              step.operand === "equals" ? previous === step.value : previous.includes(step.value);

            stepId = matches ? step.nextStepId : step.otherwiseStepId;
          }
        }

        run.status = "complete";
      }

      this.save(run);

      return run;
    } catch (error) {
      run.status = "partial";
      run.error = error instanceof Error ? error.message : "Restricted run failed";
      this.save(run);
      throw error;
    } finally {
      this.active.delete(run.runId);
    }
  }
  export(raw: z.input<typeof lookupInputSchema>) {
    const saved = this.lookup(raw);

    if (!saved?.run || saved.run.status !== "complete")
      throw new Error("Only a complete verified run can be exported");
    const run = saved.run;

    const files = run.accepted.map((item) => {
      const content = `# ${item.draft.title}\n\n${item.draft.body}\n`;

      return { name: `${item.draft.candidateId}.md`, content, digest: contentDigest(content) };
    });

    const { timezone } = timezoneInputSchema.parse(run.assets.inputs);

    const calendar = canonicalJson(
      run.accepted.map((item) => ({
        date: item.date,
        timezone,
        candidateId: item.draft.candidateId,
        digest: item.digest,
      })),
    );

    const reviews = canonicalJson(
      run.accepted.map(({ review, research }) => (research ? { ...review, research } : review)),
    );

    files.push(
      { name: "calendar.json", content: calendar, digest: contentDigest(calendar) },
      { name: "reviews.json", content: reviews, digest: contentDigest(reviews) },
    );

    if (run.outputs.length) {
      const content = run.outputs.join("\n\n");
      files.push({ name: "output.md", content, digest: contentDigest(content) });
    }

    const identity = {
      runId: run.runId,
      graphId: run.graphId,
      graphVersion: run.graphVersion,
      occurrenceKey: run.occurrenceKey,
      files,
    };

    return exportSchema.parse({ ...identity, manifestDigest: contentDigest(identity) });
  }
  async handoff(
    raw: z.input<typeof lookupInputSchema>,
    destinationId: string,
    destination: WorkflowDestination,
  ) {
    const manifest = this.export(raw);
    const key = contentDigest({ destinationId, manifestDigest: manifest.manifestDigest });

    const previous = z
      .object({ receipt_id: z.string().nullable(), pending: z.number() })
      .optional()
      .parse(
        this.db
          .prepare("SELECT receipt_id,pending FROM sm_imported_handoffs WHERE effect_key=?")
          .get(key),
      );

    if (previous?.receipt_id) return { receiptId: previous.receipt_id };

    if (previous?.pending) {
      const found = await destination.lookup(key);

      if (!found)
        throw new Error(
          "Publishing outcome is unknown; reconcile the exact effect before retrying",
        );
      this.db
        .prepare("UPDATE sm_imported_handoffs SET receipt_id=?,pending=0 WHERE effect_key=?")
        .run(found.receiptId, key);

      return found;
    }

    this.db.prepare("INSERT INTO sm_imported_handoffs VALUES(?,NULL,1)").run(key);
    const receipt = await destination.publish(key, manifest);
    this.db
      .prepare("UPDATE sm_imported_handoffs SET receipt_id=?,pending=0 WHERE effect_key=?")
      .run(receipt.receiptId, key);

    return receipt;
  }
  reconcileRun(raw: z.input<typeof reconcileInputSchema>) {
    const input = reconcileInputSchema.parse(raw);

    const saved = this.lookup({
      projectId: input.projectId,
      importId: input.importId,
      occurrenceKey: input.occurrenceKey,
    });

    if (!saved?.run || saved.run.pending?.requestId !== input.requestId)
      throw new Error("Pending response identity mismatch");
    this.reconcile(input.requestId, input.response);

    return saved.run;
  }
  private response(requestId: string): string | null {
    const found = z
      .object({ response: z.string() })
      .optional()
      .parse(
        this.db
          .prepare("SELECT response FROM sm_imported_responses WHERE request_id=?")
          .get(requestId),
      );

    return found?.response ?? null;
  }
  reconcile(requestId: string, response: string): void {
    z.string().max(65536).parse(response);
    const existing = this.response(requestId);

    if (existing !== null && existing !== response) throw new Error("Conflicting model response");
    this.db
      .prepare("INSERT OR IGNORE INTO sm_imported_responses VALUES(?,?)")
      .run(requestId, response);
  }
  private readDraft(
    text: string,
    candidateId: string,
    assets: z.infer<typeof assetsSchema>,
    canonicalTopic?: string,
  ) {
    const draft = draftSchema.parse(JSON.parse(text));

    if (draft.candidateId !== candidateId) throw new Error("Draft candidate identity mismatch");

    if (canonicalTopic !== undefined && draft.canonicalTopic !== canonicalTopic)
      throw new Error("Draft research topic identity mismatch");

    const references = referenceInputSchema.parse(assets.inputs).references ?? [];

    if (draft.sources.some((source) => !references.includes(source)))
      throw new Error("Draft references an unsupplied source");

    return draft;
  }
  private readReview(text: string, draft: z.infer<typeof draftSchema>) {
    const review = reviewSchema.parse(JSON.parse(text));

    if (review.candidateId !== draft.candidateId || review.draftDigest !== contentDigest(draft))
      throw new Error("Review does not match exact draft");

    return review;
  }
  private async text(
    run: ImportedRun,
    phase: NonNullable<ImportedRun["pending"]>["phase"],
    candidateId: string,
    draft: z.infer<typeof draftSchema> | null,
    prompt: string,
    signal: AbortSignal,
    reviewFeedback: z.infer<typeof reviewSchema> | null = null,
  ): Promise<string> {
    signal.throwIfAborted();
    const requestId = `${run.runId}:${candidateId}:${phase}`;
    const cached = this.response(requestId);

    if (cached !== null) {
      run.pending = null;
      this.save(run);

      return cached;
    }

    run.pending = { requestId, phase, candidateId, draft };
    this.save(run);

    const text = await this.runner.run({
      requestId,
      binding: run.binding,
      prompt,
      assets: {
        ...run.assets,
        inputs: {
          ...run.assets.inputs,
          candidateId,
          draft,
          draftDigest: draft ? contentDigest(draft) : null,
          previousOutputs: run.outputs,
          workflowPhase: phase,
          reviewFeedback,
          acceptedCanonicalTopics: run.accepted.map((item) => item.draft.canonicalTopic),
        },
      },
      signal,
    });

    z.string().max(65536).parse(text);
    this.db.transaction(() => {
      this.reconcile(requestId, text);
      run.pending = null;
      this.save(run);
    })();

    return text;
  }
}
