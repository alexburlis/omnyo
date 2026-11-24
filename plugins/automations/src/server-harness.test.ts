import { z } from "zod";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import { automationScriptHostContract } from "./script-host-contract.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
  PluginContextStaleError,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import plugin from "./server.js";
import { openSeoRpcContract } from "./openseo-contract.js";
import { workflowRpcContract } from "./workflow-contract.js";
import { AutomationEnvStore } from "./env-secrets.js";
import { createAutomationService } from "./service.js";
import {
  automationListResponseSchema,
  automationsOverviewResponseSchema,
  automationDetailResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  type AutomationRunResponse,
} from "./rpc-types.js";

function storedExecution(host: FakePluginHost, automationId: string): unknown {
  const row = host.api.storage
    .database()
    .prepare("SELECT execution FROM automations WHERE id = ?")
    .get(automationId) as { execution: string };

  return JSON.parse(row.execution);
}

function observeCompletedRun(host: FakePluginHost, automationId: string) {
  const { harness } = host;
  const publish = host.api.realtime.publish.bind(host.api.realtime);
  const publishSpy = vi.spyOn(host.api.realtime, "publish");

  const completedRun = new Promise<AutomationRunResponse>((resolve, reject) => {
    publishSpy.mockImplementation((...args) => {
      publish(...args);
      void harness
        .callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId,
        })
        .then((result) => {
          const { runs } = automationRunListResponseSchema.parse(result);

          if (runs[0] !== undefined && runs[0].status !== "running") {
            resolve(runs[0]);
          }
        })
        .catch(reject);
    });
  });

  return { completedRun, stop: () => publishSpy.mockRestore() };
}

function storedScriptPathPattern(automationId: string): RegExp {
  const suffix = join(sep, "scripts", automationId, "script.sh");

  return new RegExp(`${suffix.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`);
}

const PROJECT_ID = "proj_test";

const MISSING_PROJECT_ID = "proj_missing";

const DELETED_PROJECT_ID = "proj_deleted";

const THREAD_ID = "thr_target";

const SECTION_ID = "sec_reviews";

const rpcMethods = [
  "automations_overview",
  "automations_list",
  "automations_get",
  "automations_create",
  "automations_update",
  "automations_delete",
  "automations_pause",
  "automations_resume",
  "automations_run",
  "automations_runs",
  ...Object.keys(workflowRpcContract),
  ...Object.keys(openSeoRpcContract),
].sort();

function project(projectId = PROJECT_ID) {
  return {
    id: projectId,
    kind: "standard" as const,
    name: "Test Project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    sources: [
      {
        id: `psrc_${projectId}`,
        projectId,
        type: "local_path" as const,
        hostId: "host_fake",
        path: "/test/project",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

async function bootAutomationsPlugin(
  declaredPermissionModes: Array<"accept-edits" | "auto" | "full"> = [
    "accept-edits",
    "auto",
    "full",
  ],
  routedPermissionModes?: Array<"accept-edits" | "auto" | "full">,
  loopbackBaseUrl?: string,
): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "automations",
    loopbackBaseUrl,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_fake" }) },
      projects: {
        async get({ projectId }) {
          if (projectId === PROJECT_ID) return project(projectId);
          throw new Error("Project not found");
        },
        async list() {
          return [project()];
        },
      },
      threadSections: {
        async list() {
          return [
            {
              id: SECTION_ID,
              name: "Reviews",
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
      },
      hosts: {
        async list() {
          return [{ id: "host_test", status: "connected" }];
        },
      },
      providers: {
        async list(routing) {
          const permissionModes =
            routing?.environmentId === "env_routed" &&
            routedPermissionModes !== undefined
              ? routedPermissionModes
              : declaredPermissionModes;

          return [
            { id: "codex", capabilities: { permissionModes } },
            {
              id: "claude",
              capabilities: { permissionModes: ["auto", "full"] },
            },
          ] as never;
        },
      },
      threads: {
        async get({ threadId }) {
          return {
            ...makeThreadResponse({ id: threadId }),
            id: threadId,
            archivedAt: null,
            deletedAt: null,
            sectionId: threadId === THREAD_ID ? SECTION_ID : null,
            status: "idle",
          };
        },
        async send() {
          return { ok: true };
        },
        async spawn() {
          return {
            id: "thr_spawned",
            archivedAt: null,
            deletedAt: null,
            status: "idle",
          };
        },
      },
    },
  });

  await plugin(host.api);

  return host;
}

function agentExecution(targetThreadId?: string) {
  return {
    mode: "agent",
    prompt: "summarize the inbox",
    providerId: "codex",
    model: "gpt-5",
    permissionMode: "accept-edits",
    environment: { type: "project-default" },
    ...(targetThreadId ? { targetThreadId } : {}),
  };
}

function oneShotTrigger() {
  return { triggerType: "once", runAt: Date.now() + 60_000 };
}

async function createAgentAutomation(
  harness: FakePluginHost["harness"],
  options: {
    name?: string;
    trigger?:
      | ReturnType<typeof oneShotTrigger>
      | { triggerType: "schedule"; cron: string; timezone: string };
    targetThreadId?: string;
  } = {},
) {
  return automationDetailResponseSchema.parse(
    await harness.callRpc("automations_create", {
      projectId: PROJECT_ID,
      name: options.name ?? "Agent automation",
      enabled: true,
      trigger: options.trigger ?? oneShotTrigger(),
      execution: agentExecution(options.targetThreadId),
      origin: "human",
    }),
  );
}

function signalKinds(host: FakePluginHost) {
  return host.harness.realtimeSignals
    .filter((signal) => signal.channel === "automations")
    .map((signal) => signal.payload)
    .filter(
      (payload): payload is { projectId: string; kind: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "projectId" in payload &&
        "kind" in payload,
    )
    .map((payload) => payload.kind);
}

describe("automations server plugin harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("boots through server.ts and registers rpc, cli, thread events, and sweep service", async () => {
    const { harness } = await bootAutomationsPlugin();

    expect([...harness.registrations.rpcMethods].sort()).toEqual(rpcMethods);
    expect(harness.registrations.cli?.name).toBe("automation");
    expect(
      harness.registrations.services.map((service) => service.name),
    ).toEqual(["automation-sweep"]);
    expect(harness.registrations.threadEventHandlers).toMatchObject({
      "thread.idle": 1,
      "thread.failed": 1,
      "thread.deleted": 1,
      "turn.failed": 1,
    });

    await harness.dispose();
  });

  it("restricts saved OpenSEO evidence to an authorized copy and freezes only approved rows", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const key = "oseo_fixture_only_workspace";
    const requests: Array<{ name: string; arguments: unknown }> = [];
    let rejectKey = false;
    let oversized = false;
    let providerError = false;

    const fetchOpenSeo = vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toBe("https://app.openseo.so/mcp");
      expect(request.redirect).toBe("error");
      expect(new Headers(request.headers).get("authorization")).toBe(
        `Bearer ${key}`,
      );

      if (rejectKey) return new Response(null, { status: 401 });

      if (providerError)
        return new Response(`Provider echoed ${key}`, { status: 500 });
      const message = JSON.parse(String(request.body));

      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });

      if (message.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18" },
        });
      }

      expect(message.method).toBe("tools/call");
      const { name, arguments: args } = message.params;
      requests.push({ name, arguments: args });

      if (oversized)
        return new Response("x".repeat(600_000), {
          headers: { "content-type": "application/json" },
        });

      const structuredContent =
        name === "list_projects"
          ? {
              projects: [
                {
                  id: "provider-project",
                  name: "Mosslight",
                  domain: "example.org",
                },
                {
                  id: "other-project",
                  name: "Another site",
                  domain: "example.net",
                },
              ],
            }
          : {
              rows: [
                {
                  id: "row-1",
                  keyword: "neighborhood seed swap",
                  intent: "informational",
                  searchVolume: null,
                },
                {
                  id: "row-2",
                  keyword: "seed packets",
                  intent: null,
                  searchVolume: 17,
                },
              ],
            };

      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { structuredContent },
      });
    });

    vi.stubGlobal("fetch", fetchOpenSeo);
    let admitted: unknown;
    harness.sdk.stub("plugins.callRpc", async ({ method, input }) => {
      if (method === "sm_workflow_import")
        return { graphId: "graph_weekly", graphVersion: 1 };

      if (method === "sm_workflow_preflight") return { available: true };

      if (method === "sm_workflow_lookup") return { run: null };

      if (method === "sm_workflow_admit") {
        admitted = input;

        return {
          runId: "graph_run",
          graphId: "graph_weekly",
          graphVersion: 1,
          bindingRevision: 1,
          executionDigest: z
            .object({ executionDigest: z.string() })
            .parse(input).executionDigest,
          status: "ready",
          error: null,
        };
      }

      if (method === "sm_workflow_execute")
        return {
          runId: "graph_run",
          graphId: "graph_weekly",
          graphVersion: 1,
          bindingRevision: 1,
          executionDigest: z
            .object({ executionDigest: z.string() })
            .parse(input).executionDigest,
          status: "complete",
          error: null,
        };
      throw new Error("Unexpected RPC: " + method);
    });

    try {
      const packageReview = await harness.callRpc("workflow_inspect", {
        kind: "template",
        template: "weekly-content-feed",
      });

      const review = z
        .object({
          reviewId: z.string(),
          packageDigest: z.string(),
          executionDigest: z.string(),
        })
        .parse(packageReview);

      async function install(requestId: string) {
        const copy = await harness.callRpc("workflow_install", {
          projectId: PROJECT_ID,
          reviewId: review.reviewId,
          packageDigest: review.packageDigest,
          requestId,
        });

        return {
          projectId: PROJECT_ID,
          importId: z.object({ importId: z.string() }).parse(copy).importId,
        };
      }

      const target = await install("recipient");
      const other = await install("other");
      const site = { ...target, site: "example.org" };
      const selected = { ...site, openSeoProjectId: "provider-project" };
      await expect(
        harness.callRpc("workflow_openseo_status", target),
      ).resolves.toMatchObject({ kind: "disconnected", keyConfigured: false });
      await harness.setSettings({ openSeoWorkspaceApiKey: key });

      await expect(
        harness.callRpc("workflow_openseo_projects", site, {
          experimental_caller: { kind: "plugin", pluginId: "state-machines" },
        }),
      ).rejects.toThrow("workflow setup client");

      const fromChat = await harness.runCli(
        [
          "workflow",
          "openseo-projects",
          target.importId,
          "--project",
          PROJECT_ID,
          "--site",
          "example.org",
        ],
        { threadId: "thr_test" },
      );

      expect(fromChat.exitCode).toBe(1);
      expect(fetchOpenSeo).not.toHaveBeenCalled();

      await expect(
        harness.callRpc("workflow_openseo_projects", site),
      ).resolves.toEqual({
        kind: "ready",
        projects: [
          { id: "provider-project", name: "Mosslight", site: "example.org" },
        ],
      });
      await expect(
        harness.callRpc("workflow_openseo_connect", {
          ...selected,
          openSeoProjectId: "other-project",
        }),
      ).resolves.toEqual({ kind: "failed" });
      await expect(
        harness.callRpc("workflow_openseo_keywords", selected),
      ).resolves.toEqual({ kind: "disconnected" });
      await expect(
        harness.callRpc("workflow_openseo_connect", selected),
      ).resolves.toEqual({ kind: "connected" });
      providerError = true;

      const failedRead = await harness.callRpc(
        "workflow_openseo_keywords",
        selected,
      );

      expect(failedRead).toEqual({ kind: "failed" });

      const statusResult = await harness.runCli([
        "workflow",
        "openseo-status",
        target.importId,
        "--project",
        PROJECT_ID,
      ]);

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain('"keyConfigured": true');
      expect(
        JSON.stringify([failedRead, statusResult, harness.logEntries]),
      ).not.toContain(key);
      providerError = false;
      oversized = true;
      await expect(
        harness.callRpc("workflow_openseo_keywords", selected),
      ).resolves.toEqual({ kind: "failed" });
      oversized = false;

      const importResult = z
        .object({ readId: z.string(), retrievedAt: z.string() })
        .parse(await harness.callRpc("workflow_openseo_keywords", selected));

      expect(
        requests.filter(({ name }) => name === "list_saved_keywords"),
      ).toEqual([
        {
          name: "list_saved_keywords",
          arguments: { projectId: "provider-project", limit: 50 },
        },
      ]);

      const input = {
        expectedRevision: 0,
        bindings: {
          hostId: "host_test",
          providerId: "codex",
          model: "test",
          inputs: {
            startup: "Juniper Studio",
            audience: "Gardeners",
            "product-facts": "A recipient-approved product fact.",
          },
          source: {
            kind: "openseo",
            readId: importResult.readId,
            keywordIds: ["row-1"],
          },
        },
      };

      await expect(
        harness.callRpc("workflow_bind", { ...other, ...input }),
      ).rejects.toThrow("Read saved OpenSEO keywords again");
      await expect(
        harness.callRpc("workflow_bind", {
          ...target,
          ...input,
          bindings: {
            ...input.bindings,
            source: { ...input.bindings.source, keywordIds: ["other-row"] },
          },
        }),
      ).rejects.toThrow("only keywords from this OpenSEO read");

      const bound = await harness.callRpc("workflow_bind", {
        ...target,
        ...input,
      });

      const snapshot = {
        kind: "openseo",
        site: "example.org",
        retrievedAt: importResult.retrievedAt,
        keywords: [
          {
            id: "row-1",
            keyword: "neighborhood seed swap",
            intent: "informational",
            volume: null,
          },
        ],
      };

      expect(bound).toMatchObject({ source: snapshot, scheduleEnabled: false });
      expect(JSON.stringify(bound)).not.toContain(importResult.readId);
      await expect(
        harness.callRpc("workflow_bind", { ...target, ...input }),
      ).rejects.toThrow("changed");
      rejectKey = true;
      await expect(
        harness.callRpc("workflow_openseo_keywords", selected),
      ).resolves.toEqual({ kind: "expired" });
      await harness.setSettings({ openSeoWorkspaceApiKey: null });
      await harness.setSettings({ openSeoWorkspaceApiKey: key });
      await expect(
        harness.callRpc("workflow_openseo_status", target),
      ).resolves.toMatchObject({ kind: "expired" });
      await harness.callRpc("workflow_openseo_disconnect", target);
      const calls = fetchOpenSeo.mock.calls.length;

      await expect(
        harness.callRpc("workflow_preview", target),
      ).resolves.toMatchObject({ copy: { source: snapshot } });
      await harness.callRpc("workflow_confirm", {
        ...target,
        expectedRevision: 1,
        executionDigest: review.executionDigest,
      });
      await harness.callRpc("workflow_run", {
        ...target,
        requestId: "first-run",
      });

      const graphCall = z
        .object({
          assets: z.object({ inputs: z.record(z.string(), z.unknown()) }),
        })
        .parse(admitted);

      expect(graphCall.assets.inputs["product-facts"]).toBe(
        "A recipient-approved product fact.",
      );
      expect(
        JSON.parse(String(graphCall.assets.inputs.openSeoEvidence)),
      ).toMatchObject({
        site: "example.org",
        retrievedAt: importResult.retrievedAt,
        keywords: [
          {
            keyword: "neighborhood seed swap",
            intent: "informational",
            volume: null,
          },
        ],
      });
      expect(JSON.stringify(admitted)).not.toMatch(
        /row-1|provider-project|oseo_fixture/,
      );
      expect(fetchOpenSeo).toHaveBeenCalledTimes(calls);
      const exported = await harness.callRpc("workflow_export", target);
      expect(exported).toMatchObject({ packageDigest: review.packageDigest });
      expect(JSON.stringify(exported)).not.toMatch(
        /row-1|provider-project|oseo_fixture|example[.]org/,
      );
    } finally {
      vi.unstubAllGlobals();
      await harness.dispose();
    }
  });

  it("keeps the target chat owned between runs with one wait due by the next run plus an hour", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const cancelled: string[] = [];
    const registered: unknown[] = [];

    harness.sdk.stub(
      "experimental_inbox.cancelWait",
      async ({ waitId }: { waitId: string }) => {
        cancelled.push(waitId);

        return {};
      },
    );
    harness.sdk.stub(
      "experimental_inbox.registerWait",
      async (args: unknown) => {
        registered.push(args);

        return { wait: { id: "wait_next" } };
      },
    );

    const automation = await createAgentAutomation(harness, {
      name: "Morning triage",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      targetThreadId: THREAD_ID,
    });

    harness.sdk.stub("experimental_inbox.waits", async () => ({
      waits: [
        { id: "wait_previous", key: `automation-run:${automation.id}` },
        { id: "wait_other", key: "deploy" },
      ],
    }));
    await harness.callRpc("automations_run", {
      projectId: PROJECT_ID,
      automationId: automation.id,
    });

    await vi.waitFor(() => expect(registered).toHaveLength(1));

    const current = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );

    expect(cancelled).toEqual(["wait_previous"]);
    expect(registered).toEqual([
      {
        threadId: THREAD_ID,
        wait: {
          key: `automation-run:${automation.id}`,
          for: "Morning triage runs again",
          events: [`automation-run:${automation.id}`],
          by: (current.nextRunAt ?? 0) + 60 * 60 * 1_000,
        },
      },
    ]);
    await harness.dispose();
  });

  it("keeps an agent automation enabled after repeated transient turn failures", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = automationRunRpcResponseSchema.parse(
        await harness.callRpc("automations_run", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      );

      const threadId = await vi.waitFor(async () => {
        const run = automationRunListResponseSchema
          .parse(
            await harness.callRpc("automations_runs", {
              projectId: PROJECT_ID,
              automationId: automation.id,
            }),
          )
          .runs.find((candidate) => candidate.id === started.run.id);

        if (run?.status !== "running" || run.threadId === null) {
          throw new Error(`run ${started.run.id} has no running thread yet`);
        }

        return run.threadId;
      });

      await harness.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({
          threadId,
          attemptNumber: attempt,
          errorInfo: {
            category: "connection-failed",
            providerCode: "httpConnectionFailed",
            httpStatusCode: 502,
          },
        }),
      );
      await harness.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({
          id: threadId,
          projectId: PROJECT_ID,
          status: "error",
        }),
        error: "unexpected status 502 Bad Gateway",
      });
    }

    const current = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );

    expect(current).toMatchObject({
      enabled: true,
      lastRunStatus: "failed",
    });

    await harness.dispose();
  });

  it("round-trips create, list, get, and delete over RPC and rejects unavailable projects", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;

    const created = await createAgentAutomation(harness, {
      name: "RPC agent",
      targetThreadId: THREAD_ID,
    });

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );

    expect(listed.map((automation) => automation.id)).toContain(created.id);

    const overview = automationsOverviewResponseSchema.parse(
      await harness.callRpc("automations_overview"),
    );

    expect(overview.automations).toContainEqual(
      expect.objectContaining({
        automation: expect.objectContaining({ id: created.id }),
        project: { id: PROJECT_ID, name: "Test Project" },
      }),
    );

    const overviewEntry = overview.automations.find(
      (entry) => entry.automation.id === created.id,
    );

    expect(overviewEntry?.automation).toHaveProperty("execution.mode", "agent");
    expect(overviewEntry?.automation).not.toHaveProperty("execution.prompt");

    const found = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );

    expect(found).toMatchObject({
      id: created.id,
      name: "RPC agent",
      execution: expect.objectContaining({ mode: "agent" }),
    });

    await expect(
      harness.callRpc("automations_create", {
        projectId: MISSING_PROJECT_ID,
        name: "Missing project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${MISSING_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_create", {
        projectId: DELETED_PROJECT_ID,
        name: "Deleted project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${DELETED_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_delete", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);
    expect(signalKinds(host)).toContain("automations-changed");

    await harness.dispose();
  });

  it("keeps paused automations visible after their project is removed", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;

    const retained = await createAgentAutomation(harness, {
      name: "Retained paused automation",
    });

    host.api.storage
      .database()
      .prepare(
        "UPDATE automations SET project_id = ?, enabled = 0 WHERE id = ?",
      )
      .run(DELETED_PROJECT_ID, retained.id);

    const overview = automationsOverviewResponseSchema.parse(
      await harness.callRpc("automations_overview"),
    );

    expect(overview.automations).toContainEqual(
      expect.objectContaining({
        automation: expect.objectContaining({
          id: retained.id,
          projectId: DELETED_PROJECT_ID,
          enabled: false,
        }),
        project: { id: DELETED_PROJECT_ID, name: DELETED_PROJECT_ID },
      }),
    );

    await harness.dispose();
  });

  it("keeps script env values in the secret store from create through delete", async () => {
    const host = await bootAutomationsPlugin();

    const created = automationDetailResponseSchema.parse(
      await host.harness.callRpc("automations_create", {
        projectId: PROJECT_ID,
        name: "Env script",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: {
          mode: "script",
          script: "echo ok",
          interpreter: "bash",
          env: { API_TOKEN: "tok-private" },
        },
        origin: "human",
      }),
    );

    expect(created.execution).toMatchObject({
      env: { API_TOKEN: "tok-private" },
    });
    expect(await host.api.experimental_secrets.get(`env/${created.id}`)).toBe(
      '{"API_TOKEN":"tok-private"}',
    );
    expect(JSON.stringify(storedExecution(host, created.id))).not.toContain(
      "tok-private",
    );

    const listed = automationListResponseSchema.parse(
      await host.harness.callRpc("automations_list", {
        projectId: PROJECT_ID,
      }),
    );

    expect(JSON.stringify(listed)).toContain("tok-private");

    await host.harness.callRpc("automations_delete", {
      projectId: PROJECT_ID,
      automationId: created.id,
    });
    expect(await host.api.experimental_secrets.list("env/")).toEqual([]);

    await host.harness.dispose();
  });

  it("creates a script automation through CLI and lists it through both CLI and RPC", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const runAt = new Date(Date.now() + 60_000).toISOString();

    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "CLI script",
      "--at",
      runAt,
      "--script",
      "echo ok",
      "--interpreter",
      "bash",
      "--json",
    ]);

    expect(createdResult.exitCode).toBe(0);

    const created = automationDetailResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );

    expect(created).toMatchObject({
      name: "CLI script",
      execution: expect.objectContaining({ mode: "script" }),
    });

    const cliList = await harness.runCli([
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);

    expect(cliList.exitCode).toBe(0);
    expect(
      automationListResponseSchema
        .parse(JSON.parse(cliList.stdout ?? ""))
        .map((automation) => automation.id),
    ).toEqual([created.id]);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      )[0]?.id,
    ).toBe(created.id);

    const editable = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );

    expect(editable.execution).toMatchObject({
      mode: "script",
      script: "echo ok",
      resolvedWorkingDirectory: "/test/project",
    });
    expect(editable.execution).not.toHaveProperty("scriptFile");

    const agentUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "triage the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--reasoning",
      "ultra",
      "--service-tier",
      "fast",
      "--permission-mode",
      "accept-edits",
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);

    expect(agentUpdateResult.exitCode).toBe(0);

    const agentUpdated = automationDetailResponseSchema.parse(
      JSON.parse(agentUpdateResult.stdout ?? ""),
    );

    expect(agentUpdated.execution).toEqual({
      mode: "agent",
      prompt: "triage the inbox",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "ultra",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
      targetThreadId: THREAD_ID,
    });

    const scriptUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--script",
      "echo updated",
      "--interpreter",
      "bash",
      "--timeout",
      "12000",
      "--env-json",
      '{"CHANNEL":"qa"}',
      "--json",
    ]);

    expect(scriptUpdateResult.exitCode).toBe(0);

    const scriptUpdated = automationDetailResponseSchema.parse(
      JSON.parse(scriptUpdateResult.stdout ?? ""),
    );

    expect(scriptUpdated.execution).toEqual({
      mode: "script",
      scriptFile: "script.sh",
      storedScriptPath: expect.stringMatching(
        storedScriptPathPattern(created.id),
      ),
      interpreter: "bash",
      workingDirectory: { type: "project" },
      resolvedWorkingDirectory: "/test/project",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });

    const updatedEditable = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );

    expect(updatedEditable.execution).toEqual({
      mode: "script",
      script: "echo updated",
      storedScriptPath: expect.stringMatching(
        storedScriptPathPattern(created.id),
      ),
      interpreter: "bash",
      workingDirectory: { type: "project" },
      resolvedWorkingDirectory: "/test/project",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });

    const readScript = async () =>
      automationDetailResponseSchema.parse(
        await harness.callRpc("automations_get", {
          projectId: PROJECT_ID,
          automationId: created.id,
        }),
      ).execution;

    const contentOnlyResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--script",
      "echo refreshed",
    ]);

    expect(contentOnlyResult.exitCode).toBe(0);
    expect(await readScript()).toMatchObject({
      script: "echo refreshed",
      interpreter: "bash",
      workingDirectory: { type: "project" },
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });

    const envOnlyResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--env-json",
      '{"CHANNEL":"prod"}',
    ]);

    expect(envOnlyResult.exitCode).toBe(0);
    expect(await readScript()).toMatchObject({
      script: "echo refreshed",
      timeoutMs: 12_000,
      env: { CHANNEL: "prod" },
    });
    expect(await host.api.experimental_secrets.get(`env/${created.id}`)).toBe(
      '{"CHANNEL":"prod"}',
    );
    expect(storedExecution(host, created.id)).toMatchObject({
      envKeys: ["CHANNEL"],
    });
    expect(storedExecution(host, created.id)).not.toHaveProperty("env");

    const clearEnvResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--env-json",
      "{}",
    ]);

    expect(clearEnvResult.exitCode).toBe(0);
    expect(await readScript()).not.toHaveProperty("env");
    expect(await host.api.experimental_secrets.list("env/")).toEqual([]);

    const mixedResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--model",
      "gpt-5",
      "--timeout",
      "5000",
    ]);

    expect(mixedResult.exitCode).toBe(1);
    expect(mixedResult.stderr).toContain(
      "Cannot combine agent execution flags with script flags",
    );

    const errorResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "No execution",
      "--in",
      "1h",
    ]);

    expect(errorResult.exitCode).toBe(1);
    expect(errorResult.stderr).toContain("Provide an execution mode");

    await harness.dispose();
  });

  it("accepts a bare millisecond timeout and a duration with a unit", async () => {
    const { harness } = await bootAutomationsPlugin();

    const bare = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Bare timeout",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "5000",
      "--json",
    ]);

    expect(bare.exitCode, bare.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(bare.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "script", timeoutMs: 5_000 });

    const withUnit = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Unit timeout",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "90s",
      "--json",
    ]);

    expect(withUnit.exitCode, withUnit.stderr).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(withUnit.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "script", timeoutMs: 90_000 });

    const tooLong = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Too long",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--timeout",
      "61m",
    ]);

    expect(tooLong.exitCode).toBe(1);
    expect(tooLong.stderr).toContain("invalid value '61m' for --timeout");

    await harness.dispose();
  });

  it("prints help for the whole CLI and for one command with exit 0", async () => {
    const { harness } = await bootAutomationsPlugin();

    const topLevel = await harness.runCli(["--help"]);
    expect(topLevel.exitCode, topLevel.stderr).toBe(0);
    expect(topLevel.stdout).toContain("omnyo automation list");
    expect(topLevel.stdout).toContain("omnyo automation delete");

    const perCommand = await harness.runCli(["runs", "--help"]);
    expect(perCommand.exitCode, perCommand.stderr).toBe(0);
    expect(perCommand.stdout).toContain("omnyo automation runs <automationId>");
    expect(perCommand.stdout).toContain("--limit <1-200>");

    const bare = await harness.runCli([]);
    expect(bare.exitCode, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("omnyo automation <command> [options]");

    await harness.dispose();
  });

  it("rejects a positional argument to list", async () => {
    const { harness } = await bootAutomationsPlugin();

    const strayArgument = await harness.runCli([
      "list",
      "--project",
      PROJECT_ID,
      "auto_123",
    ]);

    expect(strayArgument.exitCode).toBe(1);
    expect(strayArgument.stderr).toContain("unexpected argument 'auto_123'");

    await harness.dispose();
  });

  it("reports every missing value once and names the thread's project", async () => {
    const { harness } = await bootAutomationsPlugin();

    const missingBoth = await harness.runCli(["show"]);
    expect(missingBoth.exitCode).toBe(1);
    expect(missingBoth.stderr).toContain(
      "missing required arguments: <automationId>",
    );

    const missingName = await harness.runCli(["create", "--script", "echo ok"]);
    expect(missingName.exitCode).toBe(1);
    expect(missingName.stderr).toContain("missing required options: --name");

    const noContext = await harness.runCli(["list"]);
    expect(noContext.exitCode).toBe(1);
    expect(noContext.stderr).toContain("missing required option --project");
    expect(noContext.stderr).toContain("omnyo project list");

    const withContext = await harness.runCli(["list"], {
      projectId: PROJECT_ID,
    });

    expect(withContext.exitCode).toBe(1);
    expect(withContext.stderr).toContain(
      `missing required option --project (This thread's project is ${PROJECT_ID}; re-run with --project ${PROJECT_ID})`,
    );

    const envelope = await harness.runCli(["list", "--json"], {
      projectId: PROJECT_ID,
    });

    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout ?? "")).toEqual({
      ok: false,
      error: {
        code: "missing_required",
        message: "missing required option --project",
        hint: `This thread's project is ${PROJECT_ID}; re-run with --project ${PROJECT_ID}`,
      },
    });

    await harness.dispose();
  });

  it("keeps a valid script row canonical when its stored file is missing", async () => {
    const { harness } = await bootAutomationsPlugin();

    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Missing script file",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--json",
    ]);

    const created = automationDetailResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );

    if (
      created.execution.mode !== "script" ||
      created.execution.storedScriptPath === undefined
    ) {
      throw new Error("Expected a stored script fixture");
    }

    await unlink(created.execution.storedScriptPath);

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );

    expect(listed).toContainEqual(
      expect.objectContaining({ id: created.id, name: "Missing script file" }),
    );
    expect(listed[0]).not.toHaveProperty("problem");
    await expect(
      harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).rejects.toThrow("Script file was not found");

    await harness.dispose();
  });

  it.each(["agent", "script"] as const)(
    "allows a user thread to create %s work after its heartbeat settles, preserving history",
    async (mode) => {
      const { harness } = await bootAutomationsPlugin();

      try {
        const heartbeat = await createAgentAutomation(harness, {
          targetThreadId: THREAD_ID,
        });

        await harness.callRpc("automations_run", {
          projectId: PROJECT_ID,
          automationId: heartbeat.id,
        });
        await vi.waitFor(() => {
          expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
        });

        const request = {
          projectId: PROJECT_ID,
          createdByThreadId: THREAD_ID,
        };

        const execution =
          mode === "agent"
            ? agentExecution()
            : { mode: "script", script: "echo ok", interpreter: "bash" };

        await expect(
          harness.callRpc("automations_create", {
            ...request,
            name: "Recursive work",
            trigger: oneShotTrigger(),
            execution,
            origin: "agent",
          }),
        ).rejects.toThrow(
          "Threads executing an automation run cannot create automations",
        );

        await harness.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: THREAD_ID }),
          lastAssistantText: "Build delivered and heartbeat stopped",
        });
        await harness.callRpc("automations_pause", {
          projectId: PROJECT_ID,
          automationId: heartbeat.id,
        });

        const created = await harness.callRpc("automations_create", {
          ...request,
          name: "New closeout",
          trigger: oneShotTrigger(),
          execution,
          origin: "agent",
        });

        expect(created).toMatchObject({
          name: "New closeout",
          createdByThreadId: THREAD_ID,
        });
        expect(
          await harness.callRpc("automations_get", {
            projectId: PROJECT_ID,
            automationId: heartbeat.id,
          }),
        ).toMatchObject({ enabled: false });
        expect(
          await harness.callRpc("automations_runs", {
            projectId: PROJECT_ID,
            automationId: heartbeat.id,
          }),
        ).toMatchObject({
          runs: [expect.objectContaining({ status: "succeeded" })],
        });
      } finally {
        await harness.dispose();
      }
    },
  );

  it("rejects threads spawned by automations", async () => {
    const { harness } = await bootAutomationsPlugin();

    try {
      harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, originPluginId: "automations" }),
      );

      await expect(
        harness.callRpc("automations_create", {
          projectId: PROJECT_ID,
          createdByThreadId: "thr_spawned",
          name: "Recursive scheduler",
          trigger: oneShotTrigger(),
          execution: agentExecution(),
          origin: "agent",
        }),
      ).rejects.toThrow("Automation-spawned threads cannot create automations");
      expect(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("rejects creation when the creator thread cannot be read", async () => {
    const { harness } = await bootAutomationsPlugin();

    try {
      harness.sdk.stub("threads.get", async () => {
        throw new Error("Creator lookup unavailable");
      });

      await expect(
        harness.callRpc("automations_create", {
          projectId: PROJECT_ID,
          createdByThreadId: THREAD_ID,
          name: "Unknown creator",
          trigger: oneShotTrigger(),
          execution: agentExecution(),
          origin: "agent",
        }),
      ).rejects.toThrow("Creator lookup unavailable");
      expect(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    {
      supported: ["accept-edits", "auto", "full"] as const,
      expected: "auto",
    },
    {
      supported: ["accept-edits", "full"] as const,
      expected: "full",
    },
  ])(
    "defaults agent automations to $expected for provider capabilities",
    async ({ supported, expected }) => {
      const { harness } = await bootAutomationsPlugin([...supported]);

      const result = await harness.runCli([
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        `CLI agent ${expected}`,
        "--at",
        new Date(Date.now() + 60_000).toISOString(),
        "--prompt",
        "Summarize the inbox",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);

      const automation = automationDetailResponseSchema.parse(
        JSON.parse(result.stdout ?? ""),
      );

      expect(automation.execution).toMatchObject({
        mode: "agent",
        permissionMode: expected,
      });
      await harness.dispose();
    },
  );

  it("rejects an explicit mode the automation provider does not support", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);

    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Unsupported auto",
      "--at",
      new Date(Date.now() + 60_000).toISOString(),
      "--prompt",
      "Summarize the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--permission-mode",
      "auto",
    ]);

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain(
      "Permission mode auto is not supported by provider codex",
    );
    await harness.dispose();
  });

  it("updates agent execution in place through the CLI without resetting omitted fields", async () => {
    const { harness } = await bootAutomationsPlugin();

    const created = await createAgentAutomation(harness, {
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    });

    const environmentUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "use the new workspace",
      "--permission-mode",
      "auto",
      "--environment",
      "/tmp/design-doctrine",
      "--json",
    ]);

    expect(environmentUpdate.exitCode).toBe(0);

    const environmentTargeted = automationDetailResponseSchema.parse(
      JSON.parse(environmentUpdate.stdout ?? ""),
    );

    expect(environmentTargeted).toMatchObject({
      id: created.id,
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: {
        mode: "agent",
        prompt: "use the new workspace",
        providerId: "codex",
        model: "gpt-5",
        permissionMode: "auto",
        environment: {
          type: "host",
          hostId: "host_fake",
          workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
        },
      },
    });
    expect(environmentTargeted.execution).not.toHaveProperty("targetThreadId");

    const threadTargetUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);

    expect(threadTargetUpdate.exitCode).toBe(0);

    const threadTargeted = automationDetailResponseSchema.parse(
      JSON.parse(threadTargetUpdate.stdout ?? ""),
    );

    expect(threadTargeted.execution).toMatchObject({
      mode: "agent",
      targetThreadId: THREAD_ID,
      environment: {
        type: "host",
        hostId: "host_fake",
        workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
      },
    });

    const worktreeUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--new-environment",
      "worktree",
      "--base-branch",
      "release",
      "--json",
    ]);

    expect(worktreeUpdate.exitCode).toBe(0);

    const worktreeTargeted = automationDetailResponseSchema.parse(
      JSON.parse(worktreeUpdate.stdout ?? ""),
    );

    expect(worktreeTargeted.execution).toMatchObject({
      mode: "agent",
      providerId: "codex",
      model: "gpt-5",
      prompt: "use the new workspace",
      permissionMode: "auto",
      environment: {
        type: "host",
        hostId: "host_fake",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "release" },
        },
      },
    });
    expect(worktreeTargeted.execution).not.toHaveProperty("targetThreadId");
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(1);

    await harness.dispose();
  });

  it.each([
    {
      flags: ["--environment", "C:\\repo"],
      workspace: { type: "unmanaged", path: "C:\\repo" },
    },
    {
      flags: ["--new-environment", "worktree"],
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
  ])(
    "runs $flags on the calling thread's machine",
    async ({ flags, workspace }) => {
      const { harness } = await bootAutomationsPlugin();

      try {
        harness.sdk.stub("threads.get", async ({ threadId }) => ({
          ...makeThreadResponse({ id: threadId }),
          environment: { hostId: "host_caller" },
        }));

        const result = await harness.runCli(
          [
            "create",
            "--project",
            PROJECT_ID,
            "--name",
            "Caller machine",
            "--in",
            "30m",
            "--prompt",
            "Check the build",
            "--provider",
            "codex",
            "--model",
            "gpt-5",
            ...flags,
            "--json",
          ],
          { threadId: THREAD_ID },
        );

        expect(result.exitCode).toBe(0);
        expect(
          automationDetailResponseSchema.parse(JSON.parse(result.stdout ?? ""))
            .execution,
        ).toMatchObject({
          environment: { type: "host", hostId: "host_caller", workspace },
        });
      } finally {
        await harness.dispose();
      }
    },
  );

  it("rejects a date-only --at as ambiguous", async () => {
    const { harness } = await bootAutomationsPlugin();

    try {
      const result = await harness.runCli([
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        "Date only",
        "--at",
        `${new Date().getFullYear() + 1}-01-01`,
        "--script",
        "echo ok",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--at needs a time of day");
    } finally {
      await harness.dispose();
    }
  });

  it("accepts a long prompt and keeps the automation readable afterwards", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);
    const longPrompt = "review every open pull request carefully. ".repeat(250);
    expect(longPrompt.length).toBeGreaterThan(8_000);

    const update = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      longPrompt,
      "--json",
    ]);

    expect(update.exitCode).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(update.stdout ?? ""))
        .execution,
    ).toMatchObject({ mode: "agent", prompt: longPrompt });

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );

    expect(listed).toHaveLength(1);
    expect(automationResponseSchema.parse(listed[0]).execution).toMatchObject({
      prompt: longPrompt,
    });

    const shown = await harness.runCli([
      "show",
      created.id,
      "--project",
      PROJECT_ID,
      "--json",
    ]);

    expect(shown.exitCode).toBe(0);
    expect(
      automationDetailResponseSchema.parse(JSON.parse(shown.stdout ?? ""))
        .execution,
    ).toMatchObject({ prompt: longPrompt });

    const repaired = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { prompt: "short again" },
      }),
    );

    expect(repaired.execution).toMatchObject({ prompt: "short again" });

    await harness.dispose();
  });

  it("does not persist a CLI create rejected by execution validation", async () => {
    const { harness } = await bootAutomationsPlugin();

    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Invalid empty prompt",
      "--in",
      "1h",
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);

    expect(result.exitCode).toBe(1);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);

    await harness.dispose();
  });

  it("lists degraded rows and repairs a desktop v0.40.0 failed create", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    await createAgentAutomation(harness, { name: "Hidden legacy row" });
    await createAgentAutomation(harness, { name: "Invalid stored row" });
    const healthy = await createAgentAutomation(harness, { name: "Healthy" });
    const database = host.api.storage.database();
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run(
        JSON.stringify({ ...agentExecution(), prompt: "" }),
        "Hidden legacy row",
      );
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run("not json", "Invalid stored row");

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );

    const repairTarget = listed.find(
      (item) => "problem" in item && item.problem === "missing-agent-prompt",
    );

    const invalidTarget = listed.find(
      (item) => "problem" in item && item.problem === "invalid-stored-data",
    );

    expect(repairTarget).toMatchObject({
      name: "Hidden legacy row",
      projectId: PROJECT_ID,
      execution: expect.objectContaining({
        mode: "agent",
        prompt: "",
        providerId: "codex",
        model: "gpt-5",
      }),
    });
    expect(invalidTarget).toMatchObject({ name: "Invalid stored row" });
    expect(listed).toContainEqual(expect.objectContaining({ id: healthy.id }));
    expect(
      automationsOverviewResponseSchema.parse(
        await harness.callRpc("automations_overview"),
      ).automations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automation: repairTarget }),
        expect.objectContaining({ automation: invalidTarget }),
      ]),
    );

    const cliList = await harness.runCli(["list", "--project", PROJECT_ID]);
    expect(cliList).toMatchObject({ exitCode: 0 });
    expect(cliList.stdout).toContain("Prompt required");
    expect(cliList.stdout).toContain("Invalid data");

    const repairRow = cliList.stdout
      ?.split("\n")
      .find((line) => line.includes("Hidden legacy row"));

    expect(repairRow).toContain("yes");
    expect(repairRow).toContain("once at");
    expect(repairRow).toContain("human");

    if (
      repairTarget === undefined ||
      !("execution" in repairTarget) ||
      invalidTarget === undefined ||
      "execution" in invalidTarget
    ) {
      throw new Error("Expected degraded automation descriptors");
    }

    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
      }),
    ).toEqual(repairTarget);
    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).toEqual(invalidTarget);

    const cliShow = await harness.runCli([
      "show",
      repairTarget.id,
      "--project",
      PROJECT_ID,
    ]);

    expect(cliShow).toMatchObject({ exitCode: 0 });
    expect(cliShow.stdout).toContain("Status:    Prompt required");
    expect(cliShow.stdout).toContain("Enabled:   yes");
    expect(cliShow.stdout).toContain("Schedule:  once at");
    expect(cliShow.stdout?.endsWith("\n\n")).toBe(true);

    const rejectedLifecycleWrites = [
      ["automations_run", repairTarget.id, "it can run"],
      ["automations_pause", repairTarget.id, "it can be paused"],
      ["automations_resume", repairTarget.id, "it can be resumed"],
    ] as const;

    for (const [method, automationId, operation] of rejectedLifecycleWrites) {
      await expect(
        harness.callRpc(method, { projectId: PROJECT_ID, automationId }),
      ).rejects.toThrow(
        `Automation "Hidden legacy row" requires a prompt before ${operation}. Edit it and add a prompt first.`,
      );
    }

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
        name: "Must not be persisted",
      }),
    ).rejects.toThrow(
      'Automation "Hidden legacy row" requires a prompt before other fields can be updated. Edit it and add a prompt first.',
    );
    await expect(
      harness.callRpc("automations_pause", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be paused. Delete it and recreate it.',
    );
    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
        name: "Must not be persisted either",
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be updated. Delete it and recreate it.',
    );
    expect(
      database
        .prepare("SELECT name, enabled FROM automations WHERE id = ?")
        .get(repairTarget.id),
    ).toEqual({ name: "Hidden legacy row", enabled: 1 });

    const update = await harness.runCli([
      "update",
      repairTarget.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "repaired prompt",
    ]);

    expect(update.exitCode).toBe(0);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: repairTarget.id,
          execution: expect.objectContaining({ prompt: "repaired prompt" }),
        }),
        invalidTarget,
        expect.objectContaining({ id: healthy.id }),
      ]),
    );
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", {
          projectId: MISSING_PROJECT_ID,
        }),
      ),
    ).toEqual([]);

    await harness.dispose();
  });

  it("preserves valid rows after rejected full and partial updates", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const full = await createAgentAutomation(harness, { name: "Full" });
    const partial = await createAgentAutomation(harness, { name: "Partial" });

    const fullResult = await harness.runCli([
      "update",
      full.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);

    expect(fullResult.exitCode).toBe(1);

    const service = createAutomationService({
      api: host.api as never,
      db: host.api.storage.database(),
      env: new AutomationEnvStore(host.api.experimental_secrets),
      pluginDataDir: "/tmp/omnyo-automations-test",
    });

    await expect(
      service.update({
        projectId: PROJECT_ID,
        automationId: partial.id,
        agent: { prompt: "" },
      } as never),
    ).rejects.toThrow();

    for (const automationId of [full.id, partial.id]) {
      const unchanged = automationDetailResponseSchema.parse(
        await harness.callRpc("automations_get", {
          projectId: PROJECT_ID,
          automationId,
        }),
      );

      expect(unchanged.execution).toMatchObject({
        mode: "agent",
        prompt: "summarize the inbox",
      });
    }

    await harness.dispose();
  });

  it("rejects conflicting targets and invalid permission modes before updating", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const conflictingTargets = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--environment",
      "/tmp/design-doctrine",
    ]);

    expect(conflictingTargets.exitCode).toBe(1);
    expect(conflictingTargets.stderr).toContain(
      "Cannot combine target options",
    );

    const invalidPermissionMode = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "write",
    ]);

    expect(invalidPermissionMode.exitCode).toBe(1);
    expect(invalidPermissionMode.stderr).toContain(
      "invalid value 'write' for --permission-mode. Expected one of: accept-edits, auto, full",
    );

    await harness.dispose();
  });

  it("patches agent execution through RPC while preserving its environment", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const updated = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          prompt: "updated by RPC",
          providerId: "claude",
          model: "claude-opus-5",
          reasoningLevel: "ultra",
          serviceTier: "fast",
          permissionMode: "full",
          target: { type: "target-thread", threadId: THREAD_ID },
        },
      }),
    );

    expect(updated).toMatchObject({
      id: created.id,
      execution: {
        mode: "agent",
        prompt: "updated by RPC",
        providerId: "claude",
        model: "claude-opus-5",
        reasoningLevel: "ultra",
        serviceTier: "fast",
        permissionMode: "full",
        environment: { type: "project-default" },
        targetThreadId: THREAD_ID,
      },
    });

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "write" },
      }),
    ).rejects.toThrow();

    await harness.dispose();
  });

  it("rejects unsupported partial permission updates through RPC and CLI", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        execution: {
          ...agentExecution(),
          permissionMode: "auto",
        },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "auto" },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    const cliResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "auto",
    ]);

    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain(
      "Permission mode auto is not supported by provider codex.",
    );

    const unchanged = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );

    expect(unchanged.execution).toMatchObject({
      mode: "agent",
      permissionMode: "accept-edits",
    });

    await harness.dispose();
  });

  it("validates permission updates against the automation target environment", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits"], ["full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          permissionMode: "full",
          target: {
            type: "environment",
            environment: {
              type: "reuse",
              environmentId: "env_routed",
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      execution: {
        mode: "agent",
        permissionMode: "full",
        environment: { type: "reuse", environmentId: "env_routed" },
      },
    });

    await harness.dispose();
  });

  it("reads retained recovered history without relabeling or rewriting it", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness);
    const db = host.api.storage.database();

    try {
      const insert = db.prepare(
        `INSERT INTO automation_runs (
           id, automation_id, run_mode, status, trigger, scheduled_for,
           started_at, finished_at, output
         ) VALUES (?, ?, 'agent', ?, 'schedule', ?, ?, ?, ?)`,
      );

      insert.run(
        "run_recovered",
        automation.id,
        "recovered",
        1000,
        1001,
        1002,
        "retained recovery output",
      );
      insert.run("run_new", automation.id, "succeeded", 2000, 2001, 2002, null);

      const listed = automationRunListResponseSchema.parse(
        await harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
          limit: 30,
        }),
      );

      expect(listed.runs.map((run) => [run.id, run.status])).toEqual([
        ["run_new", "succeeded"],
        ["run_recovered", "recovered"],
      ]);
      expect(listed.runs[1]).toMatchObject({
        startedAt: 1001,
        finishedAt: 1002,
        output: "retained recovery output",
      });
      expect(
        db
          .prepare("SELECT status, output FROM automation_runs WHERE id = ?")
          .get("run_recovered"),
      ).toEqual({
        status: "recovered",
        output: "retained recovery output",
      });

      const cli = await harness.runCli([
        "runs",
        automation.id,
        "--project",
        PROJECT_ID,
        "--limit",
        "30",
        "--json",
      ]);

      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout!)).toEqual(listed);

      db.prepare(
        "UPDATE automation_runs SET status = 'unknown-status' WHERE id = ?",
      ).run("run_recovered");
      await expect(
        harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
          limit: 30,
        }),
      ).rejects.toThrow();
    } finally {
      await harness.dispose();
    }
  });

  it("dedupes manual runs through RPC idempotency keys", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness);

    const first = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );

    const second = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );

    expect(second.run.id).toBe(first.run.id);
    expect(
      automationRunListResponseSchema.parse(
        await harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs,
    ).toHaveLength(1);

    await harness.dispose();
  });

  it("settles a run orphaned by a restart when the replacement plugin starts", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness);

    const started = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );

    expect(started.run.status).toBe("running");

    const reloaded = await harness.reload(
      plugin as unknown as Parameters<typeof harness.reload>[0],
    );

    const service = reloaded.harness.runService("automation-sweep");
    await vi.waitFor(async () => {
      const runs = automationRunListResponseSchema.parse(
        await reloaded.harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs;

      expect(runs[0]).toMatchObject({
        id: started.run.id,
        status: "succeeded",
      });
    });
    service.controller.abort();
    await service.done;

    const next = automationRunRpcResponseSchema.parse(
      await reloaded.harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );

    expect(next.run.id).not.toBe(started.run.id);
    expect(next.run.status).toBe("running");

    await reloaded.harness.dispose();
  });

  it("discovers a late-enrolled server host before dispatching a project script", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const source = project();
    source.sources[0]!.path = dirname(host.api.storage.database().name);
    harness.sdk.stub("projects.get", async () => source);

    const created = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Late enrollment",
      "--in",
      "1m",
      "--script",
      "printf 'late enrollment OK'",
      "--interpreter",
      "sh",
      "--working-directory",
      "project",
      "--json",
    ]);

    expect(created.exitCode).toBe(0);

    const automation = automationDetailResponseSchema.parse(
      JSON.parse(created.stdout!),
    );

    let primaryHostId: string | null = null;
    harness.sdk.stub("system.config", () => ({ primaryHostId }));
    const initialCalls = harness.sdk.callsTo("system.config").length;
    const service = harness.runService("automation-sweep");

    try {
      await vi.waitFor(() =>
        expect(harness.sdk.callsTo("system.config")).toHaveLength(
          initialCalls + 1,
        ),
      );
      primaryHostId = "host_fake";
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => {
        const { runs } = automationRunListResponseSchema.parse(
          await harness.callRpc("automations_runs", {
            projectId: PROJECT_ID,
            automationId: automation.id,
          }),
        );

        expect(runs[0]).toMatchObject({
          status: "succeeded",
          output: expect.stringMatching(/(?:^|\n)late enrollment OK$/),
          exitCode: 0,
          error: null,
        });
      });
      const calls = harness.sdk.callsTo("system.config").length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.sdk.callsTo("system.config")).toHaveLength(calls);
    } finally {
      service.controller.abort();
      await service.done;
      await harness.dispose();
    }
  });

  it("points a script's omnyo calls at the server the plugin runs in", async () => {
    const host = await bootAutomationsPlugin(
      undefined,
      undefined,
      "http://127.0.0.1:48886",
    );

    const { harness } = host;

    const created = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Server URL",
      "--in",
      "1h",
      "--script",
      'printf "%s" "$OMNYO_SERVER_URL"',
      "--interpreter",
      "sh",
      "--working-directory",
      "automation-storage",
      "--json",
    ]);

    expect(created.exitCode).toBe(0);

    const automation = automationDetailResponseSchema.parse(
      JSON.parse(created.stdout ?? ""),
    );

    const { completedRun, stop } = observeCompletedRun(host, automation.id);

    try {
      const started = automationRunRpcResponseSchema.parse(
        await harness.callRpc("automations_run", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      );

      expect(await completedRun).toMatchObject({
        id: started.run.id,
        status: "succeeded",
        output: expect.stringMatching(/(?:^|\n)http:\/\/127\.0\.0\.1:48886$/),
      });
    } finally {
      stop();
      await harness.dispose();
    }
  });

  it("dispatches a due agent automation from one sweep tick and closes it from thread.idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const host = await bootAutomationsPlugin();
    const { harness } = host;

    const automation = await createAgentAutomation(harness, {
      name: "Sweep",
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));
    const service = harness.runService("automation-sweep");
    await vi.waitFor(() =>
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1),
    );
    service.controller.abort();
    await service.done;

    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      prompt: `[omnyo automation due:${automation.id}]\n\nsummarize the inbox`,
      title: "Sweep",
      origin: "plugin",
      originPluginId: "automations",
    });

    const runningRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;

    expect(runningRuns).toHaveLength(1);
    expect(runningRuns[0]).toMatchObject({
      automationId: automation.id,
      status: "running",
      threadId: "thr_spawned",
      trigger: "schedule",
    });

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_spawned", projectId: PROJECT_ID }),
      lastAssistantText: null,
    });

    const closedRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;

    expect(closedRuns[0]).toMatchObject({
      status: "succeeded",
      threadId: "thr_spawned",
    });
    expect(signalKinds(host)).toEqual(
      expect.arrayContaining([
        "automations-changed",
        "automation-runs-changed",
      ]),
    );

    await harness.dispose();
  });

  it("disables automations targeting a deleted thread", async () => {
    const { harness } = await bootAutomationsPlugin();

    const automation = await createAgentAutomation(harness, {
      name: "Thread target",
      targetThreadId: THREAD_ID,
    });

    await harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        deletedAt: Date.now(),
      }),
    });

    const disabled = automationDetailResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );

    expect(disabled).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastError: "Target thread thr_target was deleted",
    });

    await harness.dispose();
  });

  it("dispose aborts the sweep service and poisons stale Omnyo handles", async () => {
    const { api, harness } = await bootAutomationsPlugin();
    const service = harness.runService("automation-sweep");

    await harness.dispose();
    await service.done;
    await expect(api.storage.kv.get("after-dispose")).rejects.toThrow(
      PluginContextStaleError,
    );
  });
});

describe("script owner execution", () => {
  it("routes stored scripts through the configured owner and preserves process controls", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "omnyo-automation-owner-")),
    );

    const ownerData = join(root, "owner-data");
    const ownerTemp = join(root, "owner-temp");
    const ownerCwd = join(root, "owner-workspace");
    await Promise.all(
      [ownerData, ownerTemp, ownerCwd].map((path) => mkdir(path)),
    );

    let owner:
      | ReturnType<
          typeof experimental_createHostEntryHarness<
            typeof automationScriptHostContract,
            {}
          >
        >
      | undefined;

    let refuseOwner = false;
    vi.stubEnv("OMNYO_AUTOMATION_TEST_TOKEN", "fixture-only");

    const host = createFakePluginHost({
      pluginId: "automations",
      settings: { scriptHostId: "host_owner" },
      appUrl: "https://omnyo.private.invalid",
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_coordinator" }) },
        projects: {
          get: async () => ({
            ...project(),
            sources: [
              { type: "local_path", hostId: "host_owner", path: ownerCwd },
            ],
          }),
          list: async () => [project()],
        },
      },
      experimental_callHostRpc: async (call) => {
        expect(call.hostId).toBe("host_owner");

        if (refuseOwner) throw new Error("Owner is offline");

        const { default: entry } = await import(
          new URL("./host.js", import.meta.url).href
        );

        owner ??= experimental_createHostEntryHarness<
          typeof automationScriptHostContract,
          {}
        >(entry, {
          experimental_paths: { dataDir: ownerData, tempDir: ownerTemp },
        });

        return owner.experimental_call(
          "executeStoredScript",
          automationScriptHostContract.executeStoredScript.input.parse(
            call.input,
          ),
          { signal: call.signal },
        );
      },
    });

    try {
      await plugin(host.api);

      const runScript = async (
        script: string,
        workingDirectory:
          | { type: "path"; path: string }
          | { type: "automation-storage" }
          | { type: "project" },
        timeoutMs = 2000,
      ) => {
        const created = automationDetailResponseSchema.parse(
          await host.harness.callRpc("automations_create", {
            projectId: PROJECT_ID,
            name: "Owner process fixture",
            enabled: false,
            trigger: oneShotTrigger(),
            origin: "human",
            execution: {
              mode: "script",
              script,
              interpreter: "bash",
              timeoutMs,
              env: { EXPLICIT_ENV: "kept" },
              workingDirectory,
            },
          }),
        );

        const started = automationRunRpcResponseSchema.parse(
          await host.harness.callRpc("automations_run", {
            projectId: PROJECT_ID,
            automationId: created.id,
          }),
        );

        let closed:
          | ReturnType<
              typeof automationRunListResponseSchema.parse
            >["runs"][number]
          | undefined;

        await expect
          .poll(
            async () => {
              const listed = automationRunListResponseSchema.parse(
                await host.harness.callRpc("automations_runs", {
                  projectId: PROJECT_ID,
                  automationId: created.id,
                }),
              );

              closed = listed.runs.find((run) => run.id === started.run.id);

              return closed?.status;
            },
            { timeout: 5000 },
          )
          .toMatch(/^(succeeded|failed|skipped)$/u);
        expect(closed).toBeDefined();

        return { created, run: closed! };
      };

      const body =
        'printf "cwd=%s\\nexplicit=%s\\nserver=%s\\nautomation=%s\\nrun=%s\\nproject=%s\\nfile=%s\\n" "$PWD" "$EXPLICIT_ENV" "$OMNYO_SERVER_URL" "$OMNYO_AUTOMATION_ID" "$OMNYO_AUTOMATION_RUN_ID" "$OMNYO_PROJECT_ID" "$(basename "$0")"\nif [ -n "$OMNYO_AUTOMATION_TEST_TOKEN" ]; then printf "ambient=present\\n"; else printf "ambient=absent\\n"; fi\n';

      const first = await runScript(body, { type: "path", path: ownerCwd });
      expect(host.harness.experimental_hostRpcCalls).toHaveLength(1);
      expect(first.run.status).toBe("succeeded");
      expect(first.run.output).toContain("cwd=" + ownerCwd);
      expect(first.run.output).toContain("explicit=kept");
      expect(first.run.output).toContain("ambient=absent");
      expect(first.run.output).toContain(
        "server=https://omnyo.private.invalid",
      );
      expect(first.run.output).toContain("automation=" + first.created.id);
      expect(first.run.output).toContain("run=" + first.run.id);
      expect(first.run.output).toContain("project=" + PROJECT_ID);
      expect(first.run.output).toContain(
        "file=" +
          basename(
            first.created.execution.mode === "script"
              ? (first.created.execution.storedScriptPath ?? "script.sh")
              : "script.sh",
          ),
      );

      const firstPayload =
        automationScriptHostContract.executeStoredScript.input.parse(
          host.harness.experimental_hostRpcCalls[0]!.input,
        );

      const stable =
        automationScriptHostContract.executeStoredScript.input.parse({
          ...firstPayload,
          scriptFile: "stable.mjs",
          interpreter: "node",
          content:
            'import { readFileSync, writeFileSync } from "node:fs";\nconst state = new URL("./retained-state.txt", import.meta.url);\nlet previous = ""; try { previous = readFileSync(state, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }\nwriteFileSync(state, previous + "x");\nconsole.log(previous + "x");\n',
        });

      const stableFirst = await owner!.experimental_call(
        "executeStoredScript",
        stable,
      );

      const stableSecond = await owner!.experimental_call(
        "executeStoredScript",
        stable,
      );

      expect(stableFirst.output).toContain("x");
      expect(stableSecond.output).toContain("xx");
      const ownerScriptDir = join(ownerData, "scripts", first.created.id);
      expect(
        await readFile(join(ownerScriptDir, "retained-state.txt"), "utf8"),
      ).toBe("xx");
      expect(await readFile(join(ownerScriptDir, "stable.mjs"), "utf8")).toBe(
        stable.content,
      );

      const storage = await runScript('printf "cwd=%s\\n" "$PWD"\n', {
        type: "automation-storage",
      });

      expect(storage.run.output).toContain("cwd=" + join(ownerData, "scripts"));

      const projectRun = await runScript('printf "cwd=%s\\n" "$PWD"\n', {
        type: "project",
      });

      expect(projectRun.run.output).toContain("cwd=" + ownerCwd);

      const failed = await runScript(
        'printf "kept-output\\n"; printf "owner-error\\n" >&2; exit 7\n',
        { type: "path", path: ownerCwd },
      );

      expect(failed.run.status).toBe("failed");
      expect(failed.run.exitCode).toBe(7);
      expect(failed.run.output).toContain("kept-output");
      expect(failed.run.error).toContain("owner-error");

      const timed = await runScript(
        'sleep 30 &\nchild=$!\nprintf "child=%s\\n" "$child"\nwait "$child"\n',
        { type: "path", path: ownerCwd },
        80,
      );

      expect(timed.run.status).toBe("failed");
      expect(timed.run.error).toBe("Script timed out");
      const child = Number(/child=(\d+)/u.exec(timed.run.output ?? "")?.[1]);
      expect(Number.isSafeInteger(child)).toBe(true);
      await expect
        .poll(
          () => {
            try {
              process.kill(child, 0);

              return true;
            } catch {
              return false;
            }
          },
          { timeout: 3000 },
        )
        .toBe(false);
      refuseOwner = true;

      const offline = await runScript('printf "must-not-run-locally\\n"\n', {
        type: "path",
        path: ownerCwd,
      });

      expect(offline.run.status).toBe("failed");
      expect(offline.run.error).toContain("Owner is offline");
      expect(offline.run.output).toBeNull();
      refuseOwner = false;
      const payload = firstPayload;
      await expect(
        owner!.experimental_call("executeStoredScript", {
          ...payload,
          scriptFile: "../outside.sh",
        }),
      ).rejects.toThrow();
      const abort = new AbortController();
      const childFile = join(root, "cancel-child.pid");

      const cancelling = owner!.experimental_call(
        "executeStoredScript",
        {
          ...payload,
          content:
            "sleep 30 &\nchild=$!\nprintf '%s' \"$child\" > '" +
            childFile +
            '\'\nwait "$child"\n',
        },
        { signal: abort.signal },
      );

      void cancelling.catch(() => undefined);
      await expect
        .poll(() => readFile(childFile, "utf8").catch(() => ""), {
          timeout: 3000,
        })
        .not.toBe("");
      abort.abort();
      await expect(cancelling).rejects.toThrow();
      const cancelledChild = Number(await readFile(childFile, "utf8"));
      await expect
        .poll(
          () => {
            try {
              process.kill(cancelledChild, 0);

              return true;
            } catch {
              return false;
            }
          },
          { timeout: 3000 },
        )
        .toBe(false);
      expect(await readdir(ownerTemp)).toEqual([]);
      expect([...host.harness.registrations.rpcMethods].sort()).toEqual(
        rpcMethods,
      );
      console.info(
        JSON.stringify({
          proof: "automation-script-owner",
          hostCalls: host.harness.experimental_hostRpcCalls.length,
          explicitPathAndProject: true,
          hostStorage: true,
          explicitEnvAndIds: true,
          inheritedOmnyoEnvironmentExcluded: true,
          exitOutputTimeoutAndCancellation: true,
          temporaryScriptsClosed: true,
          hostMethodPrivate: true,
          noLocalFallback: true,
        }),
      );
    } finally {
      await owner?.experimental_dispose();
      await host.harness.dispose();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
