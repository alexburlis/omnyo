import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectDirectoryProcesses } from "./directory-process-inspection.js";
import {
  assertStorageAdmission,
  type StorageAdmission,
} from "./storage-admission.mjs";

const execFileAsync = promisify(execFile);

type Origin = "host-worker" | "provider-bridge";

type PhysicalIdentity = { dev: number; ino: number; birthtimeMs: number };

type ProcessOwner = {
  pid: number;
  generation: string;
  startIdentity: string | null;
  bootIdentity: string | null;
};

type Journal = {
  version: 1;
  allocationId: string;
  pluginId: string;
  origin: Origin;
  tempDir: string;
  root: PhysicalIdentity;
  registry: PhysicalIdentity;
  marker: string;
  owner: ProcessOwner | null;
  createdAt: string;
  admission: StorageAdmission | null;
};

export type ProcessPrivateTempInspection = {
  allocationId: string;
  pluginId: string;
  origin: Origin;
  tempDir: string;
  status: "active" | "recoverable" | "held" | "removed";
  reason: string;
  sizeBytes: number | null;
};

type RegistryOptions = { registryDirectory?: string };

export function processPrivateTempRegistryDirectory(): string {
  return join(homedir(), ".omnyo", "process-private-temp");
}

function registryPath(options: RegistryOptions): string {
  const path = resolve(
    options.registryDirectory ?? processPrivateTempRegistryDirectory(),
  );

  if (!existsSync(path)) return path;

  if (lstatSync(path).isSymbolicLink())
    throw new Error("Process temporary registry is a symbolic link");

  return realpathSync(path);
}

function identity(path: string): PhysicalIdentity {
  const stat = lstatSync(path);

  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Process temporary storage directory is not physical");

  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new Error(
      "Process temporary storage directory has a different owner",
    );

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error("Process temporary storage directory is not private");

  if (realpathSync(path) !== path)
    throw new Error(
      "Process temporary storage directory changed physical path",
    );

  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function sameIdentity(
  left: PhysicalIdentity,
  right: PhysicalIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function durableWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.pending`;
  const fd = openSync(temporary, "wx", 0o600);

  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function bootIdentity(): Promise<string | null> {
  try {
    if (process.platform === "linux")
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

    if (process.platform === "darwin") {
      const output = (
        await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
          encoding: "utf8",
          timeout: 2_000,
        })
      ).stdout;

      const match = output.match(
        /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/u,
      );

      return match === null ? null : `${match[1]}:${match[2]}`;
    }
  } catch {}

  return null;
}

async function startIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");

      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }

    if (process.platform === "darwin")
      return (
        (
          await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            timeout: 2_000,
          })
        ).stdout.trim() || null
      );
  } catch {}

  return null;
}

async function processOwner(pid: number): Promise<ProcessOwner> {
  const [start, boot] = await Promise.all([startIdentity(pid), bootIdentity()]);

  return {
    pid,
    generation: randomUUID(),
    startIdentity: start,
    bootIdentity: boot,
  };
}

async function ownerState(
  owner: ProcessOwner | null,
): Promise<"active" | "stopped" | "unknown"> {
  if (
    owner === null ||
    owner.startIdentity === null ||
    owner.bootIdentity === null ||
    process.platform === "win32"
  )
    return "unknown";
  const currentBoot = await bootIdentity();

  if (currentBoot === null) return "unknown";

  if (currentBoot !== owner.bootIdentity) return "stopped";

  try {
    process.kill(owner.pid, 0);

    return (await startIdentity(owner.pid)) === owner.startIdentity
      ? "active"
      : "unknown";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
      ? "stopped"
      : "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentity(value: unknown): value is PhysicalIdentity {
  return (
    isRecord(value) &&
    typeof value.dev === "number" &&
    Number.isFinite(value.dev) &&
    typeof value.ino === "number" &&
    Number.isFinite(value.ino) &&
    typeof value.birthtimeMs === "number" &&
    Number.isFinite(value.birthtimeMs)
  );
}

function isOwner(value: unknown): value is ProcessOwner {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    (value.startIdentity === null || typeof value.startIdentity === "string") &&
    (value.bootIdentity === null || typeof value.bootIdentity === "string")
  );
}

function readAdmission(value: unknown): StorageAdmission | null {
  if (value === undefined) return null;

  if (
    !isRecord(value) ||
    typeof value.directory !== "string" ||
    !isAbsolute(value.directory) ||
    typeof value.filesystemDirectory !== "string" ||
    !isAbsolute(value.filesystemDirectory) ||
    typeof value.availableBytes !== "number" ||
    !Number.isSafeInteger(value.availableBytes) ||
    value.availableBytes < 0 ||
    typeof value.requiredBytes !== "number" ||
    !Number.isSafeInteger(value.requiredBytes) ||
    value.requiredBytes <= 0 ||
    typeof value.expectedBytes !== "number" ||
    !Number.isSafeInteger(value.expectedBytes) ||
    value.expectedBytes <= 0 ||
    typeof value.minimumFreeBytes !== "number" ||
    !Number.isSafeInteger(value.minimumFreeBytes) ||
    value.minimumFreeBytes < 0 ||
    value.expectedBytes + value.minimumFreeBytes !== value.requiredBytes
  )
    throw new Error("Invalid process temporary storage admission");

  return {
    directory: value.directory,
    filesystemDirectory: value.filesystemDirectory,
    availableBytes: value.availableBytes,
    requiredBytes: value.requiredBytes,
    expectedBytes: value.expectedBytes,
    minimumFreeBytes: value.minimumFreeBytes,
  };
}

function readJournal(path: string): Journal {
  const stat = lstatSync(path);

  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 16_384 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("Invalid process temporary storage journal");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.allocationId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.allocationId) ||
    typeof value.pluginId !== "string" ||
    (value.origin !== "host-worker" && value.origin !== "provider-bridge") ||
    typeof value.tempDir !== "string" ||
    !isAbsolute(value.tempDir) ||
    !isIdentity(value.root) ||
    !isIdentity(value.registry) ||
    typeof value.marker !== "string" ||
    (value.owner !== null && !isOwner(value.owner)) ||
    typeof value.createdAt !== "string"
  )
    throw new Error("Invalid process temporary storage journal");

  return {
    version: 1,
    allocationId: value.allocationId,
    pluginId: value.pluginId,
    origin: value.origin,
    tempDir: value.tempDir,
    root: value.root,
    registry: value.registry,
    marker: value.marker,
    owner: value.owner,
    createdAt: value.createdAt,
    admission: readAdmission(value.admission),
  };
}

function validate(journal: Journal, registry: string): void {
  if (
    !sameIdentity(identity(registry), journal.registry) ||
    !sameIdentity(identity(journal.tempDir), journal.root)
  )
    throw new Error("Process temporary storage physical identity changed");
  const markerPath = join(journal.tempDir, ".omnyo-process-private.json");
  const markerStat = lstatSync(markerPath);

  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1 ||
    markerStat.size > 16_384 ||
    (process.platform !== "win32" && (markerStat.mode & 0o077) !== 0) ||
    (process.getuid !== undefined && markerStat.uid !== process.getuid()) ||
    readFileSync(markerPath, "utf8") !== journal.marker
  )
    throw new Error("Process temporary storage allocation marker changed");
}

function inspection(
  journal: Journal,
  status: ProcessPrivateTempInspection["status"],
  reason: string,
): ProcessPrivateTempInspection {
  return {
    allocationId: journal.allocationId,
    pluginId: journal.pluginId,
    origin: journal.origin,
    tempDir: journal.tempDir,
    status,
    reason,
    sizeBytes: null,
  };
}

function closeout(
  journal: Journal,
  registry: string,
  reason: string,
  sizeBytes: number | null = null,
  remove: (() => void) | null = null,
): ProcessPrivateTempInspection {
  validate(journal, registry);
  identity(join(registry, "closed"));
  const path = join(registry, `${journal.allocationId}.json`);
  const removingPath = join(registry, `${journal.allocationId}.removing`);
  renameSync(path, removingPath);
  syncDirectory(registry);
  validate(journal, registry);

  if (remove === null)
    rmSync(journal.tempDir, { recursive: true, force: false });
  else remove();
  const result = { ...inspection(journal, "removed", reason), sizeBytes };
  durableWrite(join(registry, "closed", `${journal.allocationId}.json`), {
    ...journal,
    result,
    closedAt: new Date().toISOString(),
  });
  rmSync(removingPath);
  syncDirectory(registry);

  return result;
}

export async function createPluginProcessTempAllocation(
  args: {
    pluginId: string;
    prefix: string;
    origin: Origin;
    owner: "self" | "child";
  } & RegistryOptions,
): Promise<{
  tempDir: string;
  allocationId: string;
  attachChild: (child: ChildProcess) => Promise<void>;
  closeUnstarted: () => void;
}> {
  if (!args.pluginId || !args.prefix || basename(args.prefix) !== args.prefix)
    throw new Error("Invalid process temporary allocation name");

  const admission = await assertStorageAdmission({
    directory: realpathSync(tmpdir()),
    expectedBytes: 256 * 1024 ** 2,
    minimumFreeBytes: 1024 ** 3,
  });

  let registry = registryPath(args);
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  registry = registryPath(args);
  const registryIdentity = identity(registry);
  mkdirSync(join(registry, "closed"), { mode: 0o700, recursive: true });
  identity(join(registry, "closed"));

  const tempDir = realpathSync(
    mkdtempSync(
      join(tmpdir(), `${args.prefix}-${encodeURIComponent(args.pluginId)}-`),
    ),
  );

  const allocationId = randomUUID();
  const root = identity(tempDir);
  const marker = JSON.stringify({ allocationId, root, nonce: randomUUID() });

  const markerFd = openSync(
    join(tempDir, ".omnyo-process-private.json"),
    "wx",
    0o600,
  );

  try {
    writeFileSync(markerFd, marker);
    fsyncSync(markerFd);
  } finally {
    closeSync(markerFd);
  }

  syncDirectory(tempDir);

  let journal: Journal = {
    version: 1,
    allocationId,
    pluginId: args.pluginId,
    origin: args.origin,
    tempDir,
    root,
    registry: registryIdentity,
    marker,
    owner: null,
    createdAt: new Date().toISOString(),
    admission,
  };

  const path = join(registry, `${allocationId}.json`);
  durableWrite(path, journal);
  let attached = args.owner === "self";
  let closed = false;

  const close = (
    remove: (() => void) | null = null,
    sizeBytes: number | null = null,
  ) => {
    if (closed) return;
    closeout(journal, registry, "producer-exit", sizeBytes, remove);
    closed = true;
  };

  const closeAfterConsumers = async () => {
    if (closed) return;
    validate(journal, registry);
    const consumers = await inspectDirectoryProcesses(journal.tempDir);

    if (consumers.kind !== "idle")
      throw new Error(
        `Process temporary closeout held by a current or unknown consumer: ${consumers.message}`,
      );
    const deadline = Date.now() + 5_000;

    const sizeBytes = measurePrivateTemp(
      journal.tempDir,
      journal.root.dev,
      deadline,
    );

    close(
      () => removePrivateTempTree(journal.tempDir, journal.root.dev, deadline),
      sizeBytes,
    );
  };

  if (args.owner === "self")
    process.once("beforeExit", () => {
      void closeAfterConsumers().catch((error: unknown) => {
        process.stderr.write(
          `Process temporary closeout held: ${error instanceof Error ? error.message : "unknown failure"}\n`,
        );
      });
    });

  if (args.owner === "self") {
    journal = { ...journal, owner: await processOwner(process.pid) };
    durableWrite(path, journal);
  }

  return {
    tempDir,
    allocationId,
    async attachChild(child) {
      if (attached || closed)
        throw new Error("Process temporary allocation already has an owner");
      attached = true;

      const stopped = new Promise<void>((resolve, reject) =>
        child.once("close", () => {
          void closeAfterConsumers().then(resolve, reject);
        }),
      );

      await Promise.all([
        (async () => {
          const owner =
            child.pid === undefined ? null : await processOwner(child.pid);

          if (!closed) {
            journal = { ...journal, owner };
            durableWrite(path, journal);
          }
        })(),
        stopped,
      ]);
    },
    closeUnstarted() {
      if (attached)
        throw new Error("Process temporary allocation already has a consumer");
      close();
    },
  };
}

export async function inspectProcessPrivateTemps(
  options: RegistryOptions & { budgetSeconds?: number } = {},
): Promise<ProcessPrivateTempInspection[]> {
  const budgetSeconds = options.budgetSeconds ?? 30;

  if (
    !Number.isFinite(budgetSeconds) ||
    budgetSeconds <= 0 ||
    budgetSeconds > 60
  )
    throw new Error("Invalid process temporary inspection budget");
  const deadline = Date.now() + budgetSeconds * 1_000;
  const registry = registryPath(options);

  if (!existsSync(registry)) return [];
  identity(registry);
  const results: ProcessPrivateTempInspection[] = [];

  for (const file of readdirSync(registry)
    .filter((name) => /^[0-9a-f-]{36}\.(?:json|removing)$/u.test(name))
    .sort()) {
    let journal: Journal;

    try {
      journal = readJournal(join(registry, file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }

    if (
      file !== `${journal.allocationId}.json` &&
      file !== `${journal.allocationId}.removing`
    )
      throw new Error("Process temporary journal identity changed");

    if (file.endsWith(".removing")) {
      results.push(inspection(journal, "held", "closeout-outcome-unknown"));
      continue;
    }

    try {
      validate(journal, registry);

      if (Date.now() >= deadline) {
        results.push(
          inspection(
            journal,
            "held",
            "process-temporary-time-budget-exhausted",
          ),
        );
        continue;
      }

      const state = await ownerState(journal.owner);

      if (state === "stopped") {
        const consumers = await inspectPrivateTempConsumers(
          journal.tempDir,
          deadline,
        );

        if (consumers !== null) {
          results.push(inspection(journal, "held", consumers));
          continue;
        }
      }

      results.push(
        inspection(
          journal,
          state === "stopped"
            ? "recoverable"
            : state === "active"
              ? "active"
              : "held",
          state === "stopped"
            ? "recorded-generation-stopped"
            : state === "active"
              ? "recorded-generation-active"
              : "process-identity-unknown",
        ),
      );
    } catch (error) {
      results.push(
        inspection(
          journal,
          "held",
          error instanceof Error ? error.message : "inspection-failed",
        ),
      );
    }
  }

  return results;
}

async function inspectPrivateTempConsumers(
  directory: string,
  deadline: number,
): Promise<string | null> {
  const remaining = deadline - Date.now();

  if (remaining <= 0) return "process-temporary-time-budget-exhausted";

  const result = await inspectDirectoryProcesses(
    directory,
    AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))),
  );

  return result.kind === "idle" ? null : result.message;
}

function measurePrivateTemp(
  directory: string,
  rootDevice: number,
  deadline: number,
): number {
  const pending = [directory];
  let bytes = 0;

  while (pending.length > 0) {
    if (Date.now() >= deadline)
      throw new Error("process-temporary-time-budget-exhausted");
    const path = pending.pop();

    if (path === undefined) break;
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) continue;

    if (stat.dev !== rootDevice)
      throw new Error("process-temporary-device-boundary-changed");

    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) pending.push(join(path, entry));
    } else if (stat.isFile()) bytes += stat.size;
    else throw new Error("process-temporary-special-file-held");
  }

  return bytes;
}

function removePrivateTempTree(
  path: string,
  rootDevice: number,
  deadline: number,
): void {
  if (Date.now() >= deadline)
    throw new Error("process-temporary-time-budget-exhausted");
  const stat = lstatSync(path);

  if (stat.isSymbolicLink()) {
    unlinkSync(path);

    return;
  }

  if (stat.dev !== rootDevice)
    throw new Error("process-temporary-device-boundary-changed");

  if (stat.isDirectory()) {
    for (const entry of readdirSync(path))
      removePrivateTempTree(join(path, entry), rootDevice, deadline);

    if (lstatSync(path).dev !== rootDevice)
      throw new Error("process-temporary-device-boundary-changed");
    rmdirSync(path);
  } else if (stat.isFile()) unlinkSync(path);
  else throw new Error("process-temporary-special-file-held");
}

export async function recoverProcessPrivateTemps(
  options: RegistryOptions & {
    limit?: number;
    maxBytes?: number;
    budgetSeconds?: number;
  } = {},
): Promise<ProcessPrivateTempInspection[]> {
  const registry = registryPath(options);
  const limit = options.limit ?? 100;

  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000)
    throw new Error("Invalid process temporary recovery limit");
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const budgetSeconds = options.budgetSeconds ?? 30;

  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isFinite(budgetSeconds) ||
    budgetSeconds <= 0 ||
    budgetSeconds > 60
  )
    throw new Error("Invalid process temporary recovery budget");
  const deadline = Date.now() + budgetSeconds * 1_000;
  const results = await inspectProcessPrivateTemps(options);
  let recovered = 0;
  let removedBytes = 0;

  const output: ProcessPrivateTempInspection[] = [];

  for (const result of results) {
    if (result.status !== "recoverable" || recovered >= limit) {
      output.push(result);
      continue;
    }

    try {
      const journal = readJournal(
        join(registry, `${result.allocationId}.json`),
      );

      if ((await ownerState(journal.owner)) !== "stopped") {
        output.push(inspection(journal, "held", "process-identity-changed"));
        continue;
      }

      validate(journal, registry);

      const sizeBytes = measurePrivateTemp(
        journal.tempDir,
        journal.root.dev,
        deadline,
      );

      if (sizeBytes > maxBytes - removedBytes) {
        output.push({
          ...inspection(
            journal,
            "held",
            "process-temporary-byte-budget-exhausted",
          ),
          sizeBytes,
        });
        continue;
      }

      if (Date.now() >= deadline) {
        output.push(
          inspection(
            journal,
            "held",
            "process-temporary-time-budget-exhausted",
          ),
        );
        continue;
      }

      const consumers = await inspectPrivateTempConsumers(
        journal.tempDir,
        deadline,
      );

      if (consumers !== null) {
        output.push(inspection(journal, "held", consumers));
        continue;
      }

      if ((await ownerState(journal.owner)) !== "stopped") {
        output.push(inspection(journal, "held", "process-identity-changed"));
        continue;
      }

      validate(journal, registry);

      if (
        measurePrivateTemp(journal.tempDir, journal.root.dev, deadline) !==
        sizeBytes
      ) {
        output.push(
          inspection(journal, "held", "process-temporary-payload-changed"),
        );
        continue;
      }

      const closed = closeout(
        journal,
        registry,
        "stopped-generation-recovery",
        sizeBytes,
        () =>
          removePrivateTempTree(journal.tempDir, journal.root.dev, deadline),
      );

      recovered += 1;
      removedBytes += sizeBytes;

      output.push(closed);
    } catch (error) {
      output.push({
        ...result,
        status: "held",
        reason: error instanceof Error ? error.message : "recovery-failed",
      });
    }
  }

  return output;
}
