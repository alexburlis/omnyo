import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  defaultsSchema,
  selectionSchema,
  type ExecutePlan,
  type LiveExecution,
  type PlanDefaults,
  type PlanReference,
  type PlanExecution,
  type PlanRuns,
  type Selection,
} from "./plan-contract.ts";

const maximumPlanBytes = 256 * 1024;

const ownerWorkSchema = z.object({
  work: z
    .object({
      primary: z.object({ label: z.string(), reason: z.object({ text: z.string() }) }),
      requiredInput: z.array(z.object({ id: z.string() })),
      activity: z.array(z.object({ id: z.string(), phase: z.enum(["running", "queued"]) })),
      waits: z.array(z.object({ id: z.string() })),
    })
    .nullable(),
});

const recordSchema = z.object({
  key: z.string(),
  sourceThreadId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  path: z.string(),
  sha256: z.string(),
  objective: z.string(),
  selection: selectionSchema,
  requestId: z.string(),
  createdAt: z.string(),
  goalInitialized: z.boolean(),
  threadId: z.string().nullable(),
  phase: z.enum(["starting", "started", "uncertain"]),
});

type RunRecord = z.infer<typeof recordSchema>;

type Thread = Awaited<ReturnType<PluginApi["sdk"]["threads"]["get"]>>;

type Catalog = Awaited<ReturnType<PluginApi["sdk"]["providers"]["models"]>>;

type GoalInstaller = (threadId: string, projectId: string, objective: string) => Promise<void>;

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const windowsPath = (path: string) => /^(?:[a-z]:[\\/]|\\\\)/iu.test(path);

function outsideCode(content: string, keepBodies = false) {
  let fence: { character: string; length: number } | null = null;

  return content
    .split(/\r?\n/u)
    .flatMap((line) => {
      const delimiter = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);

      if (delimiter) {
        if (fence === null) fence = { character: delimiter[1][0], length: delimiter[1].length };
        else if (
          delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length &&
          delimiter[2].trim() === ""
        )
          fence = null;

        return [];
      }

      return fence === null ? [line] : keepBodies ? [`    ${line}`] : [];
    })
    .join("\n");
}

export function identifyPlan(content: string) {
  const text = outsideCode(content);

  const headings = new Set(
    [...text.matchAll(/^##\s+(.+?)\s*#*$/gmu)].map((match) => match[1].trim().toLowerCase()),
  );

  const purpose = headings.has("purpose / big picture");

  const metadata =
    /^##\s+Plan Metadata\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/imu.exec(text)?.[1] ?? "";

  const schemaTwo =
    /^Schema:\s*2\s*$/imu.test(metadata) && purpose && headings.has("scope contract");

  const legacy =
    purpose &&
    headings.has("progress") &&
    headings.has("decision log") &&
    headings.has("surprises & discoveries") &&
    headings.has("outcomes & retrospective") &&
    (headings.has("validation and acceptance") || headings.has("validation"));

  if (!schemaTwo && !legacy) return null;

  if (
    schemaTwo &&
    !/^(?:Kind):\s*(?:bug|feature|refactor|migration|experiment|operations)\s*$/imu.test(metadata)
  )
    return null;

  if (
    /^#.*\b(?:template|skeleton)\b/imu.test(text) ||
    /^(?:State|Kind|Boundary|Mutation):\s*</imu.test(metadata)
  )
    return null;

  const state = (/^State:\s*(.+)$/imu.exec(metadata)?.[1]?.trim() ?? "unspecified").toLowerCase();

  const section = (name: string, includeCode = false) => {
    const lines = (includeCode ? outsideCode(content, true) : text).split(/\r?\n/u);
    const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`);

    if (start === -1) return "";
    const end = lines.findIndex((line, index) => index > start && /^##\s/u.test(line));

    return lines
      .slice(start + 1, end === -1 ? undefined : end)
      .join("\n")
      .trim();
  };

  const progress = section("progress");
  const tasks = [...progress.matchAll(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+\S/gmu)];
  const remaining = tasks.some((task) => task[1] === " ");
  const work = section("plan of work", true);
  const steps = section("concrete steps", true);
  const acceptance = section("validation and acceptance", true) || section("validation", true);
  let execution: PlanExecution;

  if (state === "complete")
    execution = remaining
      ? {
          kind: "blocked",
          message: "The completed state conflicts with remaining progress items. Review the plan.",
        }
      : { kind: "complete" };
  else if (state === "blocked")
    execution = {
      kind: "blocked",
      message: "The plan is blocked. Resolve its recorded gate before execution.",
    };
  else if (tasks.length > 0 && !remaining)
    execution = {
      kind: "no-work",
      message: "No remaining progress items. Review the outcome before reopening execution.",
    };
  else if (work === "" || acceptance === "" || (!remaining && steps === ""))
    execution = {
      kind: "no-work",
      message: "The document has no executable work with acceptance checks.",
    };
  else if (state === "executing")
    execution = {
      kind: "in-progress",
      message: "Execution is in progress; its owner is not linked. No new run will be started.",
    };
  else if (state === "implementation-ready") execution = { kind: "actionable" };
  else
    execution = {
      kind: "draft",
      message: "Prepare an implementation-ready plan with remaining work before execution.",
    };

  return {
    title: (/^#\s+(.+?)\s*#*$/mu.exec(text)?.[1]?.trim() ?? "Execution plan").slice(0, 200),
    state: state.slice(0, 100),
    execution,
  };
}

export function planPath(href: string) {
  const path = href.trim().replace(/(?::[1-9][0-9]*|#L[1-9][0-9]*(?:-L?[1-9][0-9]*)?)$/u, "");

  if (/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^[A-Za-z]:[\\/]/u.test(path))
    throw new Error("Plan execution requires a local Markdown file.");

  if (/\p{Cc}/u.test(path)) throw new Error("Invalid plan path.");

  return path.replace(/^\.\//u, "");
}

export function strongestEffort(model: Catalog["models"][number]) {
  const supported = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);

  for (const effort of [...effortOrder].reverse()) {
    if (supported.includes(effort)) return effort;
  }

  return model.defaultReasoningEffort;
}

function modelFrom(catalog: Catalog, selection: Pick<Selection, "providerId" | "model">) {
  if (catalog.modelLoadError)
    throw new Error("The model catalog is unavailable. Try again when the provider is ready.");

  const provider = catalog.providers.find((entry) => entry.id === selection.providerId);

  if (provider !== undefined && !provider.available)
    throw new Error("The selected provider is unavailable in this workspace.");

  const model = catalog.models.find(
    (entry) =>
      (entry.model === selection.model || entry.id === selection.model) &&
      (entry.routeProviderId === undefined || entry.routeProviderId === selection.providerId),
  );

  if (!model)
    throw new Error(
      "The selected model is unavailable in this workspace. Choose an available model.",
    );

  return model;
}

export function validateSelection(catalog: Catalog, selection: Selection) {
  const model = modelFrom(catalog, selection);
  const efforts = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);

  if (
    !(efforts.length === 0
      ? model.defaultReasoningEffort === selection.reasoningLevel
      : efforts.includes(selection.reasoningLevel))
  )
    throw new Error("The selected model does not support this reasoning level.");
  const tier = selection.serviceTier ?? "default";

  const provider = catalog.providers.find((entry) => entry.id === selection.providerId);

  const providerTier =
    provider?.capabilities.supportsServiceTier === true &&
    provider.serviceTiers?.some((entry) => entry.id === tier);

  const modelTier =
    model.supportedServiceTiers === undefined ||
    model.supportedServiceTiers.some((entry) => entry.id === tier);

  if (tier !== "default" && (!providerTier || !modelTier))
    throw new Error("The selected model does not support this service tier.");

  return { ...selection, model: model.model, serviceTier: tier };
}

export function planObjective(path: string) {
  return `Execute the implementation or experiment described in ${path}, complete its implementation phases and execution acceptance checks, and retain concrete result evidence. A plan file or planning-readiness check alone does not meet this goal.`;
}

function executionPrompt(record: RunRecord) {
  return [
    `Execute the implementation or experiment described in this saved plan: ${JSON.stringify(record.path)}.`,
    `Plan SHA-256 at selection: ${record.sha256}. Source conversation: @thread:${record.sourceThreadId}.`,
    "Read the entire plan and the current workspace instructions before acting. Verify the selected SHA-256; if the file changed, stop and report that a refreshed selection is required. Update the plan's progress and retain the evidence required by its execution acceptance criteria.",
    "This is an execution request. A scope paragraph recording the earlier planning-only turn is historical context; distinguish it from the proposed implementation phases and execution acceptance. Merely checking that the document exists or is implementation-ready does not complete this request.",
    "The Execute click authorizes starting implementation within current authority. It does not approve new provider spend, paid features, purchases, new accounts, publication, deployment, data deletion or other effects beyond existing explicit authority. Preserve every budget and approval gate in the plan and current instructions.",
    "Work until the implementation and its execution acceptance are complete. Do not replace the requested work with a new plan or a to-do list.",
    "Goals checks this run independently. If only the user or an external approval can unblock the next required action, clear this run's goal with `omnyo pursue goal clear`, report the exact gate and next actor, and stop. Never iterate against missing authority or credentials.",
  ].join("\n\n");
}

export function createPlanService(api: PluginApi, installGoal: GoalInstaller) {
  const locks = new Map<string, Promise<void>>();

  async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation);

    const settled = result.then(
      () => undefined,
      () => undefined,
    );

    locks.set(key, settled);

    try {
      return await result;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  }

  const readRecord = async (key: string) => {
    const stored = await api.storage.kv.get(`plan-run:${key}`);

    return stored == null ? null : recordSchema.parse(stored);
  };

  const fileIdentity = (hostId: string, path: string) =>
    JSON.stringify([
      hostId,
      windowsPath(path) ? win32.normalize(path).toLowerCase() : posix.normalize(path),
    ]);

  let legacyRecords: Promise<RunRecord[]> | undefined;

  async function existingRecord(plan: { key: string; hostId: string; path: string }) {
    const current = await readRecord(plan.key);
    legacyRecords ??= (async () => {
      const keys = await api.storage.kv.list("plan-run:");
      const records: RunRecord[] = [];

      for (let offset = 0; offset < keys.length; offset += 16) {
        const batch = await Promise.all(
          keys.slice(offset, offset + 16).map((key) => api.storage.kv.get(key)),
        );

        for (const value of batch) {
          if (value != null) records.push(recordSchema.parse(value));
        }
      }

      return records;
    })();
    const identity = fileIdentity(plan.hostId, plan.path);

    const matches = (await legacyRecords).filter(
      (record) => fileIdentity(record.hostId, record.path) === identity && record.key !== plan.key,
    );

    if (matches.length > 1 || (current !== null && matches.length > 0))
      throw new Error(
        "Multiple runs already own this plan file. Inspect the existing chats; no new run will be started.",
      );

    return current ?? (matches.length === 1 ? await readRecord(matches[0].key) : null);
  }

  const writeRecord = (record: RunRecord) => api.storage.kv.set(`plan-run:${record.key}`, record);

  async function defaults(): Promise<PlanDefaults> {
    const stored = await api.storage.kv.get("plan-defaults");

    return stored == null ? { kind: "current-chat-ultra" } : defaultsSchema.parse(stored);
  }

  async function saveDefaults(value: PlanDefaults) {
    await api.storage.kv.set("plan-defaults", defaultsSchema.parse(value));
    api.realtime.publish("pursue-plan-defaults-changed", null);

    return value;
  }

  async function readPlan(reference: PlanReference, expectedEnvironmentId?: string) {
    const path = planPath(reference.href);

    if (!/\.(?:md|markdown)$/iu.test(path)) return null;

    const [thread, expected] = await Promise.all([
      api.sdk.threads.get({ threadId: reference.sourceThreadId }),
      expectedEnvironmentId === undefined
        ? null
        : api.sdk.environments.get({ environmentId: expectedEnvironmentId }),
    ]);

    if (thread.environmentId === null)
      throw new Error("This conversation has no workspace for plan execution.");

    if (expectedEnvironmentId !== undefined && thread.environmentId !== expectedEnvironmentId)
      throw new Error("The workspace changed. Refresh the card before executing.");

    const environment =
      expected ?? (await api.sdk.environments.get({ environmentId: thread.environmentId }));

    if (environment.path === null) throw new Error("The plan workspace is not ready.");
    const root = environment.path;

    const file = await api.sdk.files.read(
      posix.isAbsolute(path) || win32.isAbsolute(path)
        ? { hostId: environment.hostId, path }
        : {
            hostId: environment.hostId,
            path: windowsPath(root) ? win32.join(root, path) : posix.join(root, path),
            rootPath: root,
          },
    );

    if (
      file.contentEncoding !== "utf8" ||
      file.sizeBytes > maximumPlanBytes ||
      Buffer.byteLength(file.content, "utf8") > maximumPlanBytes
    )
      throw new Error("Plan actions support UTF-8 Markdown files up to 256 KiB.");
    const identified = identifyPlan(file.content);

    if (identified === null) return null;
    const sha256 = createHash("sha256").update(file.content, "utf8").digest("hex");

    const key = createHash("sha256")
      .update(fileIdentity(environment.hostId, file.path))
      .digest("hex");

    return {
      ...identified,
      path: file.path,
      sha256,
      key,
      thread,
      environmentId: thread.environmentId,
      hostId: environment.hostId,
    };
  }

  async function selectionFor(thread: Thread, environmentId: string) {
    const config = await defaults();

    const [current, catalog] = await Promise.all([
      config.kind === "fixed"
        ? null
        : api.sdk.threads.defaultExecutionOptions({ threadId: thread.id }),
      api.sdk.providers.models({
        providerId: config.kind === "fixed" ? config.selection.providerId : thread.providerId,
        environmentId,
      }),
    ]);

    if (config.kind !== "fixed" && current === null)
      throw new Error(
        "This conversation has no resolved model. Choose a model in Goals settings.",
      );

    const requested: Selection =
      config.kind === "fixed"
        ? config.selection
        : {
            providerId: thread.providerId,
            model: current?.model ?? "",
            reasoningLevel: "ultra",
            serviceTier: "default",
          };

    if (catalog.modelLoadError)
      throw new Error("The model catalog is unavailable. Try again when the provider is ready.");

    try {
      const model = modelFrom(catalog, requested);

      const selection =
        config.kind === "fixed"
          ? validateSelection(catalog, requested)
          : validateSelection(catalog, {
              ...requested,
              model: model.model,
              reasoningLevel: strongestEffort(model),
            });

      return { selection, selectionIssue: null };
    } catch (cause) {
      return {
        selection: requested,
        selectionIssue:
          cause instanceof Error ? cause.message : "Choose an available execution model.",
      };
    }
  }

  async function initialize(thread: Thread) {
    if (thread.originPluginId !== "pursue") return;
    const metadata = await api.sdk.threads.getPluginMetadata({ threadId: thread.id });

    const key = z
      .object({ planExecutionKey: z.string().regex(/^[a-f0-9]{64}$/u) })
      .safeParse(metadata);

    if (!key.success) return;
    await locked(key.data.planExecutionKey, async () => {
      const record = await readRecord(key.data.planExecutionKey);

      if (record === null || !ownedBy(record, thread))
        throw new Error("The execution thread does not match its saved plan.");

      if (record.threadId !== null && record.threadId !== thread.id)
        throw new Error("A different thread already owns this plan execution.");

      if (record.goalInitialized) return;
      await installGoal(thread.id, thread.projectId, record.objective);
      await writeRecord({
        ...record,
        threadId: thread.id,
        phase: "started",
        goalInitialized: true,
      });
    });
  }

  function ownedBy(record: RunRecord, thread: Thread) {
    return (
      record.projectId === thread.projectId &&
      thread.parentThreadId === record.sourceThreadId &&
      thread.environmentId === record.environmentId
    );
  }

  async function recover(record: RunRecord) {
    if (record.threadId !== null) return record;

    const candidates = await api.sdk.threads.list({
      parentThreadId: record.sourceThreadId,
      originPluginId: "pursue",
      includeHidden: false,
      limit: 100,
    });

    if (candidates.length === 0) return record;

    const metadata = await api.sdk.threads.experimental_listPluginMetadata({
      threadIds: candidates.map((thread) => thread.id),
    });

    const matching = metadata.threads.filter(
      (entry) => entry.metadata.planExecutionKey === record.key,
    );

    if (matching.length > 1)
      throw new Error(
        "Multiple runs match this plan. Inspect the execution chats before continuing.",
      );

    if (matching.length === 1) {
      await initialize(await api.sdk.threads.get({ threadId: matching[0].threadId }));

      return (await readRecord(record.key)) ?? record;
    }

    return record;
  }

  function runResult(record: RunRecord) {
    return record.threadId === null
      ? {
          kind: "pending" as const,
          message:
            "Execution start is unconfirmed. Check again to reconcile the existing request; no duplicate run will be started.",
        }
      : { kind: "started" as const, threadId: record.threadId, selection: record.selection };
  }

  function ownerExecution(owner: Thread): LiveExecution | null {
    const { work } = ownerWorkSchema.parse(owner);

    if (
      work?.requiredInput.length ||
      work?.primary.label === "blocked" ||
      work?.primary.label === "external"
    )
      return { kind: "blocked", message: work.primary.reason.text };

    if (
      ["active", "starting"].includes(owner.status) ||
      work?.activity.some((item) => item.phase === "running")
    )
      return { kind: "running", threadId: owner.id };

    if (
      owner.queuedMessageCount > 0 ||
      owner.status === "pending" ||
      owner.status === "stopping" ||
      work?.primary.label === "waiting" ||
      (work?.waits.length ?? 0) > 0
    )
      return {
        kind: "in-progress",
        message: "The existing run is queued, stopping or waiting for its recorded dependency.",
      };

    return null;
  }

  // Live plan runs a conversation started, for the bar above its composer.
  // Idle, archived and deleted runs drop out; the plan's file card keeps them.
  async function runs({ sourceThreadId }: { sourceThreadId: string }): Promise<PlanRuns> {
    const keys = await api.storage.kv.list("plan-run:");
    const records: RunRecord[] = [];

    for (let offset = 0; offset < keys.length; offset += 16) {
      const batch = await Promise.all(
        keys.slice(offset, offset + 16).map((key) => api.storage.kv.get(key)),
      );

      for (const value of batch) {
        const record = recordSchema.safeParse(value);

        if (record.success && record.data.sourceThreadId === sourceThreadId)
          records.push(record.data);
      }
    }

    const rows = await Promise.all(
      records.map(async (stored): Promise<PlanRuns["runs"][number] | null> => {
        const record = await recover(stored);
        const fallback = posix.basename(record.path.replaceAll("\\", "/"));
        const result = runResult(record);

        if (result.kind === "pending")
          return {
            kind: "pending",
            threadId: null,
            title: fallback,
            message: result.message,
            createdAt: record.createdAt,
          };

        const owner = await api.sdk.threads.get({ threadId: result.threadId }).catch(() => null);

        if (owner === null || owner.archivedAt !== null || owner.deletedAt !== null) return null;
        const live = ownerExecution(owner);

        if (live === null) return null;

        return {
          kind: live.kind,
          threadId: owner.id,
          title: owner.title?.replace(/^Execute:\s*/u, "") || fallback,
          message: live.kind === "running" ? null : live.message,
          createdAt: record.createdAt,
        };
      }),
    );

    return {
      runs: rows
        .filter((row) => row !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async function preview(reference: PlanReference) {
    const plan = await readPlan(reference);

    if (plan === null) return { kind: "not-plan" as const };
    const record = await existingRecord(plan);
    const run = record === null ? null : runResult(await recover(record));
    let execution: PlanExecution = plan.execution;

    if (run?.kind === "pending") execution = { kind: "blocked", message: run.message };
    else if (run?.kind === "started") {
      const live = ownerExecution(await api.sdk.threads.get({ threadId: run.threadId }));

      if (live !== null) execution = live;
      else if (execution.kind !== "complete" && execution.kind !== "no-work")
        execution = {
          kind: "stopped",
          message: "The existing run is idle or stopped. Its outcome remains unfinished.",
        };
    }

    return {
      kind: "plan" as const,
      title: plan.title,
      path: plan.path,
      sha256: plan.sha256,
      state: plan.state,
      execution,
      environmentId: plan.environmentId,
      ...(record !== null
        ? { selection: record.selection, selectionIssue: null }
        : execution.kind === "actionable"
          ? await selectionFor(plan.thread, plan.environmentId)
          : { selection: null, selectionIssue: null }),
      run,
    };
  }

  async function execute(input: ExecutePlan) {
    const plan = await readPlan(input, input.environmentId);

    if (plan === null) throw new Error("This file is not an execution plan.");

    const existing = await existingRecord(plan);

    if (existing !== null) return runResult(await recover(existing));

    if (plan.execution.kind === "complete")
      throw new Error("This plan is already complete. No new execution was started.");

    if (plan.execution.kind !== "actionable") throw new Error(plan.execution.message);

    if (plan.sha256 !== input.sha256)
      throw new Error(
        "The plan changed. Refresh the card and review the current file before executing.",
      );

    const [catalog, current] = await Promise.all([
      api.sdk.providers.models({
        providerId: input.selection.providerId,
        environmentId: plan.environmentId,
      }),
      api.sdk.threads.defaultExecutionOptions({ threadId: plan.thread.id }),
    ]);

    const selection = validateSelection(catalog, input.selection);

    if (current === null) throw new Error("The source conversation has no execution permissions.");

    const reservation = await locked(plan.key, async () => {
      const previous = await existingRecord(plan);

      if (previous !== null) return { created: false, record: previous };

      const record: RunRecord = {
        key: plan.key,
        sourceThreadId: input.sourceThreadId,
        projectId: plan.thread.projectId,
        environmentId: plan.environmentId,
        hostId: plan.hostId,
        path: plan.path,
        sha256: plan.sha256,
        objective: planObjective(plan.path),
        selection,
        requestId: input.requestId,
        createdAt: new Date().toISOString(),
        goalInitialized: false,
        threadId: null,
        phase: "starting",
      };

      await writeRecord(record);

      return { created: true, record };
    });

    if (!reservation.created) return runResult(await recover(reservation.record));

    try {
      const child = await api.sdk.threads.spawn({
        projectId: plan.thread.projectId,
        parentThreadId: plan.thread.id,
        environment: { type: "reuse", environmentId: plan.environmentId },
        ...selection,
        permissionMode: current.permissionMode,
        title: `Execute: ${plan.title}`.slice(0, 200),
        prompt: executionPrompt(reservation.record),
        pluginMetadata: { planExecutionKey: plan.key },
      });

      if (!ownedBy(reservation.record, child))
        throw new Error("The execution thread does not match its saved plan.");

      const started = await locked(plan.key, async () => {
        const record = await readRecord(plan.key);

        if (record === null || record.threadId !== null) return record;
        const next: RunRecord = { ...record, threadId: child.id, phase: "started" };
        await writeRecord(next);

        return next;
      });

      void initialize(child).catch((cause: unknown) =>
        api.log.error(`plan run goal not initialized on ${child.id}: ${String(cause)}`),
      );

      return runResult(started ?? reservation.record);
    } catch {
      await locked(plan.key, async () => {
        const record = await readRecord(plan.key);

        if (record !== null && record.threadId === null)
          await writeRecord({ ...record, phase: "uncertain" });
      });
      const record = (await readRecord(plan.key)) ?? reservation.record;

      return runResult(await recover(record));
    }
  }

  return { defaults, saveDefaults, preview, execute, initialize, runs };
}
