import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  maintenanceStatusSchema,
  maintenanceAcquireResultSchema,
  maintenanceReleaseResultSchema,
  type AcquireUpdateHold,
  type ReleaseHold,
} from "@omnyo/server-contract";

export const privateUpdateArtifactSchema = z
  .object({
    version: z.string(),
    runtimeVersion: z.string(),
    protocolVersion: z.number().int().positive(),
    appId: z.string(),
    teamId: z.string(),
    sha512: z.string(),
    runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    desktopSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    executableSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export type PrivateUpdateArtifact = z.infer<typeof privateUpdateArtifactSchema>;

export type PrivateDesktopUpdateRuntime =
  | { kind: "owned"; child: ChildProcess; dataDir: string; serverUrl: string }
  | { kind: "remote-only" | "attached" | "unknown" };

const journalSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    phase: z.enum([
      "prepared",
      "held",
      "native-started",
      "native-ready",
      "handoff",
      "released",
    ]),
    serverHostId: z.string().nullable(),
    runtimeId: z.string().nullable(),
    artifact: privateUpdateArtifactSchema,
  })
  .strict();

type Journal = z.infer<typeof journalSchema>;

interface InstallerArgs {
  verifyInstalledArtifact(): Promise<void>;
  journalPath: string;
  currentVersion(): string;
  protocolVersion: number;
  runtime(): PrivateDesktopUpdateRuntime;
  inspectArtifact(): Promise<PrivateUpdateArtifact>;
  inspectInstalledArtifact(): Promise<PrivateUpdateArtifact>;
  stageNativeUpdate(): Promise<void>;
  finishQuit(): Promise<void>;
  quitAndInstall(): void;
}

const execute = promisify(execFile);

function readJournal(path: string): Journal | null {
  try {
    const bytes = readFileSync(path);

    if (bytes.length > 16384) throw new Error();

    return journalSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error("Private update handoff journal is invalid");
  }
}

async function persist(path: string, journal: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID();

  try {
    const file = await open(temporary, "wx", 0o600);

    try {
      await file.writeFile(JSON.stringify(journal));
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, path);

    if (process.platform === "win32") return;
    const directory = await open(dirname(path), "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function processParent(pid: number): Promise<number> {
  if (process.platform === "win32") {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Private update process ownership is uncertain");

    const result = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 1 }; Write-Output $p.ParentProcessId`,
      ],
      { timeout: 5000, maxBuffer: 1024, windowsHide: true },
    );

    const parent = Number(result.stdout.trim());

    if (!Number.isSafeInteger(parent) || parent <= 0)
      throw new Error("Private update process ownership is uncertain");

    return parent;
  }

  const result = await execute(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,ppid="],
    { timeout: 5000, maxBuffer: 1024 },
  );

  const fields = result.stdout.trim().split(/\s+/).map(Number);

  if (
    fields.length !== 2 ||
    fields[0] !== pid ||
    !Number.isSafeInteger(fields[1])
  )
    throw new Error("Private update process ownership is uncertain");

  return fields[1] ?? -1;
}

function localBase(
  runtime: Extract<PrivateDesktopUpdateRuntime, { kind: "owned" }>,
): URL {
  const url = new URL(runtime.serverUrl);

  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Private update local server ownership is uncertain");

  return url;
}

async function request<T>(
  runtime: Extract<PrivateDesktopUpdateRuntime, { kind: "owned" }>,
  suffix: string,
  schema: z.ZodType<T>,
  body?: AcquireUpdateHold | ReleaseHold,
): Promise<T> {
  const url = new URL(
    "/api/v1/server/maintenance" + suffix,
    localBase(runtime),
  );

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) throw new Error();

    if (response.body === null) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();

    try {
      while (true) {
        const result = await reader.read();

        if (result.done) break;
        size += result.value.byteLength;

        if (size > 131072) throw new Error();
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel();
    }

    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new Error(
      "Private update maintenance request failed; the runtime remains running",
    );
  }
}

async function ownedStatus(
  runtime: Extract<PrivateDesktopUpdateRuntime, { kind: "owned" }>,
) {
  const status = await request(runtime, "", maintenanceStatusSchema);
  const pid = runtime.child.pid;

  if (
    pid === undefined ||
    runtime.child.exitCode !== null ||
    runtime.child.signalCode !== null ||
    (await processParent(pid)) !== process.pid ||
    status.runtime.parentProcessId !== pid ||
    (await processParent(status.runtime.processId)) !== pid ||
    resolve(status.runtime.dataDir) !== resolve(runtime.dataDir) ||
    status.runtime.serverHostId === null ||
    status.runtime.launchId === null
  )
    throw new Error("Private update process ownership is uncertain");

  return status;
}

export function createPrivateDesktopUpdateInstaller(args: InstallerArgs) {
  let journal = readJournal(args.journalPath);
  let pending: Promise<void> | null = null;
  let pendingOperation: "install" | "recover" | null = null;
  let inOperation = false;

  async function save(phase: Journal["phase"]) {
    if (journal === null) throw new Error("Private update handoff is missing");
    const next = { ...journal, phase };
    await persist(args.journalPath, next);
    journal = next;
  }

  async function install() {
    await args.verifyInstalledArtifact();

    if (journal?.phase === "prepared") await recover();

    if (journal !== null && journal.phase !== "released")
      throw new Error("Private update handoff requires recovery");

    const artifact = privateUpdateArtifactSchema.parse(
      await args.inspectArtifact(),
    );

    if (artifact.protocolVersion < args.protocolVersion)
      throw new Error("Private update artifact is invalid");
    const runtime = args.runtime();

    if (runtime.kind !== "owned" && runtime.kind !== "remote-only")
      throw new Error("Private update runtime ownership is uncertain");
    const status = runtime.kind === "owned" ? await ownedStatus(runtime) : null;

    if (status?.hold !== null && status !== null)
      throw new Error("Private update admission is already held");
    journal = {
      schema: 1,
      id: randomUUID(),
      ownerId: randomUUID(),
      phase: "prepared",
      serverHostId: status?.runtime.serverHostId ?? null,
      runtimeId: status?.runtime.runtimeId ?? null,
      artifact,
    };
    await persist(args.journalPath, journal);

    if (runtime.kind === "owned" && status !== null) {
      const serverHostId = status.runtime.serverHostId;

      if (serverHostId === null)
        throw new Error("Private update server identity is unavailable");

      const acquired = await request(
        runtime,
        "/acquire",
        maintenanceAcquireResultSchema,
        {
          id: journal.id,
          ownerId: journal.ownerId,
          expectedRuntimeId: status.runtime.runtimeId,
          expectedServerHostId: serverHostId,
          expectedDataDir: runtime.dataDir,
        },
      );

      if (
        !acquired.acquired ||
        acquired.hold.id !== journal.id ||
        acquired.hold.ownerId !== journal.ownerId ||
        acquired.hold.phase !== "held" ||
        acquired.hold.kind !== "desktop-update" ||
        acquired.hold.serverHostId !== journal.serverHostId ||
        acquired.runtime.runtimeId !== status.runtime.runtimeId ||
        acquired.runtime.processId !== status.runtime.processId ||
        acquired.runtime.parentProcessId !== status.runtime.parentProcessId ||
        resolve(acquired.runtime.dataDir) !== resolve(runtime.dataDir)
      )
        throw new Error("Private update hold acquisition is uncertain");
      await save("held");
    }

    await save("native-started");
    await args.stageNativeUpdate();
    await save("native-ready");

    if (runtime.kind === "owned") {
      const current = args.runtime();

      if (
        current.kind !== "owned" ||
        current.child !== runtime.child ||
        current.dataDir !== runtime.dataDir ||
        current.serverUrl !== runtime.serverUrl
      )
        throw new Error("Private update runtime changed before shutdown");
      const final = await ownedStatus(runtime);

      if (
        final.runtime.runtimeId !== journal.runtimeId ||
        final.hold?.id !== journal.id ||
        final.hold.ownerId !== journal.ownerId ||
        final.hold.phase !== "held"
      )
        throw new Error("Private update hold changed before shutdown");
    } else if (args.runtime().kind !== "remote-only")
      throw new Error("Private update runtime changed before shutdown");
    await save("handoff");
    await args.finishQuit();
    args.quitAndInstall();
  }

  async function recover() {
    if (journal === null || journal.phase === "released") return;
    await args.verifyInstalledArtifact();
    const runtime = args.runtime();
    const nativeCommitted = !["prepared", "held"].includes(journal.phase);

    if (nativeCommitted) {
      const installed = privateUpdateArtifactSchema.parse(
        await args.inspectInstalledArtifact(),
      );

      if (
        args.currentVersion() !== journal.artifact.runtimeVersion ||
        args.protocolVersion !== journal.artifact.protocolVersion ||
        installed.version !== journal.artifact.version ||
        installed.runtimeVersion !== journal.artifact.runtimeVersion ||
        installed.protocolVersion !== journal.artifact.protocolVersion ||
        installed.runtimeSha256 !== journal.artifact.runtimeSha256 ||
        installed.desktopSha256 !== journal.artifact.desktopSha256 ||
        installed.executableSha256 !== journal.artifact.executableSha256 ||
        installed.appId !== journal.artifact.appId ||
        installed.teamId !== journal.artifact.teamId
      )
        throw new Error(
          "Private update replacement identity does not match the handoff",
        );
    }

    if (journal.serverHostId !== null) {
      if (runtime.kind !== "owned")
        throw new Error("Private update replacement runtime is not owned");
      const status = await ownedStatus(runtime);

      if (
        status.runtime.serverHostId !== journal.serverHostId ||
        (nativeCommitted &&
          (status.runtime.appVersion !== journal.artifact.runtimeVersion ||
            status.runtime.protocolVersion !==
              journal.artifact.protocolVersion))
      )
        throw new Error("Private update replacement runtime is incompatible");

      if (status.hold !== null) {
        if (
          status.hold.id !== journal.id ||
          status.hold.ownerId !== journal.ownerId ||
          status.hold.kind !== "desktop-update" ||
          status.hold.serverHostId !== journal.serverHostId
        )
          throw new Error(
            "Private update replacement hold owner does not match",
          );
      }

      if (status.hold === null && !nativeCommitted) {
        const acquired = await request(
          runtime,
          "/acquire",
          maintenanceAcquireResultSchema,
          {
            id: journal.id,
            ownerId: journal.ownerId,
            expectedRuntimeId: status.runtime.runtimeId,
            expectedServerHostId: journal.serverHostId,
            expectedDataDir: runtime.dataDir,
          },
        );

        if (
          acquired.hold.id !== journal.id ||
          acquired.hold.ownerId !== journal.ownerId ||
          acquired.hold.serverHostId !== journal.serverHostId ||
          acquired.hold.kind !== "desktop-update" ||
          acquired.hold.phase !== "held" ||
          acquired.runtime.runtimeId !== status.runtime.runtimeId ||
          acquired.runtime.processId !== status.runtime.processId ||
          acquired.runtime.parentProcessId !== status.runtime.parentProcessId ||
          resolve(acquired.runtime.dataDir) !== resolve(runtime.dataDir)
        )
          throw new Error("Private update acquisition recovery is uncertain");
        await save("held");
      }

      {
        const released = await request(
          runtime,
          "/release",
          maintenanceReleaseResultSchema,
          {
            id: journal.id,
            ownerId: journal.ownerId,
            expectedServerHostId: journal.serverHostId,
          },
        );

        if (!released.released || released.id !== journal.id)
          throw new Error("Private update hold release is uncertain");
      }
    } else if (runtime.kind !== "remote-only")
      throw new Error("Private update remote-only ownership changed");
    await save("released");
  }

  function runOperation(kind: "install" | "recover"): Promise<void> {
    if (pending !== null) {
      return pendingOperation === kind
        ? pending
        : pending.then(() => runOperation(kind));
    }

    inOperation = true;
    pendingOperation = kind;
    const operation = kind === "install" ? install() : recover();
    pending = operation;
    void operation
      .finally(() => {
        pending = null;
        pendingOperation = null;
        inOperation = false;
      })
      .catch(() => {});

    return operation;
  }

  return {
    install: () => runOperation("install"),
    recover: () => runOperation("recover"),
    canQuitOrdinarily(): boolean {
      return (
        !inOperation &&
        (journal === null ||
          ["prepared", "held", "released"].includes(journal.phase))
      );
    },
  };
}
