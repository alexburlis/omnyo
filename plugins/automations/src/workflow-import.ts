import weeklyContentFeed from "../workflow-fixtures/weekly-content-feed.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  inspectWorkflowPackage,
  WORKFLOW_PACKAGE_MAX_BYTES,
  WORKFLOW_RELAY_ORIGIN,
  workflowDigest,
  workflowPackageSchema,
  type WorkflowPackageV1,
} from "./workflow-package.js";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  workflowSourceSnapshot,
  type workflowSourceSelection,
} from "./openseo-contract.js";
import {
  createAutomation,
  getAutomationForProject,
  parseAutomationExecution,
  parseAutomationTrigger,
  setAutomationEnabled,
  updateAutomation,
  type AutomationRow,
  type Db,
} from "./data.js";
import { compareWorkflowRevision } from "./workflow-revisions.js";
import type { AutomationTrigger } from "./rpc-types.js";
import {
  computeNextScheduledTime,
  validateOnceDefinition,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import {
  workflowBindings,
  workflowGraphSummary,
  workflowHash,
  workflowId,
  type workflowRevision,
  type workflowSource,
} from "./workflow-contract.js";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const reviewTTL = 10 * 60_000;

const noEnvironment = { values: () => undefined, keys: () => [] };

const graphIdentity = z.object({
  graphId: workflowId,
  graphVersion: z.int().positive(),
});

const rowSchema = z.strictObject({
  importId: workflowId,
  projectId: workflowId,
  graphId: workflowId.nullable(),
  graphVersion: z.int().positive().nullable(),
  automationId: workflowId.nullable(),
  text: z.string(),
  installDigest: workflowHash,
  packageDigest: workflowHash,
  executionDigest: workflowHash,
  bindingRevision: z.int().nonnegative(),
  encodedBindings: z.string().nullable(),
  encodedDraftInputs: z.string().nullable(),
  encodedSource: z.string().nullable(),
  scheduleEnabled: z.int().transform(Boolean),
  confirmation: workflowHash.nullable(),
});

const columns = `import_id AS importId, project_id AS projectId, graph_id AS graphId, graph_version AS graphVersion,
  automation_id AS automationId, package_text AS text, install_digest AS installDigest, package_digest AS packageDigest, execution_digest AS executionDigest,
  binding_revision AS bindingRevision, bindings AS encodedBindings, draft_inputs AS encodedDraftInputs, confirmation, approved_source AS encodedSource,
  COALESCE((SELECT enabled FROM automations WHERE id = workflow_imports.automation_id), 0) AS scheduleEnabled`;

export const workflowImportMigration = `CREATE TABLE workflow_imports (
  import_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  graph_id TEXT,
  graph_version INTEGER,
  automation_id TEXT UNIQUE,
  package_text TEXT NOT NULL,
  install_digest TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  binding_revision INTEGER NOT NULL DEFAULT 0,
  bindings TEXT,
  confirmation TEXT,
  installed_at INTEGER,
  UNIQUE(project_id, request_id)
)`;

export const workflowCliBindingMigration = `ALTER TABLE workflow_imports ADD COLUMN draft_inputs TEXT;
UPDATE automations SET enabled = 0, next_run_at = NULL,
last_error = 'Select a connected CLI and model, then preview and confirm the workflow again.'
WHERE id IN (SELECT automation_id FROM workflow_imports WHERE json_extract(bindings, '$.providerId') = 'apple-foundation');
UPDATE workflow_imports SET draft_inputs = json_extract(bindings, '$.inputs'), bindings = NULL,
confirmation = NULL, binding_revision = binding_revision + 1
WHERE json_extract(bindings, '$.providerId') = 'apple-foundation';
UPDATE automation_runs SET status = 'failed',
error = 'The saved Apple workflow binding is retired. Select a connected CLI and model, then confirm the setup before a new run.',
finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'running' AND id IN
(SELECT run_id FROM workflow_dispatches WHERE json_extract(admission, '$.binding.providerId') = 'apple-foundation');`;

type CopyTarget = { projectId: string; importId: string };

type Bindings = z.infer<typeof workflowBindings>;

type SourceSelection = z.infer<typeof workflowSourceSelection>;

type Snapshot = z.infer<typeof workflowSourceSnapshot>;

type Source = z.infer<typeof workflowSource>;

type Inspected = Awaited<ReturnType<typeof inspectWorkflowPackage>>;

type Row = z.infer<typeof rowSchema>;

type Revision = z.infer<typeof workflowRevision>;

const pendingRevisionSchema = z.strictObject({
  expectedDigest: workflowHash,
  packageDigest: workflowHash,
  executionDigest: workflowHash,
  source: z.enum(["local", "shared"]),
  text: z.string(),
});

export const workflowRevisionMigration = `CREATE TABLE workflow_revisions (
  import_id TEXT PRIMARY KEY REFERENCES workflow_imports(import_id) ON DELETE CASCADE,
  comparison_base TEXT NOT NULL,
  previous_package TEXT,
  expected_digest TEXT,
  pending_digest TEXT,
  pending_execution_digest TEXT,
  pending_source TEXT,
  pending_package TEXT
)`;

function selectCopy(db: Db, target: CopyTarget): Row {
  return rowSchema.parse(
    db
      .prepare(`SELECT ${columns} FROM workflow_imports
    WHERE project_id = ? AND import_id = ? AND installed_at IS NOT NULL`)
      .get(target.projectId, target.importId),
  );
}

function isWeekly(pkg: WorkflowPackageV1) {
  return (
    pkg.templateId === "weekly-content-feed" &&
    pkg.flow.kind === "graph" &&
    pkg.flow.engine === "weekly-content-feed"
  );
}

export async function openSeoCopyRevision(db: Db, target: CopyTarget) {
  const copy = await viewCopy(selectCopy(db, target));

  if (!isWeekly(copy.package))
    throw new Error("OpenSEO is available for Weekly Content Feed.");

  return copy.bindingRevision;
}

async function viewCopy(row: Row) {
  const {
    encodedBindings,
    encodedDraftInputs,
    encodedSource,
    text,
    installDigest: _installDigest,
    ...identity
  } = row;

  const checked = await inspectWorkflowPackage(encoder.encode(text));

  if (
    checked.packageDigest !== row.packageDigest ||
    checked.executionDigest !== row.executionDigest
  ) {
    throw new Error("Saved workflow package digest mismatch.");
  }

  const source =
    encodedSource === null
      ? null
      : workflowSourceSnapshot.parse(JSON.parse(encodedSource));

  return {
    ...identity,
    package: checked.package,
    source: encodedBindings === null ? null : source,
    draftSource: encodedBindings === null ? source : null,
    draftInputs:
      encodedDraftInputs === null
        ? null
        : workflowBindings.shape.inputs.parse(JSON.parse(encodedDraftInputs)),
    bindings:
      encodedBindings === null
        ? null
        : workflowBindings.parse(JSON.parse(encodedBindings)),
  };
}

async function readSource(source: Source): Promise<Uint8Array> {
  if (source.kind === "file") return encoder.encode(source.text);

  if (source.kind === "template")
    return encoder.encode(JSON.stringify(weeklyContentFeed));

  const url = new URL(
    `/api/workflow-shares/${source.shareId}/file`,
    WORKFLOW_RELAY_ORIGIN,
  );

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok || response.body === null)
    throw new Error("Workflow share is unavailable or expired.");
  const stream = response.body.getReader();
  const buffer = new Uint8Array(WORKFLOW_PACKAGE_MAX_BYTES);
  let offset = 0;

  try {
    for (;;) {
      const { value, done } = await stream.read();

      if (done) return buffer.subarray(0, offset);

      if (value.length > buffer.length - offset)
        throw new Error("Workflow share exceeds 256 KiB.");
      buffer.set(value, offset);
      offset += value.length;
    }
  } finally {
    await stream.cancel();
  }
}

function resolveTrigger(
  pkg: WorkflowPackageV1,
  timezone: string | undefined,
  now: number,
): AutomationTrigger {
  const { trigger } = pkg;

  switch (trigger.kind) {
    case "manual":
      return { triggerType: "once", runAt: now + 1 };
    case "once":
      return { triggerType: "once", runAt: Date.parse(trigger.at) };
    case "schedule":
      return {
        triggerType: "schedule",
        cron: trigger.cron,
        timezone: timezone ?? trigger.timezone,
      };
    case "weekly": {
      const [hours, minutes] = trigger.time.split(":");

      return {
        triggerType: "schedule",
        cron: [Number(minutes), Number(hours), "*", "*", trigger.weekday].join(
          " ",
        ),
        timezone: timezone ?? trigger.timezone,
      };
    }
  }
}

function resolveInputs(
  pkg: WorkflowPackageV1,
  provided: Bindings["inputs"],
  saved?: Bindings["inputs"],
): Bindings["inputs"] {
  if (
    Object.keys(provided).some(
      (key) => !pkg.inputs.some(({ id }) => key === id),
    )
  ) {
    throw new Error("Workflow setup includes an undeclared input.");
  }

  const weekly = isWeekly(pkg);

  return Object.fromEntries(
    [...pkg.inputs]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((definition) => {
        const { id, type } = definition;

        const ownText =
          weekly &&
          type === "text" &&
          id !== "output-language" &&
          id !== "output-format";

        const previous = weekly ? saved?.[id] : undefined;

        const value =
          provided[id] ?? previous ?? (ownText ? "" : definition.default);

        if (
          ownText &&
          (id === "startup" || id === "audience" || id === "product-facts") &&
          value !== previous &&
          (typeof value !== "string" || !value.trim())
        )
          throw new Error(
            "Enter your startup name, audience and product facts.",
          );

        switch (type) {
          case "text":
            return [definition.id, z.string().max(32768).parse(value)];
          case "integer":
            return [definition.id, z.int().min(1).max(50).parse(value)];
          case "boolean":
            return [definition.id, z.boolean().parse(value)];
          case "timezone":
            if (
              typeof value !== "string" ||
              value.length > 80 ||
              /^[+-]/.test(value)
            ) {
              throw new Error("Select an IANA timezone.");
            }

            new Intl.DateTimeFormat("en", { timeZone: value });

            return [definition.id, value];
        }
      }),
  );
}

export function createWorkflowImports(
  api: Pick<PluginApi, "sdk">,
  db: Db,
  selectEvidence?: (
    target: CopyTarget & { expectedRevision: number },
    selection: Extract<SourceSelection, { kind: "openseo" }>,
  ) => Promise<Snapshot>,
) {
  const reviews = new Map<string, { checked: Inspected; expiresAt: number }>();

  const get = async (target: CopyTarget) => viewCopy(selectCopy(db, target));

  function requireNoPendingRevision(importId: string) {
    if (
      db
        .prepare(
          "SELECT 1 FROM workflow_revisions WHERE import_id = ? AND pending_digest IS NOT NULL",
        )
        .get(importId)
    ) {
      throw new Error(
        "Finish reconciling the workflow revision before starting another run.",
      );
    }
  }

  const previews = new Map<string, { revision: number; expiresAt: number }>();

  function scheduleTarget(automation: AutomationRow) {
    const execution = parseAutomationExecution(automation, noEnvironment);

    if (execution.mode !== "workflow")
      throw new Error("Expected a workflow automation.");

    const row = selectCopy(db, {
      projectId: automation.projectId,
      importId: execution.importId,
    });

    requireNoPendingRevision(row.importId);

    if (
      row.automationId !== automation.id ||
      row.graphId !== execution.graphId ||
      row.graphVersion !== execution.graphVersion ||
      row.bindingRevision !== execution.bindingRevision
    ) {
      throw new Error("Workflow schedule does not match the current setup.");
    }

    return {
      ...row,
      package: workflowPackageSchema.parse(JSON.parse(row.text)),
      bindings:
        row.encodedBindings === null
          ? null
          : workflowBindings.parse(JSON.parse(row.encodedBindings)),
    };
  }

  function checkedReview(reviewId: string, packageDigest: string): Inspected {
    const cached = reviews.get(reviewId);

    if (
      !cached ||
      cached.expiresAt <= Date.now() ||
      cached.checked.packageDigest !== packageDigest
    ) {
      throw new Error(
        "Workflow review expired or changed. Review the package again.",
      );
    }

    return cached.checked;
  }

  function basePackage(row: Row): WorkflowPackageV1 {
    const stored = z
      .object({ text: z.string() })
      .optional()
      .parse(
        db
          .prepare(
            "SELECT comparison_base AS text FROM workflow_revisions WHERE import_id = ?",
          )
          .get(row.importId),
      );

    return workflowPackageSchema.parse(JSON.parse(stored?.text ?? row.text));
  }

  async function inspectSource(source: Source) {
    const checked = await inspectWorkflowPackage(await readSource(source));
    const now = Date.now();

    for (const [id, cached] of reviews)
      if (cached.expiresAt <= now) reviews.delete(id);

    if (reviews.size >= 64)
      throw new Error(
        "Too many pending workflow reviews. Open the file again after a review expires.",
      );
    const reviewId = randomUUID();
    reviews.set(reviewId, { checked, expiresAt: now + reviewTTL });

    const {
      package: pkg,
      packageDigest,
      executionDigest,
      capabilities,
    } = checked;

    return {
      reviewId,
      package: pkg,
      packageDigest,
      executionDigest,
      capabilities,
      source: source.kind,
    };
  }

  return {
    get,
    scheduleTarget,
    async prepareAutomation(
      target: CopyTarget,
      enabled: boolean,
      requireCapability: (binding: Omit<Bindings, "inputs">) => Promise<void>,
    ) {
      const copy = await get(target);

      if (
        !copy.graphId ||
        !copy.graphVersion ||
        !copy.confirmation ||
        !copy.bindings
      ) {
        throw new Error(
          "Review and confirm workflow setup before enabling or running it.",
        );
      }

      if (enabled && copy.package.trigger.kind === "manual")
        throw new Error("This workflow has a manual trigger.");
      const { hostId, providerId, model, inputs } = copy.bindings;
      await requireCapability({ hostId, providerId, model });
      const now = Date.now();

      const timezone = copy.package.inputs.find(
        (input) => input.type === "timezone",
      );

      const selected = timezone && inputs[timezone.id];

      const trigger = resolveTrigger(
        copy.package,
        typeof selected === "string" ? selected : undefined,
        now,
      );

      let nextRunAt: number | null = null;

      if (enabled) {
        if (trigger.triggerType === "once") {
          validateOnceDefinition({ runAt: trigger.runAt, now });
          nextRunAt = trigger.runAt;
        } else {
          validateScheduleDefinition(trigger);
          nextRunAt = computeNextScheduledTime({ ...trigger, now });
        }
      }

      const execution = {
        mode: "workflow" as const,
        importId: copy.importId,
        graphId: copy.graphId,
        graphVersion: copy.graphVersion,
        bindingRevision: copy.bindingRevision,
      };

      return db.transaction(() => {
        const current = selectCopy(db, target);
        requireNoPendingRevision(current.importId);

        if (
          current.bindingRevision !== copy.bindingRevision ||
          current.confirmation !== copy.confirmation ||
          current.graphId !== copy.graphId ||
          current.graphVersion !== copy.graphVersion
        ) {
          throw new Error("Workflow setup changed before scheduling.");
        }

        if (
          !current.automationId ||
          !getAutomationForProject(db, {
            projectId: copy.projectId,
            automationId: current.automationId,
          })
        ) {
          const row = createAutomation(db, {
            projectId: copy.projectId,
            name: copy.package.title,
            enabled,
            trigger,
            execution,
            runMode: "workflow",
            origin: "human",
            createdByThreadId: null,
            nextRunAt,
          });

          db.prepare(
            "UPDATE workflow_imports SET automation_id = ? WHERE import_id = ?",
          ).run(row.id, copy.importId);

          return row;
        }

        const row = updateAutomation(db, noEnvironment, {
          projectId: copy.projectId,
          automationId: current.automationId,
          patch: { execution, trigger, ...(enabled ? { nextRunAt } : {}) },
        });

        if (!row) throw new Error("Workflow schedule is unavailable.");

        if (!enabled) return row;

        return (
          setAutomationEnabled(db, {
            projectId: row.projectId,
            automationId: row.id,
            enabled: true,
            nextRunAt,
            lastError: null,
            resetConsecutiveFailures: true,
          }) ?? row
        );
      })();
    },
    async workflow_graphs(input: { projectId?: string }) {
      const response = await api.sdk.plugins.callRpc({
        pluginId: "state-machines",
        method: "sm_machine_list",
        input: { projectId: input.projectId ?? null, limit: 100 },
        outputSchema: z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            value: z.array(workflowGraphSummary),
          }),
          z.object({
            ok: z.literal(false),
            error: z.object({ message: z.string() }),
          }),
        ]),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) throw new Error(response.error.message);

      return response.value;
    },
    async workflow_options(input: { hostId?: string }) {
      const [projects, hosts] = await Promise.all([
        api.sdk.projects.list({ includePersonal: true }),
        api.sdk.hosts.list(),
      ]);

      const connectedHosts = hosts.filter(
        ({ status }) => status === "connected",
      );

      const models: {
        id: string;
        name: string;
        providerId: Bindings["providerId"];
        model: string;
      }[] = [];

      const modelErrors: string[] = [];
      const hostId = input.hostId;

      if (hostId && connectedHosts.some(({ id }) => id === hostId)) {
        const providers = await api.sdk.providers.list({
          hostId,
        });

        const supported = providers.filter(
          ({ id, available }) =>
            available && (id === "codex" || id === "claude-code"),
        );

        const catalogs = await Promise.allSettled(
          supported.map((provider) =>
            api.sdk.providers.models({ hostId, providerId: provider.id }),
          ),
        );

        for (const [index, result] of catalogs.entries()) {
          const provider = supported[index];

          if (result.status === "rejected" || result.value.modelLoadError) {
            modelErrors.push(
              `Could not load models from ${provider.displayName}. Check its connection on the selected device.`,
            );
            continue;
          }

          const catalog = result.value;

          const providerId = workflowBindings.shape.providerId.parse(
            provider.id,
          );

          for (const model of catalog.models) {
            if (model.routeProviderId && model.routeProviderId !== providerId)
              continue;
            models.push({
              id: `${providerId}:${model.model}`,
              name: `${provider.displayName} · ${model.displayName}`,
              providerId,
              model: model.model,
            });
          }
        }
      }

      return {
        projects: projects.map(({ id, name }) => ({ id, name })),
        hosts: connectedHosts.map(({ id, name }) => ({ id, name })),
        models,
        modelErrors,
      };
    },
    workflow_inspect: inspectSource,
    async workflow_previous(input: CopyTarget) {
      const copy = selectCopy(db, input);

      const previous = z
        .object({ text: z.string().nullable() })
        .optional()
        .parse(
          db
            .prepare(
              "SELECT previous_package AS text FROM workflow_revisions WHERE import_id = ?",
            )
            .get(copy.importId),
        );

      if (!previous?.text)
        throw new Error("This workflow has no previous version.");

      return inspectSource({ kind: "file", text: previous.text });
    },
    async workflow_install(input: {
      projectId: string;
      reviewId: string;
      packageDigest: string;
      requestId: string;
    }) {
      const lookup = db.prepare(
        `SELECT ${columns} FROM workflow_imports WHERE project_id = ? AND request_id = ?`,
      );

      const existing = lookup.get(input.projectId, input.requestId);
      let row: Row;
      const pending = reviews.get(input.reviewId);

      if (existing !== undefined) {
        row = rowSchema.parse(existing);

        if (row.installDigest !== input.packageDigest)
          throw new Error("Import request already belongs to another package.");
      } else {
        if (
          !pending ||
          pending.expiresAt <= Date.now() ||
          pending.checked.packageDigest !== input.packageDigest
        ) {
          throw new Error(
            "Workflow review expired or changed. Review the package again.",
          );
        }

        await api.sdk.projects.get({ projectId: input.projectId });

        const { canonicalBytes, packageDigest, executionDigest } =
          pending.checked;

        db.prepare(`INSERT INTO workflow_imports
          (import_id, project_id, request_id, package_text, install_digest, package_digest, execution_digest)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, request_id) DO NOTHING`).run(
          `wf_${randomUUID()}`,
          input.projectId,
          input.requestId,
          decoder.decode(canonicalBytes),
          packageDigest,
          packageDigest,
          executionDigest,
        );
        row = rowSchema.parse(lookup.get(input.projectId, input.requestId));

        if (row.installDigest !== input.packageDigest)
          throw new Error("Import request already belongs to another package.");
      }

      const installed = db.prepare(
        "SELECT 1 FROM workflow_imports WHERE import_id = ? AND installed_at IS NOT NULL",
      );

      if (installed.get(row.importId)) return get(row);
      const copy = await viewCopy(row);
      const { flow, skills } = copy.package;

      const graph =
        flow.kind === "script-requirement"
          ? null
          : await api.sdk.plugins.callRpc({
              pluginId: "state-machines",
              method: "sm_workflow_import",
              input: {
                importId: row.importId,
                projectId: row.projectId,
                packageDigest: row.packageDigest,
                executionDigest: row.executionDigest,
                flow,
                assets: {
                  skills: skills.map(({ id, body }) => ({ id, text: body })),
                  inputs: {},
                },
              },
              outputSchema: graphIdentity,
              signal: AbortSignal.timeout(12_000),
            });

      db.prepare(`UPDATE workflow_imports SET graph_id = ?, graph_version = ?, installed_at = ?
        WHERE import_id = ? AND installed_at IS NULL`).run(
        graph?.graphId ?? null,
        graph?.graphVersion ?? null,
        Date.now(),
        row.importId,
      );

      return get(row);
    },
    async workflow_list(input: { projectId: string }) {
      const rows = db
        .prepare(`SELECT ${columns} FROM workflow_imports WHERE project_id = ?
        AND installed_at IS NOT NULL ORDER BY installed_at, import_id`)
        .all(input.projectId);

      return Promise.all(rows.map((row) => viewCopy(rowSchema.parse(row))));
    },
    async workflow_bind(
      input: CopyTarget & {
        expectedRevision: number;
        bindings: Bindings & { source?: SourceSelection };
      },
    ) {
      const current = await get(input);

      if (current.bindingRevision !== input.expectedRevision)
        throw new Error("Workflow setup has changed. Open it again.");

      if (!current.graphId)
        throw new Error(
          "Replace the script requirement before running this workflow.",
        );
      const { source: selection, ...binding } = input.bindings;

      const inputs = resolveInputs(
        current.package,
        binding.inputs,
        current.bindings?.inputs ?? current.draftInputs ?? undefined,
      );

      const bindings = { ...binding, inputs };
      let source = current.source ?? current.draftSource;

      if (selection) {
        if (!isWeekly(current.package))
          throw new Error("This workflow does not support a source choice.");

        if (selection.kind === "openseo") {
          if (!selectEvidence) throw new Error("OpenSEO is unavailable.");
          source = await selectEvidence(input, selection);
        } else if (source || !current.bindings) {
          source = selection;
        }
      }

      const encodedSource = source === null ? null : JSON.stringify(source);
      const json = JSON.stringify(bindings);

      if (encoder.encode(json).byteLength > 64 * 1024) {
        throw new Error("Workflow setup text exceeds 64 KiB.");
      }

      const refreshed = db.transaction(() => {
        const row = selectCopy(db, input);

        if (row.bindingRevision !== input.expectedRevision)
          throw new Error("Workflow setup has changed. Open it again.");

        if (
          row.encodedSource === encodedSource &&
          (row.encodedBindings === json ||
            (isWeekly(current.package) &&
              isDeepStrictEqual(bindings, current.bindings)))
        )
          return row;
        db.prepare(`UPDATE workflow_imports SET bindings = ?, approved_source = ?, draft_inputs = NULL, binding_revision = binding_revision + 1,
          confirmation = NULL WHERE import_id = ?`).run(
          json,
          encodedSource,
          input.importId,
        );

        if (row.automationId)
          db.prepare(
            "UPDATE automations SET enabled = 0, next_run_at = NULL WHERE id = ?",
          ).run(row.automationId);

        return selectCopy(db, input);
      })();

      return viewCopy(refreshed);
    },
    async workflow_preview(input: CopyTarget) {
      const copy = await get(input);

      const example =
        copy.package.flow.kind === "graph" &&
        copy.package.flow.engine === "weekly-content-feed"
          ? [
              String(copy.bindings?.inputs.startup ?? "Your first week"),
              "Draft focus from your saved brief",
              ...String(copy.bindings?.inputs["product-facts"] ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, 7),
              "Run once to generate the articles and their review records.",
            ].join("\n")
          : "Example: Juniper Calendar uses only the inputs selected here and saves a text artifact with its run.";

      const now = Date.now();

      for (const [id, preview] of previews)
        if (preview.expiresAt <= now) previews.delete(id);

      if (previews.size >= 256)
        throw new Error(
          "Too many pending workflow previews. Preview again after another expires.",
        );
      previews.set(copy.importId, {
        revision: copy.bindingRevision,
        expiresAt: now + reviewTTL,
      });

      return { copy, example };
    },
    async workflow_confirm(
      input: CopyTarget & { expectedRevision: number; executionDigest: string },
    ) {
      const copy = await get(input);
      const preview = previews.get(copy.importId);

      if (
        !preview ||
        preview.expiresAt <= Date.now() ||
        preview.revision !== copy.bindingRevision ||
        !copy.bindings ||
        copy.bindingRevision !== input.expectedRevision ||
        copy.executionDigest !== input.executionDigest
      ) {
        throw new Error(
          "Review the current workflow instructions, inputs, and model before confirming.",
        );
      }

      const digest = await workflowDigest(
        encoder.encode(
          JSON.stringify({
            executionDigest: copy.executionDigest,
            bindingRevision: copy.bindingRevision,
            bindings: copy.bindings,
          }),
        ),
      );

      const change = db
        .prepare(`UPDATE workflow_imports SET confirmation = ?
        WHERE import_id = ? AND project_id = ? AND binding_revision = ? AND execution_digest = ?`)
        .run(
          digest,
          copy.importId,
          copy.projectId,
          copy.bindingRevision,
          copy.executionDigest,
        );

      if (change.changes !== 1)
        throw new Error("Workflow setup changed before confirmation.");

      return get(input);
    },
    async workflow_compare(
      input: CopyTarget & { reviewId: string; packageDigest: string },
    ) {
      const checked = checkedReview(input.reviewId, input.packageDigest);
      const row = selectCopy(db, input);
      const local = await viewCopy(row);

      return compareWorkflowRevision(
        basePackage(row),
        local.package,
        checked.package,
      );
    },
    async workflow_revise(input: Revision) {
      const stored = db.transaction(() => {
        const row = selectCopy(db, input);

        if (row.packageDigest === input.packageDigest) return null;

        if (row.packageDigest !== input.expectedPackageDigest)
          throw new Error("Workflow changed before the revision was saved.");

        const prior = db
          .prepare(`SELECT expected_digest AS expectedDigest, pending_digest AS packageDigest,
          pending_execution_digest AS executionDigest, pending_source AS source, pending_package AS text
          FROM workflow_revisions WHERE import_id = ? AND pending_digest IS NOT NULL`)
          .get(row.importId);

        if (prior !== undefined) {
          const pending = pendingRevisionSchema.parse(prior);

          if (
            pending.packageDigest !== input.packageDigest ||
            pending.source !== input.source
          ) {
            throw new Error(
              "Another workflow revision is awaiting reconciliation.",
            );
          }

          return { row, pending };
        }

        const review = checkedReview(input.reviewId, input.packageDigest);
        const previous = workflowPackageSchema.parse(JSON.parse(row.text));

        if (
          review.package.flow.kind === "script-requirement" &&
          previous.flow.kind !== "script-requirement"
        ) {
          throw new Error(
            "A runnable imported workflow cannot change to a script requirement.",
          );
        }

        if (input.source === "shared") {
          const original = basePackage(row);

          if (
            review.package.revision <= original.revision ||
            !compareWorkflowRevision(original, previous, review.package)
              .applyInPlace
          ) {
            throw new Error(
              "The shared revision conflicts with local changes or is older. Import it as a new copy.",
            );
          }
        }

        const pending = {
          expectedDigest: row.packageDigest,
          packageDigest: review.packageDigest,
          executionDigest: review.executionDigest,
          source: input.source,
          text: decoder.decode(review.canonicalBytes),
        };

        db.prepare(`INSERT INTO workflow_revisions
          (import_id, comparison_base, expected_digest, pending_digest, pending_execution_digest, pending_source, pending_package)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(import_id) DO UPDATE SET expected_digest = excluded.expected_digest,
          pending_digest = excluded.pending_digest, pending_execution_digest = excluded.pending_execution_digest,
          pending_source = excluded.pending_source, pending_package = excluded.pending_package`).run(
          row.importId,
          row.text,
          pending.expectedDigest,
          pending.packageDigest,
          pending.executionDigest,
          pending.source,
          pending.text,
        );

        if (
          row.executionDigest !== pending.executionDigest &&
          row.automationId
        ) {
          db.prepare(
            "UPDATE automations SET enabled = 0, next_run_at = NULL WHERE id = ?",
          ).run(row.automationId);
        }

        return { row, pending };
      })();

      if (!stored) return get(input);
      const { row, pending } = stored;

      const checked = await inspectWorkflowPackage(
        encoder.encode(pending.text),
      );

      if (
        checked.packageDigest !== pending.packageDigest ||
        checked.executionDigest !== pending.executionDigest
      ) {
        throw new Error("Pending workflow revision digest mismatch.");
      }

      const pkg = checked.package;
      const changed = pending.executionDigest !== row.executionDigest;
      let graph: { graphId: string | null; graphVersion: number | null } = row;

      if (changed && pkg.flow.kind !== "script-requirement") {
        const meta = {
          projectId: row.projectId,
          importId: row.importId,
          packageDigest: pending.packageDigest,
          executionDigest: pending.executionDigest,
          flow: pkg.flow,
          assets: {
            skills: pkg.skills.map(({ id, body }) => ({ id, text: body })),
            inputs: {},
          },
        };

        graph = await api.sdk.plugins.callRpc({
          pluginId: "state-machines",
          method: row.graphId ? "sm_workflow_revise" : "sm_workflow_import",
          input: row.graphId
            ? {
                ...meta,
                graphId: row.graphId,
                expectedGraphVersion: row.graphVersion,
              }
            : meta,
          outputSchema: graphIdentity,
          signal: AbortSignal.timeout(12_000),
        });
      }

      db.transaction(() => {
        const current = selectCopy(db, input);

        if (current.packageDigest === pending.packageDigest) return;

        if (current.packageDigest !== pending.expectedDigest)
          throw new Error("Workflow changed while saving its revision.");
        db.prepare(`UPDATE workflow_imports SET graph_id = ?, graph_version = ?, package_text = ?,
          package_digest = ?, execution_digest = ?, bindings = ?, confirmation = ?,
          draft_inputs = ?, approved_source = ?,
          binding_revision = binding_revision + ? WHERE import_id = ?`).run(
          graph.graphId,
          graph.graphVersion,
          pending.text,
          pending.packageDigest,
          pending.executionDigest,
          changed ? null : current.encodedBindings,
          changed ? null : current.confirmation,
          changed && current.encodedBindings
            ? JSON.stringify(
                workflowBindings.parse(JSON.parse(current.encodedBindings))
                  .inputs,
              )
            : current.encodedDraftInputs,
          isWeekly(pkg) ? current.encodedSource : null,
          Number(changed),
          row.importId,
        );
        db.prepare(`UPDATE workflow_revisions SET previous_package = ?, expected_digest = NULL, pending_digest = NULL,
          pending_execution_digest = NULL, pending_source = NULL, pending_package = NULL,
          comparison_base = CASE WHEN ? = 'shared' THEN ? ELSE comparison_base END WHERE import_id = ?`).run(
          row.text,
          pending.source,
          pending.text,
          row.importId,
        );
      })();

      return get(input);
    },
    async workflow_export(input: CopyTarget) {
      const row = selectCopy(db, input);
      await viewCopy(row);

      return { text: row.text, packageDigest: row.packageDigest };
    },
    async workflow_export_automation(input: {
      projectId: string;
      automationId: string;
      sanitizedPrompt?: string;
    }) {
      const source = getAutomationForProject(db, input);

      if (!source) throw new Error("Automation not found.");

      if (source.runMode === "workflow") {
        const target = scheduleTarget(source);

        return { text: target.text, packageDigest: target.packageDigest };
      }

      const trigger = parseAutomationTrigger(source.triggerConfig);

      if (source.runMode === "agent" && input.sanitizedPrompt === undefined) {
        throw new Error(
          "Review and supply a sanitized share copy of the prompt.",
        );
      }

      const checked = await inspectWorkflowPackage(
        encoder.encode(
          JSON.stringify({
            schemaVersion: 1,
            revision: 1,
            title: source.name,
            description: "Shared automation",
            inputs: [],
            trigger:
              trigger.triggerType === "once"
                ? { kind: "once", at: new Date(trigger.runAt).toISOString() }
                : {
                    kind: "schedule",
                    cron: trigger.cron,
                    timezone: trigger.timezone,
                  },
            flow:
              source.runMode === "agent"
                ? { kind: "prompt", prompt: input.sanitizedPrompt }
                : {
                    kind: "script-requirement",
                    description:
                      "Replace this local script requirement with a supported workflow action.",
                  },
            skills: [],
          }),
        ),
      );

      return {
        text: decoder.decode(checked.canonicalBytes),
        packageDigest: checked.packageDigest,
      };
    },
  };
}
