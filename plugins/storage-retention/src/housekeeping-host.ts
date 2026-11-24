import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  experimental_inspectProcessPrivateTemps as inspectProcessPrivateTemps,
  experimental_recoverProcessPrivateTemps as recoverProcessPrivateTemps,
} from "@omnyo/plugin-sdk/host";
import { z } from "zod";
import {
  housekeepingBindingsSchema,
  housekeepingHostPreviewSchema,
  housekeepingRegistrationSchema,
  housekeepingRunSchema,
  housekeepingReviewProposalSchema,
  type HousekeepingBindings,
  type HousekeepingRegistration,
  type HousekeepingRun,
  type HousekeepingSource,
  type HousekeepingStage,
} from "./housekeeping-contract.js";

export const housekeepingHelpers = [
  "housekeeping.py",
  "cleanup.py",
  "reclaim_guard.py",
  "retention.py",
  "release_sweep.py",
  "periodic_prune.py",
  "devtool_sweep.py",
  "simulator_sweep.py",
  "worktree_sweep.py",
  "trace_retention.py",
  "verified_extracts.py",
  "compress_closed_logs.py",
  "apple_storage.py",
  "review_inventory.py",
  "storage_watch.py",
  "resource_watchdog.py",
  "runtime_inventory.py",
];

const localStages = [
  "release-retention",
  "reviewed-retention",
  "periodic",
  "verified-extracts",
  "cold-cache",
  "simulators",
  "devtools",
  "worktrees",
  "trace-retention",
  "docker",
  "docker-kasten",
  "apple-storage",
  "closed-logs",
  "review-inventory",
  "storage-watch",
  "resource-watchdog",
  "runtime-discovery",
];

const engineResultSchema = z.object({
  schema: z.literal(1),
  runId: z.uuid(),
  state: z.enum(["running", "completed", "held", "failed"]),
  reason: z.string().nullable().optional(),
  bindingsDigest: z.string(),
  stages: z.array(
    z.object({
      name: z.enum(localStages),
      state: z.enum(["running", "complete", "held", "failed", "deferred"]),
      reason: z.string().nullable(),
      items: z.number().int().nonnegative().nullable(),
      bytes: z.number().int().nonnegative().nullable(),
      reportSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      uncertain: z.boolean().optional().default(false),
    }),
  ),
  reserved: z
    .object({
      items: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  reviewProposals: z
    .array(housekeepingReviewProposalSchema)
    .max(100)
    .optional(),
});

const stoppedKastenReceiptSchema = z.object({
  mode: z.literal("apply"),
  docker: z.object({ status: z.literal("local-daemon-stopped") }),
});

async function isStoppedKastenReceipt(file: string, sha256: string) {
  const handle = await fs
    .open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    .catch((error: unknown) => {
      if (missing(error)) return null;

      throw error;
    });

  if (handle === null) return false;

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.size > 1024 * 1024) return false;

    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);

    return (
      bytesRead === info.size &&
      createHash("sha256").update(contents).digest("hex") === sha256 &&
      stoppedKastenReceiptSchema.safeParse(
        JSON.parse(contents.toString("utf8")),
      ).success
    );
  } finally {
    await handle.close();
  }
}

const persistedSchema = z
  .object({
    registration: housekeepingRegistrationSchema.nullable(),
    currentRun: housekeepingRunSchema.nullable(),
    lastRun: housekeepingRunSchema.nullable(),
    preview: housekeepingHostPreviewSchema.nullable(),
  })
  .strict();

class AdapterAdmissionError extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;

  return JSON.stringify(value);
}

export function housekeepingDigest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stage(
  name: string,
  state: HousekeepingStage["state"],
  reason: string | null = null,
  items: number | null = 0,
  bytes: number | null = 0,
): HousekeepingStage {
  return { name, state, reason, items, bytes };
}

const processTempUncertain =
  "Its outcome is uncertain and was not replayed; any interrupted removal stays held in its allocation journal.";

function holdInterruptedProcessTemp(stages: HousekeepingStage[]) {
  return stages.map((item) =>
    item.name === "process-private-temp" && item.state === "running"
      ? stage(
          item.name,
          "held",
          `The process temporary stage stopped before its receipt. ${processTempUncertain}`,
          null,
          null,
        )
      : item,
  );
}

async function physicalFile(file: string, requireOwner = true) {
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    (await fs.realpath(file)) !== file
  )
    throw new Error("Use the exact physical file path without symbolic links.");
  const stat = await fs.lstat(file, { bigint: true });

  if (!stat.isFile() || stat.size > 128n * 1024n ** 2n)
    throw new Error("An adapter input must be a regular physical file.");

  if (
    requireOwner &&
    typeof process.getuid === "function" &&
    stat.uid !== BigInt(process.getuid())
  )
    throw new Error(
      "The local policy and helper files must belong to this host account.",
    );

  const sha256 = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

  const after = await fs.lstat(file, { bigint: true });

  if (
    stat.dev !== after.dev ||
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeNs !== after.mtimeNs ||
    stat.ctimeNs !== after.ctimeNs
  )
    throw new Error("An adapter input changed while its binding was read.");

  return { path: file, sha256 };
}

async function bindings(
  source: HousekeepingSource,
): Promise<HousekeepingBindings> {
  if (process.platform !== "darwin")
    throw new Error("The safe Mac cleanup adapter requires macOS.");

  if (
    !path.isAbsolute(source.sourceDirectory) ||
    path.resolve(source.sourceDirectory) !== source.sourceDirectory ||
    (await fs.realpath(source.sourceDirectory)) !== source.sourceDirectory ||
    !(await fs.lstat(source.sourceDirectory)).isDirectory()
  )
    throw new Error("Use a physical source directory without symbolic links.");

  const sourceStat = await fs.lstat(source.sourceDirectory);

  if (
    typeof process.getuid === "function" &&
    sourceStat.uid !== process.getuid()
  )
    throw new Error(
      "The local policy source directory must belong to this host account.",
    );

  const [runtime, policy, files, configuration, kastenPolicy] =
    await Promise.all([
      physicalFile(source.pythonPath, false),
      physicalFile(source.policyPath),
      Promise.all(
        housekeepingHelpers.map(
          async (name) =>
            [
              name,
              (await physicalFile(path.join(source.sourceDirectory, name)))
                .sha256,
            ] as const,
        ),
      ),
      Promise.all(
        ["review-policy.toml", "storage-watch.toml"].map(
          async (name) =>
            [
              name,
              (
                await physicalFile(
                  path.join(path.dirname(source.sourceDirectory), name),
                )
              ).sha256,
            ] as const,
        ),
      ),
      source.namedPolicies?.["docker-kasten"] === undefined
        ? null
        : physicalFile(source.namedPolicies["docker-kasten"]),
    ]);

  return housekeepingBindingsSchema.parse({
    runtime,
    policy,
    sourceDirectory: source.sourceDirectory,
    helpers: Object.fromEntries(files),
    configuration: Object.fromEntries(configuration),
    namedPolicies:
      kastenPolicy === null ? {} : { "docker-kasten": kastenPolicy },
  });
}

function sourceOf(registration: HousekeepingRegistration): HousekeepingSource {
  return {
    sourceDirectory: registration.bindings.sourceDirectory,
    pythonPath: registration.bindings.runtime.path,
    policyPath: registration.bindings.policy.path,
    namedPolicies:
      registration.bindings.namedPolicies["docker-kasten"] === undefined
        ? {}
        : {
            "docker-kasten":
              registration.bindings.namedPolicies["docker-kasten"].path,
          },
  };
}

async function execute(runtime: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(runtime, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    let output = "";
    let oversized = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      if (output.length + value.length <= 1024 * 1024) output += value;
      else oversized = true;
    });
    child.once("error", () =>
      reject(new Error("The registered cleanup runtime could not start.")),
    );
    child.once("close", (code) => {
      if (code !== 0)
        reject(
          new Error(
            `The registered cleanup helper exited with status ${code ?? "unknown"}.`,
          ),
        );
      else if (oversized)
        reject(
          new Error(
            "The registered cleanup helper exceeded the receipt limit.",
          ),
        );
      else resolve(output);
    });
  });
}

export function createHousekeepingHost(options: {
  dataDir: string;
  retainWorker: () => { dispose(): void };
  now?: () => number;
  changed?: (runId: string) => void;
  inspectTemps?: typeof inspectProcessPrivateTemps;
  recoverTemps?: typeof recoverProcessPrivateTemps;
}) {
  const now = options.now ?? Date.now;
  const directory = path.join(options.dataDir, "housekeeping-v1");
  const file = path.join(directory, "state.json");
  let queue: Promise<unknown> = Promise.resolve();
  const running = new Set<string>();

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);

    return result;
  }

  async function read() {
    try {
      return persistedSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if (!missing(error)) throw error;

      return {
        registration: null,
        currentRun: null,
        lastRun: null,
        preview: null,
      };
    }
  }

  async function write(state: z.infer<typeof persistedSchema>) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
    await atomicWrite(temporary, file, state);
  }

  async function atomicWrite(
    temporary: string,
    destination: string,
    value: unknown,
  ) {
    const handle = await fs.open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, destination);

    if (process.platform !== "win32") {
      const parent = await fs.open(directory, "r");

      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }

  async function readRun(id: string) {
    try {
      return housekeepingRunSchema.parse(
        JSON.parse(
          await fs.readFile(path.join(directory, `run-${id}.json`), "utf8"),
        ),
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function writeRun(run: HousekeepingRun) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `run-${run.id}-${randomUUID()}.tmp`);
    await atomicWrite(
      temporary,
      path.join(directory, `run-${run.id}.json`),
      run,
    );
  }

  async function validate(registration: HousekeepingRegistration) {
    const current = await bindings(sourceOf(registration));

    if (housekeepingDigest(current) !== registration.bindingsDigest)
      throw new Error(
        "The registered source, runtime or policy changed. Preview and adopt the new exact inputs before cleanup.",
      );
  }

  function engineArgs(
    registration: HousekeepingRegistration,
    operation: "run" | "status",
    run: HousekeepingRun,
  ) {
    return [
      path.join(registration.bindings.sourceDirectory, "housekeeping.py"),
      operation,
      "--policy",
      registration.bindings.policy.path,
      "--state-directory",
      directory,
      "--run-id",
      run.id,
      "--mode",
      run.mode,
      "--max-items",
      String(run.budget.maxItems),
      "--max-bytes",
      String(run.budget.maxBytes),
      "--budget-seconds",
      String(run.budget.budgetSeconds),
      "--report",
      path.join(directory, `${run.id}.json`),
      "--expected-bindings",
      registration.bindingsDigest,
      ...(registration.bindings.namedPolicies["docker-kasten"] === undefined
        ? []
        : [
            "--docker-kasten-policy",
            registration.bindings.namedPolicies["docker-kasten"].path,
          ]),
    ];
  }

  async function engine(
    registration: HousekeepingRegistration,
    operation: "run" | "status",
    run: HousekeepingRun,
  ) {
    try {
      await validate(registration);
    } catch {
      if (operation === "status") {
        const receipt = path.join(directory, `${run.id}.json`);

        const handle = await fs.open(
          receipt,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );

        let contents: Buffer;
        let before;

        try {
          before = await handle.stat({ bigint: true });

          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size > 1024n * 1024n ||
            (typeof process.getuid === "function" &&
              before.uid !== BigInt(process.getuid())) ||
            (await fs.realpath(receipt)) !== receipt
          )
            throw new AdapterAdmissionError(
              "The original cleanup receipt is not a bounded physical file owned by this account.",
            );
          const buffer = Buffer.alloc(Number(before.size) + 1);

          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.byteLength,
            0,
          );

          if (bytesRead !== Number(before.size))
            throw new AdapterAdmissionError(
              "The original cleanup receipt size changed while being inspected.",
            );
          contents = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }

        const after = await fs.lstat(receipt, { bigint: true });

        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new AdapterAdmissionError(
            "The original cleanup receipt changed while being inspected.",
          );

        const result = engineResultSchema.parse(
          JSON.parse(contents.toString("utf8")),
        );

        if (
          result.runId !== run.id ||
          result.bindingsDigest !== registration.bindingsDigest ||
          result.state === "running" ||
          result.stages.some((item) => item.state === "running")
        )
          throw new AdapterAdmissionError(
            "The original cleanup receipt does not prove this registered run reached a terminal state.",
          );

        return {
          ...result,
          reason: `Recovered the original source-bound terminal receipt. ${result.reason ?? "Its recorded stage outcomes are preserved."}`,
        };
      }

      throw new AdapterAdmissionError(
        "The registered adapter inputs changed before launch.",
      );
    }

    const result = engineResultSchema.parse(
      JSON.parse(
        await execute(
          registration.bindings.runtime.path,
          engineArgs(registration, operation, run),
        ),
      ),
    );

    if (
      result.runId !== run.id ||
      result.bindingsDigest !== registration.bindingsDigest
    )
      throw new Error("The cleanup receipt does not match the registered run.");

    return result;
  }

  async function reportedStages(
    result: z.infer<typeof engineResultSchema>,
    run: HousekeepingRun,
  ): Promise<HousekeepingStage[]> {
    return Promise.all(
      result.stages.map(async ({ uncertain, reportSha256, ...stage }) => {
        if (
          stage.name === "docker-kasten" &&
          stage.state === "complete" &&
          run.mode === "apply" &&
          !uncertain &&
          reportSha256 !== undefined &&
          (await isStoppedKastenReceipt(
            path.join(directory, `${run.id}-docker-kasten.json`),
            reportSha256,
          ))
        )
          return {
            ...stage,
            state: "skipped",
            reason: "local-daemon-stopped",
            items: 0,
            bytes: 0,
          };

        return stage;
      }),
    );
  }

  async function update(run: HousekeepingRun) {
    return serial(async () => {
      const state = await read();

      if (state.currentRun?.id !== run.id)
        throw new Error("The current cleanup run changed.");
      state.currentRun = run;

      if (
        ["completed", "failed", "held"].includes(run.state) &&
        run.reserved.items === 0 &&
        run.reserved.bytes === 0 &&
        !run.stages.some((item) => item.state === "running")
      ) {
        state.lastRun = run;
        state.currentRun = null;
      }

      await writeRun(run);
      await write(state);
      options.changed?.(run.id);

      return run;
    });
  }

  async function processTempStage(
    run: HousekeepingRun,
  ): Promise<HousekeepingStage> {
    let results;

    try {
      results =
        run.mode === "preview"
          ? await (options.inspectTemps ?? inspectProcessPrivateTemps)({
              budgetSeconds: Math.min(60, run.budget.budgetSeconds),
            })
          : await (options.recoverTemps ?? recoverProcessPrivateTemps)({
              limit: run.budget.maxItems,
              maxBytes: run.budget.maxBytes,
              budgetSeconds: Math.min(60, run.budget.budgetSeconds),
            });
    } catch (error) {
      return stage(
        "process-private-temp",
        "held",
        `Process temporary recovery stopped before its receipt: ${(error instanceof Error ? error.message : "unknown failure").slice(0, 300)}. ${processTempUncertain}`,
        null,
        null,
      );
    }

    const held = results.filter((item) => item.status === "held");

    const selected = results
      .filter(
        (item) =>
          item.status === (run.mode === "apply" ? "removed" : "recoverable"),
      )
      .slice(0, run.budget.maxItems);

    return stage(
      "process-private-temp",
      held.length > 0 ? "held" : "complete",
      held.length > 0
        ? `${held.length} allocations remain held because ownership or process state is uncertain.`
        : selected.some((item) => item.sizeBytes === null)
          ? "Byte totals include measured allocations only. Unmeasured allocations remain outside apply admission."
          : null,
      selected.length,
      selected.some((item) => item.sizeBytes === null)
        ? null
        : selected.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
    );
  }

  async function perform(
    initial: HousekeepingRun,
    registration: HousekeepingRegistration | null,
  ) {
    let run: HousekeepingRun = {
      ...initial,
      state: "running",
      stages: [stage("process-private-temp", "running")],
    };

    try {
      await update(run);
      run = { ...run, stages: [await processTempStage(run)] };
      await update(run);

      if (registration !== null) {
        const usedItems = run.stages.reduce(
          (total, item) => total + (item.items ?? 0),
          0,
        );

        const usedBytes = run.stages.reduce(
          (total, item) => total + (item.bytes ?? 0),
          0,
        );

        const remaining = {
          maxItems: Math.max(0, run.budget.maxItems - usedItems),
          maxBytes: Math.max(0, run.budget.maxBytes - usedBytes),
          budgetSeconds: Math.max(
            0,
            Math.floor(
              run.budget.budgetSeconds - (now() - run.startedAt) / 1000,
            ),
          ),
        };

        if (
          remaining.maxItems === 0 ||
          remaining.maxBytes === 0 ||
          remaining.budgetSeconds === 0
        ) {
          run = {
            ...run,
            state: "completed",
            stages: [
              ...run.stages,
              stage(
                "local-policy",
                "deferred",
                "The run budget is exhausted before local policy admission.",
              ),
            ],
          };
          await update({ ...run, finishedAt: now() });

          return;
        }

        run = {
          ...run,
          reserved: { items: remaining.maxItems, bytes: remaining.maxBytes },
          stages: [...run.stages, stage("local-policy", "running")],
        };
        await update(run);

        const result = await engine(registration, "run", {
          ...run,
          budget: remaining,
        });

        run = {
          ...run,
          state: result.state,
          stages: [
            ...run.stages.filter(
              (item) =>
                item.name !== "local-policy" &&
                !localStages.includes(item.name),
            ),
            ...(await reportedStages(result, run)),
          ],
          reserved: result.reserved,
          reviewProposals: result.reviewProposals,
          reason: result.reason ?? null,
        };
      } else
        run = {
          ...run,
          stages: [
            ...run.stages,
            stage(
              "local-policy",
              "deferred",
              "No local policy adapter is registered.",
            ),
          ],
          state: "completed",
        };

      if (run.state === "running")
        run = {
          ...run,
          state: "held",
          reason:
            "The helper returned before a terminal receipt. Reconcile this run before starting another.",
        };

      if (
        run.state === "completed" &&
        run.stages.some((item) => item.state === "held")
      )
        run = {
          ...run,
          state: "held",
          reason: "One or more cleanup stages remain held.",
        };
      await update({
        ...run,
        finishedAt: run.state === "running" ? null : now(),
      });
    } catch (error) {
      if (error instanceof AdapterAdmissionError) {
        await update({
          ...run,
          state: "held",
          finishedAt: now(),
          reserved: { items: 0, bytes: 0 },
          reason: error.message,
          stages: run.stages.map((item) =>
            item.state === "running"
              ? { ...item, state: "held", reason: error.message }
              : item,
          ),
        });

        return;
      }

      await update({
        ...run,
        state: "held",
        reason:
          "The cleanup outcome is uncertain. Reconcile the existing run; no cleanup was replayed.",
        finishedAt: now(),
        stages: holdInterruptedProcessTemp(run.stages),
      });
    }
  }

  async function reconcile() {
    const state = await read();

    if (state.currentRun === null || running.has(state.currentRun.id))
      return state;

    const run = {
      ...state.currentRun,
      stages: holdInterruptedProcessTemp(state.currentRun.stages),
    };

    state.currentRun = run;

    if (
      (run.stages.some(
        (item) => item.name === "local-policy" && item.state === "running",
      ) ||
        run.reserved.items > 0 ||
        run.reserved.bytes > 0) &&
      state.registration !== null
    ) {
      try {
        const result = await engine(state.registration, "status", run);
        state.currentRun = {
          ...run,
          state: result.state,
          reason: result.reason ?? null,
          reserved: result.reserved,
          reviewProposals: result.reviewProposals,
          stages: [
            ...run.stages.filter(
              (item) =>
                item.name !== "local-policy" &&
                !localStages.includes(item.name),
            ),
            ...(await reportedStages(result, run)),
          ],
          finishedAt: result.state === "running" ? null : now(),
        };
      } catch {
        state.currentRun = {
          ...run,
          state: "held",
          reason:
            "The registered run could not be reconciled. Its reservations remain held.",
        };
      }
    } else if (run.state === "planned" || run.state === "running")
      state.currentRun = {
        ...run,
        state: "held",
        reason:
          "The previous worker stopped before a terminal receipt. This run was not replayed.",
      };

    if (
      state.currentRun !== null &&
      ["completed", "failed", "held"].includes(state.currentRun.state) &&
      state.currentRun.reserved.items === 0 &&
      state.currentRun.reserved.bytes === 0 &&
      !state.currentRun.stages.some((item) => item.state === "running")
    ) {
      state.lastRun = state.currentRun;
      state.currentRun = null;
    }

    const latest = state.currentRun ?? state.lastRun;

    if (latest?.id === run.id) await writeRun(latest);
    await write(state);

    return state;
  }

  return {
    state: () =>
      serial(async () => {
        const state = await reconcile();

        return {
          registration: state.registration,
          currentRun: state.currentRun,
          lastRun: state.lastRun,
        };
      }),
    adapterPreview: (source: HousekeepingSource) =>
      serial(async () => {
        const state = await reconcile();

        if (state.currentRun !== null)
          throw new Error(
            "Reconcile the existing cleanup run before changing its registration.",
          );
        const current = await bindings(source);
        const revision = state.registration?.revision ?? 0;

        const preview = {
          kind: "safe-mac-cleanup-v1" as const,
          revision,
          bindings: current,
          bindingsDigest: housekeepingDigest(current),
          stages: localStages,
          previewDigest: housekeepingDigest({ revision, bindings: current }),
        };

        state.preview = preview;
        await write(state);

        return preview;
      }),
    adapterAdopt: (input: { revision: number; previewDigest: string }) =>
      serial(async () => {
        const state = await reconcile();

        if (
          state.currentRun !== null ||
          state.preview === null ||
          state.preview.revision !== input.revision ||
          state.preview.previewDigest !== input.previewDigest ||
          (state.registration?.revision ?? 0) !== input.revision
        )
          throw new Error(
            "The exact adapter preview or registration revision changed.",
          );
        const preview = state.preview;

        const current = await bindings({
          sourceDirectory: preview.bindings.sourceDirectory,
          pythonPath: preview.bindings.runtime.path,
          policyPath: preview.bindings.policy.path,
          namedPolicies:
            preview.bindings.namedPolicies["docker-kasten"] === undefined
              ? {}
              : {
                  "docker-kasten":
                    preview.bindings.namedPolicies["docker-kasten"].path,
                },
        });

        if (housekeepingDigest(current) !== preview.bindingsDigest)
          throw new Error(
            "The preview inputs changed. Create a fresh adapter preview.",
          );

        const registration: HousekeepingRegistration = {
          kind: preview.kind,
          revision: input.revision + 1,
          adoptedAt: now(),
          bindingsDigest: preview.bindingsDigest,
          bindings: preview.bindings,
        };

        state.registration = registration;
        state.preview = null;
        await write(state);

        return registration;
      }),
    adapterRemove: (input: { revision: number; previewDigest: string }) =>
      serial(async () => {
        const state = await reconcile();

        if (
          state.currentRun !== null ||
          state.registration === null ||
          state.preview === null ||
          state.registration.revision !== input.revision ||
          state.preview.revision !== input.revision ||
          state.preview.previewDigest !== input.previewDigest ||
          state.preview.bindings.sourceDirectory !==
            state.registration.bindings.sourceDirectory ||
          state.preview.bindings.runtime.path !==
            state.registration.bindings.runtime.path ||
          state.preview.bindings.policy.path !==
            state.registration.bindings.policy.path
        )
          throw new Error(
            "Confirm a fresh preview of the exact registered adapter before removing it.",
          );
        state.registration = null;
        state.preview = null;
        await write(state);

        return null;
      }),
    start: (
      input: { run: HousekeepingRun },
      retainWorker = options.retainWorker,
    ) =>
      serial(async () => {
        const state = await reconcile();
        const savedRun = await readRun(input.run.id);

        if (savedRun !== null) return savedRun;

        const existing =
          state.currentRun ??
          (state.lastRun?.id === input.run.id ? state.lastRun : null);

        if (existing !== null) {
          if (existing.id === input.run.id) return existing;
          throw new Error(
            "A cleanup run is already active or unresolved on this host.",
          );
        }

        if (
          input.run.registrationRevision !==
            (state.registration?.revision ?? null) ||
          input.run.bindingsDigest !==
            (state.registration?.bindingsDigest ?? null)
        ) {
          const held = {
            ...input.run,
            state: "held" as const,
            finishedAt: now(),
            reason: "The cleanup registration changed before launch.",
            stages: [
              stage(
                "local-policy",
                "held",
                "The cleanup registration changed before launch.",
              ),
            ],
          };

          state.lastRun = held;
          await writeRun(held);
          await write(state);

          return held;
        }

        if (state.registration !== null) {
          try {
            await validate(state.registration);
          } catch {
            const held = {
              ...input.run,
              state: "held" as const,
              finishedAt: now(),
              reason:
                "The registered source, runtime or policy changed. Preview and adopt the exact current inputs before cleanup.",
              stages: [
                stage(
                  "local-policy",
                  "held",
                  "The registered adapter inputs changed before launch.",
                ),
              ],
            };

            state.lastRun = held;
            await writeRun(held);
            await write(state);

            return held;
          }
        }

        const run = housekeepingRunSchema.parse(input.run);
        state.currentRun = run;
        await writeRun(run);
        await write(state);
        const lease = retainWorker();
        running.add(run.id);
        void perform(run, state.registration)
          .catch(() => {
            options.changed?.(run.id);
          })
          .finally(() => {
            running.delete(run.id);
            lease.dispose();
          });

        return run;
      }),
    run: (input: { id: string }) =>
      serial(async () => {
        const state = await reconcile();

        const run =
          state.currentRun?.id === input.id
            ? state.currentRun
            : state.lastRun?.id === input.id
              ? state.lastRun
              : null;

        const savedRun = run ?? (await readRun(input.id));

        if (savedRun === null)
          throw new Error("The cleanup run is unknown. It was not replayed.");

        return savedRun;
      }),
  };
}
