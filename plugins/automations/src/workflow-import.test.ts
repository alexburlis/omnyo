import { readFileSync } from "node:fs";
import { openSeoMigration } from "./openseo.js";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  claimAutomationScheduledRun,
  getAutomation,
  listRunningAutomationRuns,
  migrations,
} from "./data.js";
import {
  createWorkflowDispatch,
  workflowDispatchMigration,
  workflowWeek,
} from "./workflow-dispatch.js";
import {
  createWorkflowImports,
  workflowImportMigration,
  workflowRevisionMigration,
  workflowCliBindingMigration,
} from "./workflow-import.js";

const projectId = "project_recipient";

const original = {
  schemaVersion: 1,
  revision: 1,
  title: "Fictional workflow",
  description: "Examples only",
  skills: [],
  inputs: [{ id: "startup", label: "Startup", type: "text" }],
  trigger: {
    kind: "weekly",
    weekday: 1,
    time: "09:00",
    timezone: "America/Toronto",
  },
  flow: { kind: "prompt", prompt: "Summarize the recipient’s supplied notes." },
};

const source = { kind: "file", text: JSON.stringify(original) } as const;

const bindings = {
  hostId: "recipient-host",
  providerId: "codex",
  model: "test-model",
  inputs: { startup: "Mosslight" },
} as const;

const publishedWeekly = {
  kind: "file",
  text: readFileSync(
    new URL(
      "../workflow-fixtures/weekly-content-feed-release-2.omnyoworkflow",
      import.meta.url,
    ),
    "utf8",
  ),
} as const;

const publishedWeeklyDigest =
  "95c025bcf1ad32734e69fd000ca17abcba70b5508a8a57c760456d566133e5c5";

const recipientNotes = {
  startup: "Juniper Studio",
  audience: "Community garden coordinators",
  "product-facts": "Coordinators can record shared planting dates.",
};

const legacyMigrations = [
  ...migrations,
  workflowImportMigration,
  workflowDispatchMigration,
  workflowRevisionMigration,
  workflowCliBindingMigration,
];

function setup({ stageLegacyFixture = false } = {}) {
  const host = createFakePluginHost({
    pluginId: "automations",
    sdk: {
      projects: {
        async get({ projectId: id }) {
          return {
            id,
            kind: "standard",
            name: "Fictional recipient",
            createdAt: 1,
            updatedAt: 1,
            gitRemoteUrl: null,
            sources: [],
          };
        },
      },
    },
  });

  const db = host.api.storage.database();
  host.api.storage.migrate(
    db,
    stageLegacyFixture
      ? legacyMigrations
      : [...legacyMigrations, openSeoMigration],
  );

  if (stageLegacyFixture) db.exec(openSeoMigration);
  const imports = createWorkflowImports(host.api, db);
  const dispatch = createWorkflowDispatch(host.api, db, imports);

  return { host, db, imports, dispatch };
}

describe("portable workflow import and dispatch", () => {
  it("offers a working CLI when another provider cannot load its models", async () => {
    const test = setup();
    const sdk = test.host.harness.sdk;
    sdk.stub("projects.list", async () => []);
    sdk.stub("hosts.list", async () => [
      { id: "host", name: "Host", status: "connected" },
    ]);
    sdk.stub("providers.list", async () => [
      { id: "claude-code", available: true, displayName: "Claude Code" },
      { id: "codex", available: true, displayName: "Codex" },
    ]);
    sdk.stub(
      "providers.models",
      async ({ providerId }: { providerId: string }) => {
        if (providerId === "claude-code") throw new Error("Disconnected");

        return {
          models: [{ model: "selected-model", displayName: "Selected model" }],
        };
      },
    );

    try {
      const options = await test.imports.workflow_options({ hostId: "host" });
      expect(options.models.map(({ id }) => id)).toEqual([
        "codex:selected-model",
      ]);
      expect(options.modelErrors).toEqual([
        expect.stringContaining("Claude Code"),
      ]);
    } finally {
      await test.host.harness.dispose();
    }
  });

  it("requires recipient notes for a fresh copy of the published weekly download", async () => {
    const { host, imports } = setup();
    host.harness.sdk.stub("plugins.callRpc", async () => ({
      graphId: "weekly_graph",
      graphVersion: 1,
    }));

    try {
      const review = await imports.workflow_inspect(publishedWeekly);
      expect(review.packageDigest).toBe(publishedWeeklyDigest);

      const copy = await imports.workflow_install({
        projectId,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "fresh-weekly",
      });

      const input = { projectId, importId: copy.importId, expectedRevision: 0 };

      await expect(
        imports.workflow_bind({
          ...input,
          bindings: { ...bindings, inputs: {} },
        }),
      ).rejects.toThrow("Enter your startup name, audience and product facts");
      await expect(
        imports.workflow_bind({
          ...input,
          bindings: {
            ...bindings,
            inputs: { ...recipientNotes, audience: "  " },
          },
        }),
      ).rejects.toThrow("Enter your startup name, audience and product facts");

      const result = await imports.workflow_bind({
        ...input,
        bindings: { ...bindings, inputs: recipientNotes },
      });

      expect(result.bindings?.inputs).toMatchObject({
        ...recipientNotes,
        terminology: "",
        exclusions: "",
        "output-language": "English",
        "output-format": "Markdown",
        "delivery-weekday": 4,
        timezone: "America/Toronto",
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it("reopens a confirmed release-two copy and dispatches seven plain facts on its existing schedule", async () => {
    const { host, db, imports, dispatch } = setup({ stageLegacyFixture: true });
    let reopened: typeof host | undefined;

    const facts = Array.from(
      { length: 7 },
      (_, index) => `Plain product fact ${index + 1}.`,
    );

    const invoke = vi.fn(
      async ({
        method,
        input,
      }: {
        method: string;
        input: Record<string, unknown>;
      }) => {
        if (method === "sm_workflow_import")
          return { graphId: "legacy_graph", graphVersion: 1 };

        if (method === "sm_workflow_preflight") return { available: true };

        if (method === "sm_workflow_lookup") return { run: null };

        if (method === "sm_workflow_admit" || method === "sm_workflow_execute")
          return {
            runId: "legacy_run",
            graphId: "legacy_graph",
            graphVersion: 1,
            bindingRevision: 1,
            executionDigest: input.executionDigest,
            status: method === "sm_workflow_admit" ? "ready" : "complete",
            error: null,
          };
        throw new Error("Unexpected graph RPC " + method);
      },
    );

    host.harness.sdk.stub("plugins.callRpc", invoke);

    try {
      const review = await imports.workflow_inspect(publishedWeekly);

      const copy = await imports.workflow_install({
        projectId,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "published-legacy",
      });

      const target = { projectId, importId: copy.importId };

      const oldInputs = {
        ...Object.fromEntries(
          review.package.inputs.map(({ id, default: value }) => [
            id,
            value ?? "",
          ]),
        ),
        ...recipientNotes,
        "product-facts": facts.join("\n"),
      };

      const bound = await imports.workflow_bind({
        ...target,
        expectedRevision: 0,
        bindings: { ...bindings, inputs: oldInputs },
      });

      await imports.workflow_preview(target);

      const approved = await imports.workflow_confirm({
        ...target,
        expectedRevision: bound.bindingRevision,
        executionDigest: review.executionDigest,
      });

      const schedule = await imports.prepareAutomation(
        target,
        true,
        dispatch.requireCapability,
      );

      const bindingBytes = db
        .prepare("SELECT bindings FROM workflow_imports WHERE import_id = ?")
        .get(copy.importId);

      db.exec(
        "DROP TABLE workflow_openseo_connections; ALTER TABLE workflow_imports DROP COLUMN approved_source;",
      );
      reopened = await host.harness.reload((api) => {
        api.storage.migrate(api.storage.database(), [
          ...legacyMigrations,
          openSeoMigration,
        ]);
      });

      const activeDb = reopened.api.storage.database();
      const after = createWorkflowImports(reopened.api, activeDb);
      const listed = await after.workflow_list({ projectId });
      expect(listed).toEqual([
        expect.objectContaining({
          ...approved,
          automationId: schedule.id,
          packageDigest: publishedWeeklyDigest,
          executionDigest: review.executionDigest,
          source: null,
          draftSource: null,
          scheduleEnabled: true,
        }),
      ]);
      expect(getAutomation(activeDb, schedule.id)).toEqual(schedule);
      expect(schedule.triggerType).toBe("schedule");
      expect(JSON.parse(schedule.triggerConfig)).toMatchObject({
        cron: "0 9 * * 1",
        timezone: "America/Toronto",
      });

      const unchanged = await after.workflow_bind({
        ...target,
        expectedRevision: bound.bindingRevision,
        bindings: {
          ...bindings,
          inputs: { startup: recipientNotes.startup },
          source: { kind: "notes" },
        },
      });

      expect(unchanged).toEqual(listed[0]);
      expect(
        activeDb
          .prepare("SELECT bindings FROM workflow_imports WHERE import_id = ?")
          .get(copy.importId),
      ).toEqual(bindingBytes);
      expect(getAutomation(activeDb, schedule.id)).toEqual(schedule);

      reopened.harness.sdk.stub("plugins.callRpc", invoke);

      const restartedDispatch = createWorkflowDispatch(
        reopened.api,
        activeDb,
        after,
      );

      if (schedule.nextRunAt === null)
        throw new Error("Expected a scheduled occurrence.");
      const prepared = await restartedDispatch.prepare(schedule);

      const run = claimAutomationScheduledRun(activeDb, {
        automationId: schedule.id,
        expectedNextRunAt: schedule.nextRunAt,
        newNextRunAt: schedule.nextRunAt + 7 * 86_400_000,
        now: schedule.nextRunAt,
        persistClaim: prepared.persist,
      });

      if (!run.advanced) throw new Error("Expected a scheduled run claim.");
      await restartedDispatch.reconcile(run.run);
      expect(
        invoke.mock.calls.find(
          ([{ method }]) => method === "sm_workflow_admit",
        )?.[0].input,
      ).toMatchObject({
        bindingRevision: bound.bindingRevision,
        executionDigest: review.executionDigest,
        assets: {
          inputs: {
            ...oldInputs,
            "product-facts": facts
              .map((fact, index) => `${index + 1}. ${fact}`)
              .join("\n"),
            references: [],
          },
        },
      });

      const admission = invoke.mock.calls.find(
        ([{ method }]) => method === "sm_workflow_admit",
      )?.[0].input;

      expect(JSON.stringify(admission)).not.toContain("openSeoEvidence");
      expect(getAutomation(activeDb, schedule.id)?.lastRunStatus).toBe(
        "succeeded",
      );

      const edited = await after.workflow_bind({
        ...target,
        expectedRevision: bound.bindingRevision,
        bindings: {
          ...bindings,
          inputs: { audience: "Neighborhood garden groups" },
        },
      });

      expect(edited).toMatchObject({
        bindingRevision: 2,
        confirmation: null,
        scheduleEnabled: false,
        bindings: {
          inputs: { ...oldInputs, audience: "Neighborhood garden groups" },
        },
      });
    } finally {
      await (reopened ?? host).harness.dispose();
    }
  });

  it("retires old Apple bindings once and keeps schedules off until reconfirmed", async () => {
    const test = setup();
    test.host.harness.sdk.stub("plugins.callRpc", async () => ({
      graphId: "graph_legacy",
      graphVersion: 1,
    }));

    try {
      const review = await test.imports.workflow_inspect(source);

      const copy = await test.imports.workflow_install({
        projectId,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "legacy",
      });

      await test.imports.workflow_bind({
        projectId,
        importId: copy.importId,
        expectedRevision: 0,
        bindings,
      });
      await test.imports.workflow_preview({
        projectId,
        importId: copy.importId,
      });
      await test.imports.workflow_confirm({
        projectId,
        importId: copy.importId,
        expectedRevision: 1,
        executionDigest: copy.executionDigest,
      });

      const automation = await test.imports.prepareAutomation(
        { projectId, importId: copy.importId },
        true,
        async () => {},
      );

      const legacyInputs = {
        ...bindings.inputs,
        "product-facts": "Original facts",
        exclusions: "No invented claims",
        timezone: "America/Toronto",
      };

      test.db
        .prepare("UPDATE workflow_imports SET bindings = ? WHERE import_id = ?")
        .run(
          JSON.stringify({
            ...bindings,
            providerId: "apple-foundation",
            model: "on-device",
            inputs: legacyInputs,
          }),
          copy.importId,
        );
      test.db
        .prepare(
          `INSERT INTO automation_runs (id, automation_id, run_mode, status, trigger, scheduled_for, started_at) VALUES (?, ?, 'workflow', 'running', 'manual', ?, ?)`,
        )
        .run("retired-run", automation.id, Date.now(), Date.now());
      test.db
        .prepare(
          "INSERT INTO workflow_dispatches (run_id, admission) VALUES (?, ?)",
        )
        .run(
          "retired-run",
          JSON.stringify({ binding: { providerId: "apple-foundation" } }),
        );
      test.db.exec("ALTER TABLE workflow_imports DROP COLUMN draft_inputs");
      test.db.exec(workflowCliBindingMigration);
      const imports = createWorkflowImports(test.host.api, test.db);
      expect(listRunningAutomationRuns(test.db)).toEqual([]);
      expect(
        test.db
          .prepare(
            "SELECT status, error FROM automation_runs WHERE id = 'retired-run'",
          )
          .get(),
      ).toMatchObject({
        status: "failed",
        error: expect.stringContaining("retired"),
      });
      const retired = await imports.get({ projectId, importId: copy.importId });
      expect(retired).toMatchObject({
        bindings: null,
        confirmation: null,
        bindingRevision: 2,
        draftInputs: legacyInputs,
      });
      expect(getAutomation(test.db, automation.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
      });
      await expect(
        imports.prepareAutomation(
          { projectId, importId: copy.importId },
          true,
          async () => {},
        ),
      ).rejects.toThrow("Review and confirm");
      createWorkflowImports(test.host.api, test.db);
      expect(
        (await imports.get({ projectId, importId: copy.importId }))
          .bindingRevision,
      ).toBe(2);
    } finally {
      await test.host.harness.dispose();
    }
  });

  it("keeps review, installation and preview inert while pinning new recipient input", async () => {
    const sender = setup();
    const recipient = setup();

    const invoke = vi.fn(async () => ({
      graphId: "graph_new",
      graphVersion: 1,
    }));

    recipient.host.harness.sdk.stub("plugins.callRpc", invoke);

    try {
      const outgoing = await sender.imports.workflow_inspect(source);

      const review = await recipient.imports.workflow_inspect({
        kind: "file",
        text: JSON.stringify(outgoing.package),
      });

      expect(review.packageDigest).toBe(outgoing.packageDigest);
      expect(invoke).not.toHaveBeenCalled();

      const install = {
        projectId,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "first-import",
      };

      const copy = await recipient.imports.workflow_install(install);
      expect(copy).toMatchObject({
        projectId,
        graphVersion: 1,
        automationId: null,
        bindings: null,
        confirmation: null,
      });
      expect((await recipient.imports.workflow_install(install)).importId).toBe(
        copy.importId,
      );
      expect(invoke).toHaveBeenCalledTimes(1);
      const target = { projectId, importId: copy.importId };

      const bound = await recipient.imports.workflow_bind({
        ...target,
        expectedRevision: 0,
        bindings,
      });

      const confirmation = {
        ...target,
        expectedRevision: bound.bindingRevision,
        executionDigest: copy.executionDigest,
      };

      await expect(
        recipient.imports.workflow_confirm(confirmation),
      ).rejects.toThrow("Review the current");
      await expect(
        recipient.imports.workflow_preview(target),
      ).resolves.toMatchObject({
        copy: { automationId: null, confirmation: null },
      });
      const approved = await recipient.imports.workflow_confirm(confirmation);
      expect(approved.confirmation).toMatch(/^[a-f0-9]{64}$/);

      const edited = await recipient.imports.workflow_bind({
        ...target,
        expectedRevision: approved.bindingRevision,
        bindings: { ...bindings, inputs: { startup: "Spruce Studio" } },
      });

      expect(edited.confirmation).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(
        recipient.db.prepare("SELECT count(*) AS total FROM automations").get(),
      ).toEqual({ total: 0 });
    } finally {
      await sender.host.harness.dispose();
      await recipient.host.harness.dispose();
    }
  });

  it.each(["complete", "partial", "failed"] as const)(
    "records the %s outcome after recovering a lost acknowledgment without a second admission",
    async (outcome) => {
      const { host, db, imports, dispatch } = setup();
      let graphRun: Record<string, unknown> | null = null;
      let admitted = false;

      const invoke = vi.fn(
        async ({
          method,
          input,
        }: {
          method: string;
          input: Record<string, unknown>;
        }) => {
          if (method === "sm_workflow_import")
            return { graphId: "graph_new", graphVersion: 1 };

          if (method === "sm_workflow_preflight") return { available: true };

          if (method === "sm_workflow_lookup")
            return { run: admitted ? graphRun : null };

          if (method === "sm_workflow_admit") {
            if (admitted) throw new Error("duplicate graph start");
            admitted = true;
            graphRun = {
              ...input,
              runId: "graph_run",
              status: "ready",
              error: null,
            };
            throw new Error("lost acknowledgment");
          }

          if (method === "sm_workflow_execute")
            return {
              ...graphRun,
              status: outcome,
              error: outcome === "complete" ? null : "Drafting stopped",
            };
          throw new Error(`Unexpected graph RPC ${method}`);
        },
      );

      host.harness.sdk.stub("plugins.callRpc", invoke);

      try {
        const review = await imports.workflow_inspect(source);

        const copy = await imports.workflow_install({
          projectId,
          reviewId: review.reviewId,
          packageDigest: review.packageDigest,
          requestId: "install",
        });

        const target = { projectId, importId: copy.importId };

        const bound = await imports.workflow_bind({
          ...target,
          expectedRevision: 0,
          bindings,
        });

        await imports.workflow_preview(target);
        await imports.workflow_confirm({
          ...target,
          expectedRevision: bound.bindingRevision,
          executionDigest: bound.executionDigest,
        });

        const schedule = await imports.prepareAutomation(
          target,
          true,
          dispatch.requireCapability,
        );

        const scheduledFor = schedule.nextRunAt;

        if (scheduledFor === null)
          throw new Error("Expected a next occurrence");
        const prepared = await dispatch.prepare(schedule);

        const request = {
          automationId: schedule.id,
          expectedNextRunAt: scheduledFor,
          newNextRunAt: scheduledFor + 7 * 86400000,
          now: scheduledFor,
          persistClaim: prepared.persist,
        };

        const claim = claimAutomationScheduledRun(db, request);
        expect(claim.advanced).toBe(true);
        expect(claimAutomationScheduledRun(db, request)).toEqual({
          advanced: false,
        });

        if (!claim.advanced) throw new Error("Expected an admitted claim");
        await dispatch.reconcile(claim.run);
        expect(listRunningAutomationRuns(db)).toHaveLength(1);

        const restartedOwner = createWorkflowDispatch(
          host.api,
          db,
          createWorkflowImports(host.api, db),
        );

        await restartedOwner.reconcile(claim.run);
        expect(listRunningAutomationRuns(db)).toHaveLength(0);
        expect(getAutomation(db, schedule.id)?.lastRunStatus).toBe(
          outcome === "complete" ? "succeeded" : "failed",
        );
        expect(
          invoke.mock.calls.filter(
            ([args]) => args.method === "sm_workflow_admit",
          ),
        ).toHaveLength(1);
        expect(
          invoke.mock.calls.filter(
            ([args]) => args.method === "sm_workflow_execute",
          ),
        ).toHaveLength(1);
      } finally {
        await host.harness.dispose();
      }
    },
  );

  it("preserves confirmation for presentation edits and revokes it for new executable content", async () => {
    const { host, db, imports, dispatch } = setup();

    const invoke = vi.fn(async ({ method }: { method: string }) => {
      if (method === "sm_workflow_import")
        return { graphId: "graph_new", graphVersion: 1 };

      if (method === "sm_workflow_revise")
        return { graphId: "graph_new", graphVersion: 2 };

      if (method === "sm_workflow_preflight") return { available: true };
      throw new Error("Unexpected graph RPC " + method);
    });

    host.harness.sdk.stub("plugins.callRpc", invoke);

    try {
      const review = await imports.workflow_inspect(source);

      const install = {
        projectId,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "revision-install",
      };

      const copy = await imports.workflow_install(install);
      const target = { projectId, importId: copy.importId };

      const bound = await imports.workflow_bind({
        ...target,
        expectedRevision: 0,
        bindings,
      });

      await imports.workflow_preview(target);

      const confirmed = await imports.workflow_confirm({
        ...target,
        expectedRevision: bound.bindingRevision,
        executionDigest: bound.executionDigest,
      });

      const schedule = await imports.prepareAutomation(
        target,
        true,
        dispatch.requireCapability,
      );

      const named = await imports.workflow_inspect({
        kind: "file",
        text: JSON.stringify({ ...original, title: "Preferred display name" }),
      });

      const presentation = await imports.workflow_revise({
        ...target,
        source: "local",
        reviewId: named.reviewId,
        expectedPackageDigest: confirmed.packageDigest,
        packageDigest: named.packageDigest,
      });

      expect(presentation.confirmation).toBe(confirmed.confirmation);
      expect(presentation.graphVersion).toBe(1);
      expect(getAutomation(db, schedule.id)?.enabled).toBe(true);

      const changed = await imports.workflow_inspect({
        kind: "file",
        text: JSON.stringify({
          ...presentation.package,
          flow: { kind: "prompt", prompt: "Write a different summary." },
        }),
      });

      const revised = await imports.workflow_revise({
        ...target,
        source: "local",
        reviewId: changed.reviewId,
        expectedPackageDigest: presentation.packageDigest,
        packageDigest: changed.packageDigest,
      });

      expect(revised).toMatchObject({
        graphVersion: 2,
        bindings: null,
        confirmation: null,
      });
      expect(getAutomation(db, schedule.id)?.enabled).toBe(false);
      expect((await imports.workflow_previous(target)).packageDigest).toBe(
        presentation.packageDigest,
      );
      expect((await imports.workflow_install(install)).importId).toBe(
        copy.importId,
      );
      expect(
        invoke.mock.calls.filter(
          ([args]) => args.method === "sm_workflow_revise",
        ),
      ).toHaveLength(1);
    } finally {
      await host.harness.dispose();
    }
  });

  it("separates Toronto weeks at Monday midnight across the DST transition", () => {
    expect(
      workflowWeek(Date.parse("2026-03-09T03:59:00Z"), "America/Toronto"),
    ).toBe("2026-03-02");
    expect(
      workflowWeek(Date.parse("2026-03-09T04:00:00Z"), "America/Toronto"),
    ).toBe("2026-03-09");
  });
});
