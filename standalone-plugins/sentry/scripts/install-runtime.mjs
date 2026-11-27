import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2).filter((value) => value !== "--");

const preserveState = args.includes("--preserve-state");

const recoveryIndex = args.indexOf("--recover-provisioning");

const recoveryThread = recoveryIndex >= 0 ? args[recoveryIndex + 1] : null;

const stalledIndex = args.indexOf("--recover-stalled-run");

const stalledRunId = stalledIndex >= 0 ? args[stalledIndex + 1] : null;

const strandedIndex = args.indexOf("--recover-stranded-run");

const strandedRunId = strandedIndex >= 0 ? args[strandedIndex + 1] : null;

if (
  stalledIndex >= 0 &&
  (!preserveState || !/^run_[a-z0-9_]+$/u.test(stalledRunId ?? "") || recoveryThread)
)
  throw new Error("Stalled queue recovery requires --preserve-state and one exact run ID");

if (
  strandedIndex >= 0 &&
  (!preserveState ||
    !/^run_[a-z0-9_]+$/u.test(strandedRunId ?? "") ||
    recoveryThread ||
    stalledIndex >= 0)
)
  throw new Error("Stranded run recovery requires --preserve-state and one exact run ID");

if (recoveryIndex >= 0 && (!preserveState || !recoveryThread?.startsWith("thr_")))
  throw new Error("Provisioning recovery requires --preserve-state and an exact thread ID");

if (!args.includes("--disabled") && !preserveState)
  throw new Error(
    "Use --disabled for initial installation or --preserve-state for an approved update",
  );

const index = args.indexOf("--machine");

const hostId = index >= 0 ? args[index + 1] : null;

if (!hostId || hostId.startsWith("--"))
  throw new Error("Select the Mac coordinator with --machine MACHINE_ID");

const checkoutDirectories = [root];

function api(argv, input) {
  return execFileSync("omnyo", argv, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
}

const status = JSON.parse(api(["status", "--json"]));

const snapshotIndex = args.indexOf("--snapshot-file");

const pointerPath =
  snapshotIndex >= 0
    ? resolve(root, args[snapshotIndex + 1])
    : join(root, "dist/runtime-current.json");

const pointer = JSON.parse(await readFile(pointerPath, "utf8"));

if (!status.dataDir) throw new Error("The connected server did not report its data directory");

const hosts = JSON.parse(api(["machine", "list", "--json"]));

if (!hosts.some((host) => host.id === hostId && host.status === "connected"))
  throw new Error("The exact coordinator is not connected");

const base = join(status.dataDir, "plugins", "local-builds", "sentry");

const destination = join(base, pointer.build);

const installedRaw = JSON.parse(api(["plugin", "list", "--json"]));

const installed = (Array.isArray(installedRaw) ? installedRaw : installedRaw.plugins).find(
  (value) => value.id === "sentry",
);

const cohort = join(status.dataDir, "plugins", "cache", "identity-v1", "sentry");

const ownedInstall = (plugin) =>
  (plugin.source === "path:" + plugin.rootDir &&
    /^[a-f0-9]{20}$/u.test(relative(base, plugin.rootDir))) ||
  checkoutDirectories.some(
    (directory) =>
      plugin.source === "path:" + directory &&
      (plugin.rootDir === directory || /^[a-f0-9]{64}$/u.test(relative(cohort, plugin.rootDir))),
  );

if (installed && !ownedInstall(installed))
  throw new Error("Another owner already installed plugin id sentry");

function validateStalledRecovery(existing) {
  if (existing.runs.length >= 100)
    throw new Error("Stalled queue recovery requires a complete retained-run inventory");

  const retained = existing.runs.find((run) => run.id === stalledRunId);

  const native = retained?.threadId
    ? JSON.parse(api(["thread", "show", retained.threadId, "--json"])).thread
    : null;

  const noExecution = existing.runs.every(
    (run) =>
      ["local-ready", "pr-open", "no-fix", "needs-evidence", "cancelled", "failed"].includes(
        run.state,
      ) ||
      (run.state === "queued" && run.threadId === null && run.spawnRequestedAt === null),
  );

  const safeBatches = (existing.batches ?? []).every((batch) =>
    ["waiting", "complete", "failed", "cancelled"].includes(batch.state),
  );

  const verified =
    retained?.state === "local-ready" &&
    retained.result?.outcome === "fix-ready" &&
    /^[a-f0-9]{40}$/u.test(retained.result?.commit ?? "") &&
    retained.verification?.head === retained.result.commit &&
    Array.isArray(retained.verification?.checks) &&
    retained.verification.checks.length > 0 &&
    retained.verification.checks.every((check) => check.exitCode === 0);

  if (
    !verified ||
    !noExecution ||
    !safeBatches ||
    native?.id !== retained.threadId ||
    native.originPluginId !== "sentry" ||
    native.status !== "idle" ||
    native.queuedMessageCount !== 0 ||
    native.activeBackgroundAgentCount !== 0
  )
    throw new Error(
      "Stalled queue recovery needs a verified idle result and no active or uncertain execution",
    );

  return true;
}

function threadDeleted(threadId) {
  try {
    api(["thread", "show", threadId, "--json"]);

    return false;
  } catch (error) {
    let output = null;

    try {
      output = JSON.parse(error.stdout ?? "");
    } catch {
      return false;
    }

    return output?.ok === false && output.error?.code === "thread_not_found";
  }
}

function validateStrandedRecovery(existing) {
  if (existing.runs.length >= 100)
    throw new Error("Stranded run recovery requires a complete retained-run inventory");

  const stranded = existing.runs.find((run) => run.id === strandedRunId);

  const task = JSON.parse(
    api(["plugin", "run", "sentry", "workflow", "status", "--json"]),
  ).tasks?.find((value) => value.runId === strandedRunId);

  const noOtherExecution = existing.runs.every(
    (run) =>
      run.id === strandedRunId ||
      ["local-ready", "pr-open", "no-fix", "needs-evidence", "cancelled", "failed"].includes(
        run.state,
      ) ||
      (run.state === "queued" && run.threadId === null && run.spawnRequestedAt === null),
  );

  const safeBatches = (existing.batches ?? []).every((batch) =>
    ["waiting", "complete", "failed", "cancelled"].includes(batch.state),
  );

  if (
    !["preparing", "investigating", "verifying", "publishing"].includes(stranded?.state) ||
    task?.status !== "blocked" ||
    !task.steps?.every((step) => ["complete", "cancelled"].includes(step.state)) ||
    !noOtherExecution ||
    !safeBatches ||
    !stranded.threadId ||
    !threadDeleted(stranded.threadId)
  )
    throw new Error(
      "Stranded run recovery needs a blocked workflow run whose chat was deleted and no other active or uncertain execution",
    );

  return true;
}

let previousStatus = null;

if (installed) {
  const existing = JSON.parse(api(["plugin", "run", "sentry", "status", "--json"]));

  let recoverableBatchId = null;
  let recoverableQueue = false;

  if (stalledRunId) recoverableQueue = validateStalledRecovery(existing);

  if (strandedRunId) recoverableQueue = validateStrandedRecovery(existing);

  if (recoveryThread) {
    const batch = existing.batches?.find((value) => value.threadId === recoveryThread);
    const native = JSON.parse(api(["thread", "show", recoveryThread, "--json"]));

    if (
      !batch ||
      batch.state !== "planning" ||
      batch.runIds.length ||
      native.thread.originPluginId !== "sentry" ||
      native.thread.projectId !== batch.projectId ||
      native.thread.status !== "error" ||
      native.thread.environmentId !== null ||
      native.thread.queuedMessageCount ||
      native.thread.activeBackgroundAgentCount
    )
      throw new Error(
        "Recovery target must be a Sentry coordinator that failed before workspace binding, without workers or queued work",
      );
    recoverableBatchId = batch.id;
  }

  if (
    (!preserveState && existing.routes.some((route) => route.enabled)) ||
    (!recoverableQueue &&
      existing.batches?.some(
        (batch) =>
          batch.id !== recoverableBatchId &&
          !["complete", "failed", "cancelled"].includes(batch.state),
      )) ||
    (!recoverableQueue &&
      existing.runs.some((run) =>
        ["queued", "preparing", "investigating", "verifying", "publishing"].includes(run.state),
      ))
  )
    throw new Error(
      "Settle existing Sentry work before replacing runtime artifacts; enabled watching may be preserved only with --preserve-state",
    );
  previousStatus = existing;
}

const files = [];

async function visit(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(relative, entry.name);

    if (entry.isDirectory()) await visit(join(directory, entry.name), name);
    else if (entry.isFile()) files.push(name);
    else throw new Error("Runtime snapshots must not contain links");
  }
}

await visit(pointer.directory);

const receipts = [];

for (const name of files) {
  const bytes = await readFile(join(pointer.directory, name));
  const hash = createHash("sha256").update(bytes).digest("hex");

  const receipt = JSON.parse(
    api(
      [
        "file",
        "write",
        join(destination, name),
        "--host",
        hostId,
        "--root",
        join(status.dataDir, "plugins"),
        "--create-parents",
        "--stdin",
        "--json",
      ],
      bytes.toString("utf8"),
    ),
  );

  if (receipt.outcome !== "written" || receipt.sha256 !== hash)
    throw new Error("Runtime transfer digest mismatch");
  receipts.push({ name, sha256: hash });
}

if (stalledRunId)
  validateStalledRecovery(JSON.parse(api(["plugin", "run", "sentry", "status", "--json"])));

if (strandedRunId)
  validateStrandedRecovery(JSON.parse(api(["plugin", "run", "sentry", "status", "--json"])));

const result = JSON.parse(api(["plugin", "install", "path:" + destination, "--yes", "--json"]));

if (result.ok !== true || result.plugin?.source !== "path:" + destination)
  throw new Error("The Sentry installation did not report the transferred package");

const currentRaw = JSON.parse(api(["plugin", "list", "--json"]));

const current = (Array.isArray(currentRaw) ? currentRaw : currentRaw.plugins).find(
  (value) => value.id === "sentry",
);

if (
  current?.source !== "path:" + destination ||
  current.rootDir !== destination ||
  current.status !== "running"
)
  throw new Error("Sentry did not start from the exact transferred package");

const configured = JSON.parse(api(["plugin", "run", "sentry", "status", "--json"]));

const normalizeRoutes = (routes) =>
  routes.map((route) => ({
    ...route,
    watch: route.watch ?? true,
    levels: route.levels ?? ["error", "fatal"],
  }));

const configuredPolicies = (policies) =>
  policies.map(({ projectId, autoSolve, dailyLimit }) => ({ projectId, autoSolve, dailyLimit }));

if (
  preserveState &&
  previousStatus &&
  (!isDeepStrictEqual(normalizeRoutes(configured.routes), normalizeRoutes(previousStatus.routes)) ||
    !isDeepStrictEqual(
      configuredPolicies(configured.projectPolicies),
      configuredPolicies(previousStatus.projectPolicies),
    ))
)
  throw new Error("Existing watched routes or auto-solve policies changed during installation");

if (!preserveState && configured.routes.some((route) => route.enabled))
  throw new Error("Disabled installation invariant failed");

const receipt = {
  destination,
  build: pointer.build,
  hostId,
  files: receipts,
  result,
  allRoutesDisabled: configured.routes.every((route) => !route.enabled),
  preservedState: preserveState,
  recoveredStalledRun: stalledRunId,
};

await writeFile(
  join(root, "docs/evidence/runtime-install.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(
  JSON.stringify({
    destination,
    build: pointer.build,
    allRoutesDisabled: receipt.allRoutesDisabled,
    preservedState: preserveState,
  }),
);
