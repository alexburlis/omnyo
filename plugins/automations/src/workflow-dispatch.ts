import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  closeAutomationRun,
  getAutomation,
  listRunningAutomationRuns,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { errorMessage } from "./run.js";
import {
  productFactLines,
  WEEKLY_FACT_TARGET,
} from "./weekly-product-facts.js";
import type { createWorkflowImports } from "./workflow-import.js";
import {
  workflowHash,
  workflowId,
  workflowBindings,
  workflowArtifact,
} from "./workflow-contract.js";

const capability = z.object({
  available: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
});

const runIdentity = z.object({
  runId: workflowId,
  graphId: workflowId,
  graphVersion: z.int().positive(),
  bindingRevision: z.int().positive(),
  executionDigest: workflowHash,
  status: z.enum(["ready", "running", "partial", "complete", "failed"]),
  error: z.string().nullable(),
});

const lookup = z.object({ run: runIdentity.nullable() }).nullable();

const admission = z.strictObject({
  projectId: workflowId,
  importId: workflowId,
  graphId: workflowId,
  graphVersion: z.int().positive(),
  executionDigest: workflowHash,
  bindingRevision: z.int().positive(),
  occurrenceKey: workflowId,
  binding: workflowBindings.omit({ inputs: true }),
  assets: z.strictObject({
    skills: z.array(z.strictObject({ id: workflowId, text: z.string() })),
    inputs: z.record(
      z.string(),
      z.union([z.string(), z.int(), z.boolean(), z.array(z.string()).max(100)]),
    ),
  }),
});

type Admission = z.infer<typeof admission>;

export const workflowDispatchMigration = `CREATE TABLE workflow_dispatches (
  run_id TEXT PRIMARY KEY REFERENCES automation_runs(id) ON DELETE CASCADE,
  admission TEXT NOT NULL,
  graph_run_id TEXT,
  execute_requested_at INTEGER,
  last_error TEXT
)`;

function localDate(at: number, timezone: string): number {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const date = Date.parse(
    `${fields.find(({ type }) => type === "year")?.value}-${fields.find(({ type }) => type === "month")?.value}-${fields.find(({ type }) => type === "day")?.value}T00:00:00Z`,
  );

  return date;
}

export function workflowWeek(at: number, timezone: string): string {
  const date = localDate(at, timezone);
  const monday = date - ((new Date(date).getUTCDay() + 6) % 7) * 86_400_000;

  return new Date(monday).toISOString().slice(0, 10);
}

function nextDeliveryDate(
  at: number,
  timezone: string,
  day: string | number | boolean | undefined,
): string {
  const date = localDate(at, timezone);
  const weekday = day === undefined ? 1 : z.int().min(1).max(7).parse(day);
  const distance = ((weekday % 7) - new Date(date).getUTCDay() + 7) % 7 || 7;

  return new Date(date + distance * 86400000).toISOString().slice(0, 10);
}

export function createWorkflowDispatch(
  api: Pick<PluginApi, "sdk" | "realtime" | "log">,
  db: Db,
  imports: ReturnType<typeof createWorkflowImports>,
) {
  const inFlight = new Set<string>();

  async function requireCapability(
    input: z.infer<typeof admission>["binding"],
  ) {
    const result = await api.sdk.plugins.callRpc({
      pluginId: "state-machines",
      method: "sm_workflow_preflight",
      input,
      outputSchema: capability,
      signal: AbortSignal.timeout(10_000),
    });

    if (!result.available)
      throw new Error(
        result.message ?? "The selected CLI workflow model is unavailable.",
      );
  }

  async function prepare(automation: AutomationRow) {
    const identity = imports.scheduleTarget(automation);
    const target = await imports.get(identity);

    if (
      !target.confirmation ||
      !target.graphId ||
      !target.graphVersion ||
      !target.bindings
    ) {
      throw new Error(
        "Review and confirm the current workflow setup before starting.",
      );
    }

    const flow = target.package.flow;
    const { inputs, ...binding } = target.bindings;

    const timezoneInput = target.package.inputs.find(
      (input) => input.type === "timezone",
    );

    const selected = timezoneInput && inputs[timezoneInput.id];

    const timezone =
      typeof selected === "string"
        ? selected
        : target.package.trigger.kind === "weekly" ||
            target.package.trigger.kind === "schedule"
          ? target.package.trigger.timezone
          : "UTC";

    const weekly =
      flow.kind === "graph" && flow.engine === "weekly-content-feed";

    const facts =
      weekly && target.source?.kind !== "openseo"
        ? productFactLines(inputs["product-facts"])
        : [];

    const numberedFacts =
      facts.length >= WEEKLY_FACT_TARGET
        ? facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n")
        : undefined;

    const pinned = {
      projectId: target.projectId,
      importId: target.importId,
      graphId: target.graphId,
      graphVersion: target.graphVersion,
      executionDigest: target.executionDigest,
      bindingRevision: target.bindingRevision,
      binding,
      assets: {
        skills: target.package.skills.map(({ id, body }) => ({
          id,
          text: body,
        })),
        inputs:
          target.source?.kind === "openseo"
            ? {
                ...inputs,
                openSeoEvidence: JSON.stringify({
                  source: "OpenSEO saved keywords",
                  meaning:
                    "Saved search evidence for topic selection. It does not establish product claims.",
                  site: target.source.site,
                  retrievedAt: target.source.retrievedAt,
                  keywords: target.source.keywords.map(
                    ({ keyword, intent, volume }) => ({
                      keyword,
                      intent,
                      volume,
                    }),
                  ),
                }),
              }
            : inputs,
      },
    };

    return {
      skip(scheduledAt: number, now: number) {
        return weekly &&
          workflowWeek(scheduledAt, timezone) !== workflowWeek(now, timezone)
          ? "The intended week passed. Review it before retrying."
          : null;
      },
      persist(run: AutomationRunRow) {
        const current = imports.scheduleTarget(automation);

        if (
          current.bindingRevision !== target.bindingRevision ||
          current.confirmation !== target.confirmation ||
          current.graphId !== target.graphId ||
          current.graphVersion !== target.graphVersion
        ) {
          throw new Error("Workflow setup changed before claiming the run.");
        }

        const occurrenceKey = weekly
          ? `week:${workflowWeek(run.scheduledFor, timezone)}`
          : run.trigger === "schedule"
            ? `at:${run.scheduledFor}`
            : `run:${run.id}`;

        db.prepare(
          "INSERT INTO workflow_dispatches (run_id, admission) VALUES (?, ?)",
        ).run(
          run.id,
          JSON.stringify(
            admission.parse({
              ...pinned,
              occurrenceKey,
              assets: weekly
                ? {
                    ...pinned.assets,
                    inputs: {
                      ...pinned.assets.inputs,
                      ...(numberedFacts === undefined
                        ? {}
                        : { "product-facts": numberedFacts }),
                      weekStart: workflowWeek(run.scheduledFor, timezone),
                      calendarStart: nextDeliveryDate(
                        run.startedAt,
                        timezone,
                        inputs["delivery-weekday"],
                      ),
                      timezone,
                      references: z
                        .array(z.url({ protocol: /^https?$/ }))
                        .max(100)
                        .parse(
                          typeof inputs["reference-urls"] === "string"
                            ? inputs["reference-urls"]
                                .split(/\r?\n/)
                                .map((line) => line.trim())
                                .filter(Boolean)
                            : [],
                        ),
                    },
                  }
                : pinned.assets,
            }),
          ),
        );
      },
    };
  }

  async function reconcile(run: AutomationRunRow) {
    if (inFlight.has(run.id)) return;
    inFlight.add(run.id);

    try {
      const saved = z
        .object({
          admission: z.string(),
          graphRunId: workflowId.nullable(),
          executeRequestedAt: z.number().nullable(),
          lastError: z.string().nullable(),
        })
        .parse(
          db
            .prepare(
              `SELECT admission, graph_run_id AS graphRunId,
        execute_requested_at AS executeRequestedAt, last_error AS lastError
        FROM workflow_dispatches WHERE run_id = ?`,
            )
            .get(run.id),
        );

      const request: Admission = admission.parse(JSON.parse(saved.admission));

      const target = {
        projectId: request.projectId,
        importId: request.importId,
        occurrenceKey: request.occurrenceKey,
      };

      const call = <T>(
        method: string,
        input: Admission | typeof target,
        schema: z.ZodType<T>,
        timeoutMs: number,
      ) =>
        api.sdk.plugins.callRpc({
          pluginId: "state-machines",
          method,
          input,
          outputSchema: schema,
          signal: AbortSignal.timeout(timeoutMs),
        });

      const current = await call("sm_workflow_lookup", target, lookup, 10_000);

      if (!current?.run) await requireCapability(request.binding);

      let graph =
        current?.run ??
        (await call("sm_workflow_admit", request, runIdentity, 10_000));

      if (
        (saved.graphRunId !== null && graph.runId !== saved.graphRunId) ||
        graph.graphId !== request.graphId ||
        graph.graphVersion !== request.graphVersion ||
        graph.bindingRevision !== request.bindingRevision ||
        graph.executionDigest !== request.executionDigest
      ) {
        throw new Error(
          "The existing occurrence is pinned to a different workflow setup.",
        );
      }

      db.prepare(
        "UPDATE workflow_dispatches SET graph_run_id = ? WHERE run_id = ?",
      ).run(graph.runId, run.id);

      const resume =
        graph.status === "partial" &&
        run.trigger === "manual" &&
        saved.executeRequestedAt === null;

      if (graph.status === "ready" || graph.status === "running" || resume) {
        db.prepare(
          "UPDATE workflow_dispatches SET execute_requested_at = ? WHERE run_id = ?",
        ).run(Date.now(), run.id);
        graph = await call("sm_workflow_execute", target, runIdentity, 300_000);
      }

      if (graph.status === "ready" || graph.status === "running") return;
      const complete = graph.status === "complete";
      closeAutomationRun(db, {
        runId: run.id,
        status: complete ? "succeeded" : "failed",
        error: complete
          ? null
          : (graph.error ?? "The workflow did not finish."),
        output: JSON.stringify({
          graphRunId: graph.runId,
          contentStatus: graph.status,
          contentError: graph.error,
        }),
        now: Date.now(),
      });
      const owner = getAutomation(db, run.automationId);

      if (owner)
        publishAutomationChange(api, owner.projectId, [
          "automations-changed",
          "automation-runs-changed",
        ]);
    } catch (error) {
      const reason = errorMessage(error);

      const changed = db.transaction(() => {
        const receipt = db
          .prepare(`UPDATE workflow_dispatches SET last_error = ?
          WHERE run_id = ? AND last_error IS NOT ?`)
          .run(reason, run.id, reason);

        if (!receipt.changes) return false;
        db.prepare(
          "UPDATE automation_runs SET error = ? WHERE id = ? AND status = 'running'",
        ).run(reason, run.id);

        return true;
      })();

      if (changed)
        api.log.warn(
          `Workflow dispatch ${run.id} is awaiting reconciliation: ${reason}`,
        );
    } finally {
      inFlight.delete(run.id);
    }
  }

  return {
    requireCapability,
    prepare,
    reconcile,
    async artifacts(input: {
      projectId: string;
      importId: string;
      runId: string;
    }) {
      const row = z
        .object({ admission: z.string(), graphRunId: workflowId })
        .parse(
          db
            .prepare(
              "SELECT admission, graph_run_id AS graphRunId FROM workflow_dispatches WHERE run_id = ?",
            )
            .get(input.runId),
        );

      const request = admission.parse(JSON.parse(row.admission));

      if (
        request.projectId !== input.projectId ||
        request.importId !== input.importId
      )
        throw new Error("Run does not belong to this workflow.");

      const artifacts = await api.sdk.plugins.callRpc({
        pluginId: "state-machines",
        method: "sm_workflow_export",
        input: {
          projectId: request.projectId,
          importId: request.importId,
          occurrenceKey: request.occurrenceKey,
        },
        outputSchema: workflowArtifact,
        signal: AbortSignal.timeout(10_000),
      });

      if (
        artifacts.runId !== row.graphRunId ||
        artifacts.graphVersion !== request.graphVersion
      ) {
        throw new Error("Workflow artifact identity changed.");
      }

      return artifacts;
    },
    reconcilePending() {
      for (const run of listRunningAutomationRuns(db)) {
        if (run.runMode === "workflow") void reconcile(run);
      }
    },
  };
}
