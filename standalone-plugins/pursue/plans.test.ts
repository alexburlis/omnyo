import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { test, type TestContext } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";
import { z } from "zod";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { createPlanService, identifyPlan, planPath } from "./plans.ts";
import { executeSchema, previewSchema } from "./plan-contract.ts";

const document = [
  "# Test an OpenRouter teacher for a Gemma E2B Q4 student",
  "",
  "## Plan Metadata",
  "",
  "Schema: 2",
  "Kind: experiment",
  "State: implementation-ready",
  "Risk: elevated",
  "Boundary: external-or-stateful",
  "Mutation: none",
  "",
  "## Purpose / Big Picture",
  "",
  "Produce a measured student or an evidenced rejection.",
  "",
  "## Scope Contract",
  "",
  "Requested outcome: An implementation-ready plan.",
  "Authority: Planning only. The proposed USD 10 ceiling is not approval to spend.",
  "",
  "## Plan of Work",
  "",
  "Implement the runner and satisfy execution acceptance.",
  "",
  "## Concrete Steps",
  "",
  "Run the study runner and retain the measured result.",
  "",
  "## Validation and Acceptance",
  "",
  "Retain one measured result report.",
].join("\n");

function absoluteOnly(): never {
  throw new Error("Path must be absolute");
}

function fixture(t: TestContext) {
  const state = {
    content: document,
    environmentId: "env_source",
    hostId: "host_remote",
    root: "/workspace",
    model: "current-model",
    efforts: ["medium", "high", "ultra"],
    unavailable: false,
    brokenCatalog: false,
    spawnError: "none",
    spawnCount: 0,
    inheritTiers: false,
    modelTiers: ["default", "fast"],
    providerTiers: ["fast", "provider-custom-tier"],
    providerAvailable: true,
    ownerStatus: makeThreadResponse().status,
    ownerBlocked: false,
    producers: new Array<{ threadId: string; kind: string; label: string }>(),
    verdicts: new Array<{ threadId: string; producerId: string; verdict: string }>(),
    onSpawn: async (_child: ReturnType<typeof makeThreadResponse>) => {},
  };

  const children = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, { planExecutionKey?: string }>();

  const owner = (id = "thr_source") =>
    makeThreadResponse({
      id,
      projectId: "proj_test",
      environmentId: state.environmentId,
      providerId: "codex",
      status: state.ownerStatus,
    });

  const model = () => {
    const entry: Awaited<ReturnType<PluginApi["sdk"]["providers"]["models"]>>["models"][number] =
      {
        id: state.model,
        model: state.model,
        displayName: "Current Model",
        description: "Fixture model",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: state.efforts.map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
      };

    if (!state.inheritTiers) entry.supportedServiceTiers = state.modelTiers.map((id) => ({ id }));

    return entry;
  };

  const host = createFakePluginHost({
    pluginId: "pursue",
    sdk: {
      threads: {
        get: async ({ threadId }) => ({
          ...(children.get(threadId) ?? owner(threadId)),
          work: state.ownerBlocked
            ? {
                primary: { label: "blocked", reason: { text: "A required approval is missing." } },
                activity: [],
                waits: [],
                requiredInput: [{ id: "approval" }],
              }
            : null,
        }),
        defaultExecutionOptions: async () => ({
          model: state.model,
          reasoningLevel: "medium",
          serviceTier: "fast",
          permissionMode: "accept-edits",
          source: "thread",
        }),
        spawn: async (input) => {
          if (input.visibility === "hidden") {
            const judge = makeThreadResponse({
              id: "thr_judge",
              projectId: "proj_test",
              environmentId: state.environmentId,
              originPluginId: "pursue",
              status: "idle",
            });

            children.set(judge.id, judge);

            return judge;
          }

          state.spawnCount += 1;

          if (state.spawnError === "before") throw new Error("Transport outcome unknown");

          const child = makeThreadResponse({
            id: `thr_execution_${state.spawnCount}`,
            projectId: "proj_test",
            parentThreadId: input.parentThreadId,
            environmentId: state.environmentId,
            providerId: input.providerId,
            originPluginId: "pursue",
            status: "idle",
          });

          children.set(child.id, child);
          metadata.set(child.id, { planExecutionKey: input.pluginMetadata?.planExecutionKey });
          await state.onSpawn(child);

          if (state.spawnError === "after") throw new Error("Response lost after creation");

          return child;
        },
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            metadata: metadata.get(threadId) ?? {},
          })),
        }),
        list: async () =>
          [...children.values()].filter((child) => child.parentThreadId === "thr_source"),
        output: async () => ({ output: "MET" }),
        send: async () => {
          throw new Error("Unexpected continuation");
        },
      },
      environments: {
        get: async () => ({
          id: state.environmentId,
          name: null,
          projectId: "proj_test",
          hostId: state.hostId,
          path: state.root,
          isGitRepo: false,
          isWorktree: false,
          branchName: null,
          baseBranch: null,
          defaultBranch: null,
          mergeBaseBranch: null,
          status: "ready",
          environmentProviderId: null,
          lifecycle: { phase: "active", retireAt: null, teardown: null },
          hostLifecycle: "active",
          environmentProviderSelection: null,
          environmentProviderInstanceKey: null,
          managed: false,
          workspaceProvisionType: "unmanaged",
          createdAt: 0,
          updatedAt: 0,
        }),
      },
      files: {
        read: async ({ path }) => ({
          path: posix.isAbsolute(path) || win32.isAbsolute(path) ? path : absoluteOnly(),
          content: state.content,
          contentEncoding: "utf8",
          sizeBytes: Buffer.byteLength(state.content),
          sha256: createHash("sha256").update(state.content).digest("hex"),
        }),
      },
      experimental_inbox: {
        startProducer: async ({ threadId, kind, label }) => {
          state.producers.push({ threadId, kind, label });

          return {
            producer: {
              id: `producer_${state.producers.length}`,
              threadId,
              kind,
              label,
              status: "active",
              heldUntil: null,
              endedReason: null,
            },
            receiptId: null,
          };
        },
        settleProducer: async ({ threadId, producerId, verdict }) => {
          state.verdicts.push({ threadId, producerId, verdict });
          const started = state.producers[Number(producerId.slice("producer_".length)) - 1];
          const ended = verdict !== "unmet";

          return {
            producer: {
              id: producerId,
              threadId,
              kind: "goal",
              label: started?.label ?? "",
              status: ended ? "ended" : "active",
              heldUntil: null,
              endedReason: ended ? verdict : null,
            },
            receiptId: ended ? `receipt_${producerId}` : null,
          };
        },
      },
      providers: {
        models: async ({ providerId }) => ({
          providers: [
            {
              id: providerId,
              available: state.providerAvailable,
              capabilities: { supportsServiceTier: true },
              serviceTiers: state.providerTiers.map((id) => ({ id, label: id })),
            },
          ],
          permissionCeiling: "accept-edits",
          models: state.unavailable ? [] : [model()],
          selectedOnlyModels: state.unavailable ? [model()] : [],
          modelLoadError: state.brokenCatalog
            ? { message: "Fixture catalog unavailable", code: "unavailable" }
            : null,
        }),
      },
    },
  });

  const installed: string[] = [];

  const plans = createPlanService(host.api, async (threadId, projectId, objective) => {
    installed.push(threadId);
    await host.api.storage.kv.set(`fixture-goal:${threadId}`, { projectId, objective });
  });

  const reference = { sourceThreadId: "thr_source", href: "docs/renamed.md" };
  t.after(() => host.harness.lifecycle.dispose());

  return { host, state, plans, installed, reference, children, metadata };
}

async function executable(f: ReturnType<typeof fixture>) {
  const preview = previewSchema.parse(await f.plans.preview(f.reference));
  assert.equal(preview.kind, "plan");

  if (preview.kind !== "plan") throw new Error("Expected plan");

  return executeSchema.parse({
    ...f.reference,
    environmentId: preview.environmentId,
    sha256: preview.sha256,
    selection: preview.selection ?? {
      providerId: "codex",
      model: "current-model",
      reasoningLevel: "ultra",
      serviceTier: "default",
    },
    requestId: "request-1",
  });
}

test("classifies actual Schema 2 structure independently of its name and excludes ordinary Markdown", () => {
  assert.equal(identifyPlan(document)?.state, "implementation-ready");
  assert.equal(identifyPlan("# ExecPlan\n\nA reference to a plan is not a plan."), null);

  const legacy =
    "# Repair\n## Purpose / Big Picture\n## Progress\n## Surprises & Discoveries\n## Decision Log\n## Outcomes & Retrospective\n## Validation and Acceptance";

  assert.notEqual(identifyPlan(legacy), null);
});

test("content gates execution for finished checklists, missing work, draft and read-only reports", async (t) => {
  const f = fixture(t);
  const input = await executable(f);

  for (const content of [
    document + "\n\n## Progress\n\n- [x] Complete the measured result report.\n",
    document.replace("Implement the runner and satisfy execution acceptance.", ""),
    document.replace("State: implementation-ready", "State: draft"),
    document.replace("Kind: experiment", "Kind: report"),
    document.replace("State: implementation-ready", "State: blocked"),
  ]) {
    f.state.content = content;
    await assert.rejects(
      () =>
        f.plans.execute({ ...input, sha256: createHash("sha256").update(content).digest("hex") }),
      /(?:remaining|work|draft|execution plan|blocked)/iu,
    );
  }

  assert.equal(f.state.spawnCount, 0);
});

test("an executing plan without a recorded owner stays in progress without offering Execute", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  f.state.content =
    document.replace("State: implementation-ready", "State: executing") +
    "\n\n## Progress\n\n- [x] Prepare inputs.\n- [ ] Run the comparison.\n";
  f.state.ownerStatus = "active";

  await assert.rejects(
    () =>
      f.plans.execute({
        ...input,
        sha256: createHash("sha256").update(f.state.content).digest("hex"),
      }),
    /(?:progress|owner|executing)/iu,
  );
  const preview = await f.plans.preview(f.reference);
  assert.equal(preview.kind === "plan" && preview.execution.kind, "in-progress");
  assert.equal(f.state.spawnCount, 0);
});

test("one file on one host has one run across source chats, progress edits and service reloads", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  const first = await f.plans.execute(input);
  f.state.content += "\n\n## Progress\n\n- [x] Prepare inputs.\n- [ ] Retain the result.\n";
  const child = f.children.get("thr_execution_1");
  assert.ok(child);
  child.status = "active";
  const reloaded = createPlanService(f.host.api, async () => {});
  const reference = { ...f.reference, sourceThreadId: "thr_other" };
  const preview = await reloaded.preview(reference);
  assert.equal(preview.kind, "plan");

  if (preview.kind !== "plan") throw new Error("Expected plan");
  assert.deepEqual(preview.run, first);
  assert.equal(preview.execution.kind, "running");
  assert.deepEqual(
    await reloaded.execute({
      ...input,
      ...reference,
      sha256: preview.sha256,
      requestId: "other-chat",
    }),
    first,
  );
  assert.equal(f.state.spawnCount, 1);
});

test("the source chat's run bar lists only live runs it started", async (t) => {
  const f = fixture(t);
  await f.plans.execute(await executable(f));
  const child = f.children.get("thr_execution_1");
  assert.ok(child);
  child.title = "Execute: Consolidate collectors";

  assert.deepEqual(await f.plans.runs({ sourceThreadId: "thr_source" }), { runs: [] });

  child.status = "active";
  const [running] = (await f.plans.runs({ sourceThreadId: "thr_source" })).runs;
  assert.equal(running?.kind, "running");
  assert.equal(running?.threadId, "thr_execution_1");
  assert.equal(running?.title, "Consolidate collectors");
  assert.deepEqual(await f.plans.runs({ sourceThreadId: "thr_other" }), { runs: [] });

  f.state.ownerBlocked = true;
  const [blocked] = (await f.plans.runs({ sourceThreadId: "thr_source" })).runs;
  assert.equal(blocked?.kind, "blocked");
  assert.equal(blocked?.message, "A required approval is missing.");

  child.archivedAt = Date.now();
  assert.deepEqual(await f.plans.runs({ sourceThreadId: "thr_source" }), { runs: [] });
});

test("simultaneous source chats reserve one run while another file remains independent", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  await Promise.all([
    f.plans.execute(input),
    f.plans.execute({ ...input, sourceThreadId: "thr_other" }),
  ]);
  assert.equal(f.state.spawnCount, 1);
  await f.plans.execute({ ...input, href: "docs/independent.md" });
  assert.equal(f.state.spawnCount, 2);
});

test("preserves POSIX path case while reconciling Windows drive aliases", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  await f.plans.execute({ ...input, href: "/workspace/Case.md" });
  await f.plans.execute({ ...input, href: "/workspace/case.md" });
  assert.equal(f.state.spawnCount, 2);
  await f.plans.execute({ ...input, href: "C:\\plans\\Case.md" });
  await f.plans.execute({ ...input, href: "c:/PLANS/case.md" });
  assert.equal(f.state.spawnCount, 3);
});

test("never treats fenced examples, longer outer fences or templates as executable plans", () => {
  for (const content of [
    "````markdown\n```\n" + document + "\n```\n````",
    "~~~markdown\n" + document + "\n~~~",
    document.replace(
      "# Test an OpenRouter teacher for a Gemma E2B Q4 student",
      "# Execution plan template",
    ),
    document.replace("Kind: experiment", "Kind: <kind>"),
  ]) {
    assert.equal(identifyPlan(content), null);
  }
});

test("legacy run ownership is retained across chats and conflicting owners block new launches", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  const first = await f.plans.execute(input);
  const child = f.children.get(first.kind === "started" ? first.threadId : "");
  assert.ok(child);
  await f.plans.initialize(child);
  const keys = await f.host.api.storage.kv.list("plan-run:");
  const current = keys[0];

  const legacyKey = createHash("sha256")
    .update(
      JSON.stringify(["thr_source", "env_source", "host_remote", "/workspace/docs/renamed.md"]),
    )
    .digest("hex");

  const record = await f.host.api.storage.kv.get(current);
  const stored = z.record(z.string(), z.unknown()).parse(record);
  await f.host.api.storage.kv.set(`plan-run:${legacyKey}`, { ...stored, key: legacyKey });
  await f.host.api.storage.kv.delete(current);
  const reloaded = createPlanService(f.host.api, async () => {});
  assert.deepEqual(await reloaded.execute({ ...input, sourceThreadId: "thr_other" }), first);
  f.state.ownerBlocked = true;
  const blocked = await reloaded.preview(f.reference);
  assert.equal(blocked.kind === "plan" && blocked.execution.kind, "blocked");
  const duplicateKey = "d".repeat(64);
  await f.host.api.storage.kv.set(`plan-run:${duplicateKey}`, { ...stored, key: duplicateKey });
  const conflicted = createPlanService(f.host.api, async () => {});
  await assert.rejects(() => conflicted.execute(input), /Multiple runs already own/u);
  assert.equal(f.state.spawnCount, 1);
});

test("routes relative and absolute plan files through their source workspace machine", async (t) => {
  const f = fixture(t);
  await f.plans.preview(f.reference);
  assert.deepEqual(f.host.harness.inspection.sdk.callsTo("files.read")[0][0], {
    hostId: "host_remote",
    path: "/workspace/docs/renamed.md",
    rootPath: "/workspace",
  });
  await f.plans.preview({ ...f.reference, href: "C:\\plans\\student.md#L3-L8" });
  assert.deepEqual(f.host.harness.inspection.sdk.callsTo("files.read")[1][0], {
    hostId: "host_remote",
    path: "C:\\plans\\student.md",
  });
  f.state.root = "C:\\work";
  await f.plans.preview({ ...f.reference, href: "./docs\\student.md" });
  assert.deepEqual(f.host.harness.inspection.sdk.callsTo("files.read")[2][0], {
    hostId: "host_remote",
    path: "C:\\work\\docs\\student.md",
    rootPath: "C:\\work",
  });
  assert.equal(planPath("/owned/plan.md:12"), "/owned/plan.md");
  await assert.rejects(
    () => f.plans.preview({ ...f.reference, href: "https://example.com/plan.md" }),
    /local Markdown/u,
  );
});

test("default preserves the current provider/model, chooses supported Ultra, and uses standard speed", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  assert.deepEqual(input.selection, {
    providerId: "codex",
    model: "current-model",
    reasoningLevel: "ultra",
    serviceTier: "default",
  });
  f.state.efforts = ["low", "medium", "high"];
  assert.equal((await executable(f)).selection.reasoningLevel, "high");
  f.state.efforts = ["provider-custom"];
  f.state.model = "custom-model";
  await f.plans.saveDefaults({
    kind: "fixed",
    selection: {
      providerId: "other-provider",
      model: "custom-model",
      reasoningLevel: "provider-custom",
    },
  });
  assert.equal((await executable(f)).selection.reasoningLevel, "provider-custom");
});

test("settings saves apply immediately and survive service reconstruction", async (t) => {
  const f = fixture(t);
  await f.plans.saveDefaults({
    kind: "fixed",
    selection: { providerId: "other", model: "current-model", reasoningLevel: "medium" },
  });
  assert.equal((await executable(f)).selection.providerId, "other");
  const reloaded = createPlanService(f.host.api, async () => {});
  assert.equal((await reloaded.defaults()).kind, "fixed");
  await reloaded.saveDefaults({ kind: "current-chat-ultra" });
  assert.equal((await executable(f)).selection.providerId, "codex");
});

test("unavailable and failed catalogs never select a stand-in model", async (t) => {
  const f = fixture(t);
  f.state.unavailable = true;
  const unavailable = await f.plans.preview(f.reference);
  assert.equal(unavailable.kind, "plan");
  assert.match(
    unavailable.kind === "plan" ? (unavailable.selectionIssue ?? "") : "",
    /unavailable/u,
  );
  await assert.rejects(async () => f.plans.execute(await executable(f)), /unavailable/u);
  f.state.unavailable = false;
  f.state.brokenCatalog = true;
  await assert.rejects(() => executable(f), /catalog is unavailable/u);
  assert.equal(f.state.spawnCount, 0);
});

test("revalidates the file hash, workspace and selected capability before starting", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  f.state.content += "\nChanged acceptance";
  await assert.rejects(() => f.plans.execute(input), /plan changed/u);
  f.state.content = document;
  f.state.environmentId = "env_other";
  await assert.rejects(() => f.plans.execute(input), /workspace changed/u);
  f.state.environmentId = "env_source";
  await assert.rejects(
    () =>
      f.plans.execute({
        ...input,
        selection: { ...input.selection, reasoningLevel: "not-supported" },
      }),
    /reasoning level/u,
  );
  await assert.rejects(
    () =>
      f.plans.execute({
        ...input,
        selection: { ...input.selection, serviceTier: "not-supported" },
      }),
    /service tier/u,
  );
  assert.equal(f.state.spawnCount, 0);
});

for (const completedState of ["complete", "   CoMpLeTe   "]) {
  test(`completed plan state ${JSON.stringify(completedState)} refuses a new execution`, async (t) => {
    const f = fixture(t);
    f.state.content = document.replace("State: implementation-ready", `State: ${completedState}`);
    const input = await executable(f);
    const catalogCalls = f.host.harness.inspection.sdk.callsTo("providers.models").length;
    f.state.brokenCatalog = true;

    await assert.rejects(() => f.plans.execute(input), /plan is already complete/iu);
    assert.equal(f.host.harness.inspection.sdk.callsTo("providers.models").length, catalogCalls);
    assert.equal(f.state.spawnCount, 0);
    assert.equal(f.installed.length, 0);
  });
}

test("a ready preview cannot start a plan whose saved state has become complete", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  f.state.content = document.replace("State: implementation-ready", "State: complete");
  f.state.brokenCatalog = true;

  await assert.rejects(() => f.plans.execute(input), /plan is already complete/iu);
  assert.equal(f.state.spawnCount, 0);
  assert.equal(f.installed.length, 0);
});

test("RPC and CLI reject a completed saved plan without creating a run", async (t) => {
  const f = fixture(t);
  await plugin(f.host.api);
  f.state.content = document.replace("State: implementation-ready", "State: complete");
  const input = await executable(f);

  await assert.rejects(
    () => f.host.harness.behavior.callRpc("pursue_plan_execute", input),
    /plan is already complete/iu,
  );

  const result = await f.host.harness.behavior.runCli(["plan", "execute", f.reference.href], {
    threadId: f.reference.sourceThreadId,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /plan is already complete/iu);
  assert.equal(f.state.spawnCount, 0);
});

for (const spawnError of ["none", "before"]) {
  test(`a completed plan preserves its existing ${spawnError === "none" ? "started" : "pending"} run`, async (t) => {
    const f = fixture(t);
    f.state.spawnError = spawnError;
    const input = await executable(f);
    const first = await f.plans.execute(input);
    assert.equal(first.kind, spawnError === "none" ? "started" : "pending");
    f.state.content = document.replace("State: implementation-ready", "State: complete");
    f.state.brokenCatalog = true;

    assert.deepEqual(await f.plans.execute(input), first);
    const preview = await f.plans.preview(f.reference);
    assert.equal(preview.kind, "plan");
    assert.deepEqual(preview.kind === "plan" ? preview.run : null, first);
    assert.equal(f.state.spawnCount, 1);
  });
}

test("parallel clicks and retries share one dedicated run with inherited permission and bounded authority", async (t) => {
  const f = fixture(t);
  const input = await executable(f);

  const results = await Promise.all([
    f.plans.execute(input),
    f.plans.execute({ ...input, requestId: "request-2" }),
  ]);

  assert.equal(f.state.spawnCount, 1);
  const result = await f.plans.execute(input);
  assert.equal(result.kind, "started");
  assert.ok(results.some((entry) => entry.kind === "started"));
  assert.deepEqual(
    result,
    await f.plans.execute({
      ...input,
      selection: { ...input.selection, reasoningLevel: "medium" },
    }),
  );

  const sent = z
    .object({
      parentThreadId: z.string(),
      environment: z.object({ type: z.string(), environmentId: z.string() }),
      providerId: z.string(),
      permissionMode: z.string(),
      prompt: z.string(),
    })
    .parse(f.host.harness.inspection.sdk.callsTo("threads.spawn")[0][0]);

  assert.equal(sent.parentThreadId, "thr_source");
  assert.deepEqual(sent.environment, { type: "reuse", environmentId: "env_source" });
  assert.equal(sent.providerId, "codex");
  assert.equal(sent.permissionMode, "accept-edits");
  assert.match(sent.prompt ?? "", /does not approve new provider spend/u);
  assert.match(sent.prompt ?? "", /planning-only turn is historical context/u);
  assert.match(sent.prompt ?? "", /execution acceptance/u);
  assert.match(sent.prompt ?? "", /omnyo pursue goal clear/u);
  const child = f.children.get(result.kind === "started" ? result.threadId : "");
  assert.ok(child);
  await f.plans.initialize(child);
  assert.equal(f.installed.length, 1);
});

test("Execute returns the started run without waiting for its goal setup", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const installed: string[] = [];

  const plans = createPlanService(f.host.api, async (threadId) => {
    await gate;
    installed.push(threadId);
  });

  const result = await plans.execute(await executable(f));
  assert.equal(result.kind, "started");
  assert.deepEqual(installed, []);
  assert.deepEqual(await plans.execute(await executable(f)), result);
  release();
  const child = f.children.get(result.kind === "started" ? result.threadId : "");
  assert.ok(child);
  await plans.initialize(child);
  assert.deepEqual(installed, [child.id]);
  const [key] = await f.host.api.storage.kv.list("plan-run:");

  assert.equal(
    z.object({ goalInitialized: z.boolean() }).parse(await f.host.api.storage.kv.get(key))
      .goalInitialized,
    true,
  );
  assert.equal(f.state.spawnCount, 1);
});

test("ambiguous start is never replayed and recovers a response-lost child by exact metadata", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  f.state.spawnError = "before";
  assert.equal((await f.plans.execute(input)).kind, "pending");
  assert.equal((await f.plans.execute(input)).kind, "pending");
  assert.equal(f.state.spawnCount, 1);
  f.reference.href = "docs/separate-plan.md";
  f.state.spawnError = "after";
  const next = await executable(f);
  assert.equal((await f.plans.execute(next)).kind, "started");
  assert.equal((await f.plans.execute(next)).kind, "started");
  assert.equal(f.state.spawnCount, 2);
});

test("a moved conversation never reuses a run on its old workspace or machine", async (t) => {
  const f = fixture(t);
  f.reference.href = "/shared/plan.md";
  const first = await f.plans.execute(await executable(f));
  assert.equal(first.kind, "started");
  f.state.environmentId = "env_other";
  f.state.hostId = "host_other";
  const preview = await f.plans.preview(f.reference);
  assert.equal(preview.kind, "plan");
  assert.equal(preview.kind === "plan" ? preview.run : "unexpected", null);
  await f.plans.execute(await executable(f));
  assert.equal(f.state.spawnCount, 2);
});

test("goal is initialized before an early idle evaluation and completion never resurrects it", async (t) => {
  const f = fixture(t);
  await plugin(f.host.api);
  f.state.onSpawn = async (child) => {
    await f.host.harness.behavior.emitThreadEvent("thread.created", { thread: child });
    const goals = await f.host.api.storage.kv.get<Record<string, { objective: string }>>("goals");
    assert.match(
      goals?.[child.id]?.objective ?? "",
      /complete its implementation phases and execution acceptance/u,
    );
    await f.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: child,
      lastAssistantText: "Implementation and execution acceptance are complete.",
    });
  };

  const input = await executable(f);
  const result = await f.host.harness.behavior.callRpc("pursue_plan_execute", input);
  assert.equal(result.kind, "started");
  const child = f.children.get(result.threadId);
  assert.ok(child);
  assert.equal(
    (await f.host.api.storage.kv.get<Record<string, { objective: string }>>("goals"))?.[child.id],
    undefined,
  );
  await f.host.harness.behavior.emitThreadEvent("thread.created", { thread: child });
  await f.host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: child,
    lastAssistantText: "Already complete.",
  });
  assert.equal(
    (await f.host.api.storage.kv.get<Record<string, { objective: string }>>("goals"))?.[child.id],
    undefined,
  );
  assert.deepEqual(
    f.state.producers.map(({ threadId, kind }) => ({ threadId, kind })),
    [{ threadId: child.id, kind: "goal" }],
  );
  assert.match(f.state.producers[0]?.label ?? "", /^Pursuing: /u);
  assert.deepEqual(f.state.verdicts, [
    { threadId: child.id, producerId: "producer_1", verdict: "met" },
  ]);
  assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 2);
});

test("an unavailable saved default remains selectable without a substitute or automatic execution", async (t) => {
  const f = fixture(t);
  await f.plans.saveDefaults({
    kind: "fixed",
    selection: { providerId: "other-provider", model: "missing-model", reasoningLevel: "ultra" },
  });
  const preview = await f.plans.preview(f.reference);
  assert.equal(preview.kind, "plan");

  if (preview.kind !== "plan") throw new Error("Expected plan");
  assert.equal(preview.selection.model, "missing-model");
  assert.match(preview.selectionIssue ?? "", /unavailable/u);
  const input = await executable(f);
  await assert.rejects(() => f.plans.execute(input), /unavailable/u);
  assert.equal(
    (
      await f.plans.execute({
        ...input,
        selection: {
          providerId: "codex",
          model: "current-model",
          reasoningLevel: "high",
          serviceTier: "default",
        },
      })
    ).kind,
    "started",
  );
  assert.equal(f.state.spawnCount, 1);
});

test("explicit provider service tiers inherit when the model does not narrow them", async (t) => {
  const f = fixture(t);
  f.state.inheritTiers = true;

  const input = await executable(f);

  const result = await f.plans.execute({
    ...input,
    selection: { ...input.selection, serviceTier: "provider-custom-tier" },
  });

  assert.equal(result.kind, "started");
  assert.equal(
    result.kind === "started" ? result.selection.serviceTier : "",
    "provider-custom-tier",
  );
  f.reference.href = "docs/tier-restriction-plan.md";
  f.state.inheritTiers = false;
  const restricted = await executable(f);
  await assert.rejects(
    () =>
      f.plans.execute({
        ...restricted,
        selection: { ...restricted.selection, serviceTier: "provider-custom-tier" },
      }),
    /service tier/u,
  );
  f.state.providerAvailable = false;
  const preview = await f.plans.preview(f.reference);
  assert.equal(preview.kind, "plan");
  assert.match(
    preview.kind === "plan" ? (preview.selectionIssue ?? "") : "",
    /provider is unavailable/u,
  );
});

test("progress updates keep the existing execution for the same saved plan file", async (t) => {
  const f = fixture(t);
  const input = await executable(f);
  const first = await f.plans.execute(input);
  f.state.content += "\n## Progress\n\n- [x] The research runner is implemented.";
  const refreshed = await f.plans.preview(f.reference);
  assert.equal(refreshed.kind, "plan");
  assert.notEqual(refreshed.kind === "plan" ? refreshed.sha256 : "", input.sha256);
  const next = await f.plans.execute(await executable(f));
  assert.deepEqual(next, first);
  assert.equal(f.state.spawnCount, 1);
});
