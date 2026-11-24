import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { experimental_assertStorageAdmission as assertStorageAdmission } from "@omnyo/plugin-sdk/host";
import {
  MANAGED_HOLDING_MS,
  managedGrantSchema,
  managedHoldSchema,
  managedHostAllocateSchema,
  managedHostDecisionSchema,
  managedHostTransitionSchema,
  managedSnapshotSchema,
  managedIdSchema,
  managedThreadIdSchema,
  managedProjectIdSchema,
  managedHostIdSchema,
  managedDispositionSchema,
  managedStorageSchema,
  managedCloseoutSchema,
  type ManagedAllocation,
  type ManagedHostAllocate,
  type ManagedHostDecision,
  type ManagedHostTransition,
} from "./managed-contract.js";
import {
  inspectManagedProcesses,
  type ManagedProcessInspector,
} from "./managed-process-inspection.js";

import {
  managedMountInspection,
  type ManagedMountInspection,
} from "./managed-mount-inspection.js";

const identitySchema = z
  .object({ dev: z.string(), ino: z.string(), volumeId: z.string().optional() })
  .strict();

const execFileAsync = promisify(execFile);

async function nativeVolumeIdentity(target: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const options = { timeout: 2000, maxBuffer: 256 * 1024 };

  const device = (
    await execFileAsync("/usr/bin/stat", ["-f", "%Sd", target], options)
  ).stdout.trim();

  if (!/^disk\d+s\d+$/.test(device))
    throw new Error("The volume device could not be identified.");

  const { stdout } = await execFileAsync(
    "/usr/sbin/diskutil",
    ["info", "-plist", device],
    options,
  );

  const match = stdout.match(
    /<key>DiskUUID<\/key>\s*<string>([0-9A-Fa-f-]{36})<\/string>/,
  );

  if (!match?.[1]) throw new Error("The volume UUID could not be identified.");

  return z.uuid().parse(match[1].toLowerCase());
}

const entrySchema = z
  .object({
    relative: z.string(),
    kind: z.enum(["directory", "file", "symlink"]),
    dev: z.string(),
    ino: z.string(),
    mode: z.string(),
    nlink: z.string(),
    size: z.string(),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
    link: z.string().nullable(),
  })
  .strict();

const captureSchema = z
  .object({ snapshot: managedSnapshotSchema, entries: z.array(entrySchema) })
  .strict();

const authoritySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("granted"),
      grant: managedGrantSchema,
      reviewedAt: z.number().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("revoked") }).strict(),
]);

const phaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["allocated", "kept"]),
      capture: captureSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proposed"),
      capture: captureSchema,
      grant: managedGrantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("approved"),
      capture: captureSchema,
      authority: authoritySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("quarantine-intent"),
      capture: captureSchema,
      authority: authoritySchema,
      intentAt: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("quarantined"),
      capture: captureSchema,
      authority: authoritySchema,
      quarantinedAt: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore-intent"),
      capture: captureSchema,
      quarantinedAt: z.number(),
      intentAt: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("purge-intent"),
      capture: captureSchema,
      authority: authoritySchema,
      quarantinedAt: z.number(),
      intentAt: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("removed"),
      removedLogicalBytes: z.number(),
      removedAt: z.number(),
    })
    .strict(),
]);

const manifestSchema = z
  .object({
    version: z.literal(1),
    id: managedIdSchema,
    hostId: managedHostIdSchema,
    ownerThreadId: managedThreadIdSchema,
    projectId: managedProjectIdSchema.nullable(),
    requestKey: z.string(),
    purpose: z.string(),
    disposition: managedDispositionSchema,
    storage: managedStorageSchema.nullable().default(null),
    closeout: managedCloseoutSchema.nullable().default(null),
    createdAt: z.number(),
    revision: z.number().int().positive(),
    payloadIdentity: identitySchema,
    containerIdentity: identitySchema,
    ownerIdentity: identitySchema,
    phase: phaseSchema,
    reason: z.string().nullable(),
    hold: managedHoldSchema.nullable(),
    consumers: z.array(
      z
        .object({
          threadId: managedThreadIdSchema,
          releasedAt: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const installationSchema = z
  .object({
    version: z.literal(1),
    id: managedIdSchema,
    anchors: z.array(
      z.object({ path: z.string(), identity: identitySchema }).strict(),
    ),
  })
  .strict();

type Manifest = z.infer<typeof manifestSchema>;

type Capture = z.infer<typeof captureSchema>;

type Entry = z.infer<typeof entrySchema>;

type Identity = z.infer<typeof identitySchema>;

type Installation = z.infer<typeof installationSchema>;

type Exact = { id: string; revision: number; snapshotDigest: string | null };

export type ManagedHostOptions = {
  dataDir: string;
  homeDirectory?: string;
  inspectProcesses?: ManagedProcessInspector;
  mountInspection?: ManagedMountInspection;
  now?: () => number;
  maxEntries?: number;
  maxScanMs?: number;
  volumeIdentity?: (target: string) => Promise<string | null>;
  fault?: (
    stage:
      | "after-allocation-payload"
      | "after-intent"
      | "after-rename"
      | "before-unlink"
      | "after-unlink",
    id: string,
  ) => Promise<void> | void;
};

class Held extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function statOrNull(target: string) {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function identity(stats: BigIntStats): Identity {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sameIdentity(left: Identity, right: Identity) {
  return (
    left.ino === right.ino &&
    (right.volumeId !== undefined
      ? left.volumeId === right.volumeId
      : left.dev === right.dev)
  );
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function phaseCapture(manifest: Manifest) {
  return "capture" in manifest.phase ? manifest.phase.capture : null;
}

function phaseAuthority(manifest: Manifest) {
  if (manifest.phase.kind === "proposed")
    return { grant: manifest.phase.grant, reviewedAt: null };

  if (
    "authority" in manifest.phase &&
    manifest.phase.authority.kind === "granted"
  )
    return manifest.phase.authority;

  return { grant: null, reviewedAt: null };
}

export function createManagedHost(options: ManagedHostOptions) {
  const now = options.now ?? Date.now;
  const inspectProcesses = options.inspectProcesses ?? inspectManagedProcesses;
  const mounts = options.mountInspection ?? managedMountInspection;
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const stateRoot = path.join(options.dataDir, "managed-cleanup");
  const manifestsRoot = path.join(stateRoot, "allocations");
  const queues = new Map<string, Promise<unknown>>();
  const volumes = new Map<string, Promise<string | null>>();
  let initialization: Promise<Installation> | null = null;

  function platformHold() {
    return process.platform === "win32"
      ? {
          code: "platform-unsupported",
          message:
            "Windows metadata files are flushed and atomically renamed, but Node cannot flush directory entries on this host. Crash durability is limited and physical cleanup remains unsupported.",
          at: now(),
        }
      : null;
  }

  async function syncDirectory(target: string) {
    if (process.platform === "win32") return;

    const directory = await fs.open(target, "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async function atomicWrite(target: string, value: unknown) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  }

  async function directoryIdentity(target: string) {
    const stats = await fs.lstat(target, { bigint: true });

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Held(
        "path-identity",
        "A managed parent is no longer an ordinary directory.",
      );

    const dev = String(stats.dev);
    let pending = volumes.get(dev);

    if (pending === undefined) {
      pending = (options.volumeIdentity ?? nativeVolumeIdentity)(target);
      volumes.set(dev, pending);
    }

    const volumeId = await pending;

    return { ...identity(stats), ...(volumeId === null ? {} : { volumeId }) };
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      await fs.mkdir(manifestsRoot, { recursive: true, mode: 0o700 });
      const file = path.join(stateRoot, "installation.json");

      try {
        return installationSchema.parse(
          JSON.parse(await fs.readFile(file, "utf8")),
        );
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }

      const id = randomUUID();
      const scratch = path.join(home, "scratch");
      const omnyo = path.join(scratch, "omnyo");
      const parents = [home, scratch, omnyo];

      for (const parent of parents) {
        if (parent !== home)
          await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        await directoryIdentity(parent);
      }

      const root = path.join(omnyo, `${id}--managed-cleanup`);
      await fs.mkdir(root, { mode: 0o700 });
      const anchors = [];

      for (const target of [...parents, root])
        anchors.push({
          path: target,
          identity: await directoryIdentity(target),
        });
      const installation = { version: 1, id, anchors } satisfies Installation;
      await atomicWrite(path.join(root, ".managed-cleanup.json"), {
        version: 1,
        installationId: id,
      });
      await atomicWrite(file, installation);

      return installation;
    })();

    return initialization;
  }

  function rootFor(installation: Installation) {
    return path.join(
      home,
      "scratch",
      "omnyo",
      `${installation.id}--managed-cleanup`,
    );
  }

  function paths(manifest: Manifest, installation: Installation) {
    const owner = path.join(rootFor(installation), manifest.ownerThreadId);
    const container = path.join(owner, manifest.id);

    return {
      owner,
      container,
      payload: path.join(container, "payload"),
      quarantine: path.join(container, "quarantine"),
    };
  }

  async function validateParents(
    manifest: Manifest,
    installation: Installation,
  ) {
    const expected = [
      home,
      path.join(home, "scratch"),
      path.join(home, "scratch", "omnyo"),
      rootFor(installation),
    ];

    if (installation.anchors.length !== expected.length)
      throw new Held(
        "path-identity",
        "The managed namespace anchors are incomplete.",
      );

    for (const [index, target] of expected.entries()) {
      const anchor = installation.anchors[index];

      if (
        !anchor ||
        anchor.path !== target ||
        !sameIdentity(await directoryIdentity(target), anchor.identity)
      )
        throw new Held(
          "path-identity",
          "The managed namespace identity changed.",
        );
    }

    const current = paths(manifest, installation);

    if (
      !sameIdentity(
        await directoryIdentity(current.owner),
        manifest.ownerIdentity,
      ) ||
      !sameIdentity(
        await directoryIdentity(current.container),
        manifest.containerIdentity,
      )
    )
      throw new Held(
        "path-identity",
        "The allocation parent identity changed.",
      );

    const markerStats = await fs.lstat(
      path.join(rootFor(installation), ".managed-cleanup.json"),
    );

    if (!markerStats.isFile() || markerStats.isSymbolicLink())
      throw new Held(
        "path-identity",
        "The managed namespace marker is not an ordinary file.",
      );

    const marker = z
      .object({ version: z.literal(1), installationId: managedIdSchema })
      .strict()
      .parse(
        JSON.parse(
          await fs.readFile(
            path.join(rootFor(installation), ".managed-cleanup.json"),
            "utf8",
          ),
        ),
      );

    if (marker.installationId !== installation.id)
      throw new Held("path-identity", "The managed namespace marker changed.");
  }

  async function load(id: string) {
    managedIdSchema.parse(id);

    return manifestSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(manifestsRoot, `${id}.json`), "utf8"),
      ),
    );
  }

  async function save(manifest: Manifest) {
    manifestSchema.parse(manifest);
    await atomicWrite(
      path.join(manifestsRoot, `${manifest.id}.json`),
      manifest,
    );
  }

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const key = "namespace";
    const previous = queues.get(key) ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(() => {
        volumes.clear();

        return action();
      });

    queues.set(key, next);
    void next
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => undefined);

    return next;
  }

  function currentPath(manifest: Manifest, installation: Installation) {
    const current = paths(manifest, installation);

    return ["quarantined", "purge-intent", "restore-intent"].includes(
      manifest.phase.kind,
    )
      ? current.quarantine
      : current.payload;
  }

  function project(
    manifest: Manifest,
    installation: Installation,
  ): ManagedAllocation {
    const capture = phaseCapture(manifest);
    const authority = phaseAuthority(manifest);

    const quarantinedAt =
      "quarantinedAt" in manifest.phase ? manifest.phase.quarantinedAt : null;

    return {
      id: manifest.id,
      hostId: manifest.hostId,
      ownerThreadId: manifest.ownerThreadId,
      projectId: manifest.projectId,
      purpose: manifest.purpose,
      disposition: manifest.disposition,
      storage: manifest.storage,
      closeout: manifest.closeout,
      createdAt: manifest.createdAt,
      revision: manifest.revision,
      phase: manifest.phase.kind,
      path: currentPath(manifest, installation),
      originalPath: paths(manifest, installation).payload,
      snapshot: capture?.snapshot ?? null,
      grant: authority.grant,
      reviewedAt: authority.reviewedAt,
      quarantinedAt,
      purgeEligibleAt:
        quarantinedAt === null ? null : quarantinedAt + MANAGED_HOLDING_MS,
      hold: manifest.hold,
      consumers: manifest.consumers,
      removedLogicalBytes:
        manifest.phase.kind === "removed"
          ? manifest.phase.removedLogicalBytes
          : 0,
      reason: manifest.reason,
    };
  }

  function exact(manifest: Manifest, input: Exact) {
    if (
      input.revision !== manifest.revision ||
      input.snapshotDigest !== (phaseCapture(manifest)?.snapshot.digest ?? null)
    )
      throw new Error(
        "The allocation changed; inspect it and use its current revision and snapshot.",
      );
  }

  function revoke(
    manifest: Manifest,
    capture: Capture | null = phaseCapture(manifest),
  ) {
    manifest.closeout = null;

    switch (manifest.phase.kind) {
      case "removed":
        return;
      case "quarantined":
      case "quarantine-intent":
      case "purge-intent":
        manifest.phase = { ...manifest.phase, authority: { kind: "revoked" } };

        return;
      case "restore-intent":
        return;
      case "allocated":
      case "kept":
      case "proposed":
      case "approved":
        manifest.phase = { kind: "kept", capture };

        return;
      default: {
        const impossible: never = manifest.phase;
        throw impossible;
      }
    }
  }

  function hold(manifest: Manifest, error: unknown) {
    manifest.hold = {
      code: error instanceof Held ? error.code : "inspection-failed",
      message:
        error instanceof Held
          ? error.message
          : "The allocation could not be inspected completely; its files remain held.",
      at: now(),
    };
  }

  async function entry(
    target: string,
    relative: string,
    rootDev: string,
  ): Promise<Entry> {
    const stats = await fs.lstat(target, { bigint: true });

    if (String(stats.dev) !== rootDev)
      throw new Held(
        "mount-boundary",
        "The allocation crosses a filesystem device boundary.",
      );

    const kind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : null;

    if (kind === null)
      throw new Held(
        "special-file",
        "The allocation contains a special filesystem object.",
      );

    return {
      relative,
      kind,
      ...identity(stats),
      mode: String(stats.mode),
      nlink: String(stats.nlink),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      ctimeNs: String(stats.ctimeNs),
      link: kind === "symlink" ? await fs.readlink(target) : null,
    };
  }

  async function assertNoMounts(target: string, signal?: AbortSignal) {
    try {
      const snapshot = await mounts.inspect(signal);

      if (snapshot.kind === "unsupported") return;

      if (
        snapshot.mountPoints.some(
          (point) => point === target || point.startsWith(`${target}/`),
        )
      )
        throw new Held(
          "mount-boundary",
          "The allocation contains a mounted filesystem, including a same-device bind mount, and remains protected.",
        );
    } catch (error) {
      if (error instanceof Held) throw error;
      throw new Held(
        "mount-inspection-unknown",
        "The native mount table could not be inspected completely; physical cleanup remains held.",
      );
    }
  }

  async function capture(
    target: string,
    signal?: AbortSignal,
  ): Promise<Capture> {
    const started = Date.now();
    await assertNoMounts(target, signal);
    const root = await fs.lstat(target, { bigint: true });

    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Held(
        "root-identity",
        "The allocation root is no longer an ordinary directory.",
      );
    const entries: Entry[] = [];
    let logicalBytes = 0;

    async function walk(relative: string) {
      signal?.throwIfAborted();

      if (
        entries.length >= (options.maxEntries ?? 20000) ||
        Date.now() - started > (options.maxScanMs ?? 2000)
      )
        throw new Held(
          "inspection-bound",
          "The complete metadata scan exceeded its entry or time bound.",
        );
      const targetPath = relative ? path.join(target, relative) : target;
      const current = await entry(targetPath, relative, String(root.dev));
      entries.push(current);

      if (current.kind === "file") logicalBytes += Number(current.size);

      if (!Number.isSafeInteger(logicalBytes))
        throw new Held(
          "inspection-bound",
          "The logical byte count exceeded its exact reporting bound.",
        );

      if (current.kind !== "directory") return;
      const names = (await fs.readdir(targetPath)).sort();

      for (const name of names) {
        if (name === "storage-retention.json")
          throw new Held(
            "retention-receipt",
            "A storage retention receipt preserves this whole allocation.",
          );

        if ([".git", ".hg", ".svn"].includes(name))
          throw new Held(
            "repository",
            "The allocation contains a repository and remains protected.",
          );
        await walk(relative ? path.join(relative, name) : name);
      }
    }

    await walk("");

    for (const expected of entries) {
      signal?.throwIfAborted();

      if (Date.now() - started > (options.maxScanMs ?? 2000))
        throw new Held(
          "inspection-bound",
          "The metadata validation exceeded its time bound.",
        );

      const actual = await entry(
        expected.relative ? path.join(target, expected.relative) : target,
        expected.relative,
        String(root.dev),
      );

      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Held(
          "snapshot-changed",
          "The allocation changed during inspection.",
        );
    }

    return {
      snapshot: {
        digest: digest(entries),
        logicalBytes,
        entryCount: entries.length,
        capturedAt: now(),
      },
      entries,
    };
  }

  function sameAfterRename(before: Capture, after: Capture) {
    return (
      before.entries.length === after.entries.length &&
      before.entries.every((value, index) => {
        const other = after.entries[index];

        if (!other) return false;

        return (
          JSON.stringify(
            value.relative === "" ? { ...value, ctimeNs: "rename" } : value,
          ) ===
          JSON.stringify(
            other.relative === "" ? { ...other, ctimeNs: "rename" } : other,
          )
        );
      })
    );
  }

  async function fresh(
    manifest: Manifest,
    installation: Installation,
    signal?: AbortSignal,
  ) {
    await validateParents(manifest, installation);

    const target = currentPath(manifest, installation);

    if (
      !sameIdentity(await directoryIdentity(target), manifest.payloadIdentity)
    )
      throw new Held(
        "root-identity",
        "The host-created allocation root identity changed.",
      );

    return capture(target, signal);
  }

  function assertDeclaration(manifest: Manifest, observed: Capture) {
    if (manifest.storage === null)
      throw new Held(
        "storage-declaration-unknown",
        "This legacy allocation has no storage declaration. Its files remain protected; no budget or cleanup approval is inferred.",
      );

    if (observed.snapshot.logicalBytes > manifest.storage.budgetBytes)
      throw new Held(
        "storage-budget-exceeded",
        "The allocation exceeds its declared logical-byte budget. Stop new production and record a native budget extension or keep decision; existing files remain protected.",
      );
  }

  async function assertIdle(target: string, signal?: AbortSignal) {
    const inspection = await inspectProcesses(target, signal);

    if (inspection.kind !== "idle")
      throw new Held(
        inspection.kind === "busy"
          ? "process-busy"
          : "process-inspection-unknown",
        inspection.message,
      );
  }

  function assertConsumers(manifest: Manifest, settled: string[]) {
    if (
      manifest.consumers.some(
        (consumer) =>
          consumer.releasedAt === null && !settled.includes(consumer.threadId),
      )
    )
      throw new Held(
        "consumer-hold",
        "A declared consumer has not released its allocation hold.",
      );
  }

  async function inspectUnlocked(
    manifest: Manifest,
    installation: Installation,
    signal?: AbortSignal,
  ) {
    if (manifest.phase.kind === "removed") return manifest;

    if (manifest.phase.kind.endsWith("-intent")) {
      manifest.hold = {
        code: "reconciliation-required",
        message:
          "An interrupted physical transition requires reconciliation; no deletion will be replayed.",
        at: now(),
      };
      await save(manifest);

      return manifest;
    }

    try {
      const observed = await fresh(manifest, installation, signal);
      const previous = phaseCapture(manifest);

      if (previous?.snapshot.digest !== observed.snapshot.digest) {
        manifest.revision++;

        if (manifest.phase.kind === "quarantined")
          manifest.phase = {
            ...manifest.phase,
            capture: observed,
            authority: { kind: "revoked" },
            quarantinedAt: Math.max(manifest.phase.quarantinedAt, now()),
          };
        else if (
          manifest.phase.kind === "allocated" ||
          (previous === null && manifest.phase.kind === "kept")
        )
          manifest.phase = { ...manifest.phase, capture: observed };
        else revoke(manifest, observed);
      }

      assertDeclaration(manifest, observed);
      manifest.hold = platformHold();
    } catch (error) {
      hold(manifest, error);
    }

    await save(manifest);

    return manifest;
  }

  async function allocate(raw: ManagedHostAllocate, signal?: AbortSignal) {
    const input = managedHostAllocateSchema.parse(raw);

    return serialize(async () => {
      const installation = await initialize();
      signal?.throwIfAborted();

      const requestFile = path.join(
        stateRoot,
        "requests",
        `${digest([input.ownerThreadId, input.requestKey])}.json`,
      );

      const requestSchema = z
        .object({
          id: managedIdSchema,
          ownerThreadId: managedThreadIdSchema,
          requestKey: z.string(),
        })
        .strict();

      let reservation: z.infer<typeof requestSchema> | null = null;

      try {
        reservation = requestSchema.parse(
          JSON.parse(await fs.readFile(requestFile, "utf8")),
        );
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }

      if (reservation) {
        if (
          reservation.ownerThreadId !== input.ownerThreadId ||
          reservation.requestKey !== input.requestKey
        )
          throw new Error("The durable allocation request binding changed.");

        try {
          return project(await load(reservation.id), installation);
        } catch (error) {
          if (hasCode(error, "ENOENT"))
            throw new Error(
              "This allocation request was interrupted before its ticket completed. Its reserved namespace remains held; this request will not create a duplicate or adopt existing files.",
            );
          throw error;
        }
      }

      for (const anchor of installation.anchors)
        if (
          !sameIdentity(await directoryIdentity(anchor.path), anchor.identity)
        )
          throw new Held(
            "path-identity",
            "The managed namespace identity changed.",
          );
      await assertStorageAdmission({
        directory: rootFor(installation),
        expectedBytes: input.storage.budgetBytes,
        minimumFreeBytes: input.storage.minimumFreeBytes,
      });
      signal?.throwIfAborted();
      const id = randomUUID();
      await atomicWrite(requestFile, {
        id,
        ownerThreadId: input.ownerThreadId,
        requestKey: input.requestKey,
      });
      signal?.throwIfAborted();
      const owner = path.join(rootFor(installation), input.ownerThreadId);
      await fs.mkdir(owner, { recursive: true, mode: 0o700 });
      const ownerIdentity = await directoryIdentity(owner);
      const container = path.join(owner, id);
      await fs.mkdir(container, { mode: 0o700 });
      await fs.mkdir(path.join(container, "payload"), { mode: 0o700 });
      await options.fault?.("after-allocation-payload", id);
      signal?.throwIfAborted();

      const manifest: Manifest = {
        version: 1,
        id,
        hostId: input.hostId,
        ownerThreadId: input.ownerThreadId,
        projectId: input.projectId,
        requestKey: input.requestKey,
        purpose: input.purpose,
        disposition: input.disposition,
        storage: input.storage,
        closeout: null,
        createdAt: now(),
        revision: 1,
        ownerIdentity,
        payloadIdentity: await directoryIdentity(
          path.join(container, "payload"),
        ),
        containerIdentity: await directoryIdentity(container),
        phase: { kind: "allocated", capture: null },
        reason: null,
        hold: platformHold(),
        consumers: [],
      };

      await save(manifest);

      return project(manifest, installation);
    });
  }

  async function inspect({ id }: { id: string }, signal?: AbortSignal) {
    return serialize(async () => {
      const installation = await initialize();

      return project(
        await inspectUnlocked(await load(id), installation, signal),
        installation,
      );
    });
  }

  async function list(_input: null = null, signal?: AbortSignal) {
    const installation = await initialize();
    const result: ManagedAllocation[] = [];
    const started = Date.now();
    let bytes = 0;
    const directory = await fs.opendir(manifestsRoot);

    for await (const entry of directory) {
      signal?.throwIfAborted();

      if (!entry.name.endsWith(".json")) continue;

      if (result.length >= 2000 || Date.now() - started > 2000)
        throw new Error(
          "The complete allocation list exceeded its metadata bound; no partial list is returned. Individual allocation inspection remains available.",
        );

      const allocation = project(
        await load(entry.name.slice(0, -5)),
        installation,
      );

      bytes += Buffer.byteLength(JSON.stringify(allocation));

      if (bytes > 4 * 1024 * 1024)
        throw new Error(
          "The complete allocation list exceeded its response bound; no partial list is returned. Individual allocation inspection remains available.",
        );
      result.push(allocation);
    }

    return result.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }

  async function ownerDecision(raw: ManagedHostDecision, signal?: AbortSignal) {
    const input = managedHostDecisionSchema.parse(raw);

    return serialize(async () => {
      const installation = await initialize();
      const manifest = await load(input.id);
      exact(manifest, input);
      signal?.throwIfAborted();

      if (manifest.phase.kind === "removed")
        throw new Error("The allocation has already been removed.");
      const decision = input.decision;

      if (
        decision.action !== "consumer-release" &&
        input.actorThreadId !== manifest.ownerThreadId
      )
        throw new Error(
          "Only the trusted allocation owner can make this decision.",
        );

      if (decision.action === "consumer-release") {
        const consumer = manifest.consumers.find(
          (value) => value.threadId === input.actorThreadId,
        );

        if (!consumer)
          throw new Error("The trusted actor is not a declared consumer.");
        consumer.releasedAt = now();
      } else if (decision.action === "consumer-register") {
        if (decision.consumerThreadId === manifest.ownerThreadId)
          throw new Error("The owner cannot register itself as a consumer.");

        const consumer = manifest.consumers.find(
          (value) => value.threadId === decision.consumerThreadId,
        );

        if (consumer) consumer.releasedAt = null;
        else
          manifest.consumers.push({
            threadId: decision.consumerThreadId,
            releasedAt: null,
          });

        if (manifest.phase.kind !== "allocated") revoke(manifest);
      } else if (decision.action === "budget-extend") {
        if (manifest.storage === null)
          throw new Error(
            "A missing legacy storage declaration cannot be replaced with an inferred budget.",
          );

        if (decision.budgetBytes <= manifest.storage.budgetBytes)
          throw new Error(
            "A budget extension must increase the existing finite budget.",
          );
        await assertStorageAdmission({
          directory: currentPath(manifest, installation),
          expectedBytes: decision.budgetBytes - manifest.storage.budgetBytes,
          minimumFreeBytes: manifest.storage.minimumFreeBytes,
        });
        signal?.throwIfAborted();
        manifest.storage.budgetBytes = decision.budgetBytes;
        revoke(manifest);
        manifest.reason = decision.reason;
      } else if (
        decision.action === "keep" ||
        decision.action === "reuse" ||
        decision.action === "owner-unarchived"
      ) {
        if (decision.action !== "reuse" || manifest.phase.kind !== "allocated")
          revoke(manifest);

        if (decision.action === "keep")
          manifest.disposition = "keep-until-released";
        manifest.reason =
          "reason" in decision
            ? decision.reason
            : "The owner resumed; its prior cleanup grant is revoked.";
      } else {
        if (
          decision.action === "owner-ended" &&
          manifest.disposition !== "disposable-when-owner-ends"
        )
          throw new Error(
            "This allocation was intentionally kept until a native owner release.",
          );

        if (manifest.phase.kind.endsWith("-intent"))
          throw new Error(
            "Reconcile the interrupted physical transition before granting release.",
          );
        const observed = await fresh(manifest, installation, signal);
        assertDeclaration(manifest, observed);

        if (decision.action === "release") {
          const container = paths(manifest, installation).container;

          for (const output of decision.closeout.retainedOutputs) {
            if (
              path.resolve(output.path) !== output.path ||
              output.path === container ||
              output.path.startsWith(`${container}${path.sep}`) ||
              (await fs.realpath(output.path)) !== output.path
            )
              throw new Error(
                "Retained outputs must already live outside the disposable allocation.",
              );
            const keeper = await fs.lstat(output.path);

            if (!keeper.isFile() && !keeper.isDirectory())
              throw new Error(
                "A retained output must be an existing physical file or directory.",
              );
          }

          manifest.closeout = decision.closeout;
        }

        if (
          phaseCapture(manifest)?.snapshot.digest !== observed.snapshot.digest
        )
          throw new Error(
            "The allocation changed; inspect it before granting release.",
          );

        const grant = {
          kind:
            decision.action === "release" ? "native-release" : "owner-ended",
          at: now(),
        } satisfies z.infer<typeof managedGrantSchema>;

        if (manifest.phase.kind === "quarantined")
          manifest.phase = {
            ...manifest.phase,
            capture: observed,
            authority: { kind: "granted", grant, reviewedAt: null },
          };
        else manifest.phase = { kind: "proposed", capture: observed, grant };
        manifest.reason =
          "reason" in decision
            ? decision.reason
            : "The disposable allocation owner ended authoritatively.";
      }

      manifest.revision++;
      manifest.hold = platformHold();
      await save(manifest);

      return project(manifest, installation);
    });
  }

  async function review(input: Exact, signal?: AbortSignal) {
    return serialize(async () => {
      const installation = await initialize();
      const manifest = await load(input.id);
      exact(manifest, input);

      if (
        manifest.phase.kind !== "proposed" &&
        manifest.phase.kind !== "quarantined"
      )
        throw new Error(
          "Review requires a current native owner release proposal.",
        );
      const authority = phaseAuthority(manifest);

      if (authority.grant === null)
        throw new Error("Review cannot replace a missing native owner grant.");
      const observed = await fresh(manifest, installation, signal);
      assertDeclaration(manifest, observed);

      if (observed.snapshot.digest !== manifest.phase.capture.snapshot.digest)
        throw new Error("The allocation changed; its release must be renewed.");

      const reviewed = {
        kind: "granted",
        grant: authority.grant,
        reviewedAt: now(),
      } satisfies z.infer<typeof authoritySchema>;

      manifest.phase =
        manifest.phase.kind === "quarantined"
          ? { ...manifest.phase, capture: observed, authority: reviewed }
          : { kind: "approved", capture: observed, authority: reviewed };
      manifest.revision++;
      manifest.hold = platformHold();
      await save(manifest);

      return project(manifest, installation);
    });
  }

  async function assertUnlinkParents(
    manifest: Manifest,
    installation: Installation,
    target: string,
    entries: Entry[],
    relative: string,
  ) {
    await validateParents(manifest, installation);

    const ancestors = [
      "",
      ...relative
        .split(path.sep)
        .slice(0, -1)
        .map((_, index, array) => array.slice(0, index + 1).join(path.sep)),
    ];

    for (const ancestor of ancestors) {
      const expected = entries.find((value) => value.relative === ancestor);

      if (!expected || expected.kind !== "directory")
        throw new Held(
          "path-identity",
          "A purge ancestor was not in the admitted snapshot.",
        );

      const actual = await fs.lstat(
        ancestor ? path.join(target, ancestor) : target,
        { bigint: true },
      );

      if (
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        !sameIdentity(identity(actual), expected)
      )
        throw new Held("path-identity", "A purge ancestor changed identity.");
    }
  }

  async function transition(raw: ManagedHostTransition, signal?: AbortSignal) {
    const input = managedHostTransitionSchema.parse(raw);

    return serialize(async () => {
      const installation = await initialize();
      const manifest = await load(input.id);
      exact(manifest, input);

      if (manifest.phase.kind === "removed")
        return project(manifest, installation);

      if (manifest.phase.kind.endsWith("-intent"))
        throw new Error(
          "The interrupted physical transition must be reconciled; it cannot be replayed.",
        );

      try {
        await validateParents(manifest, installation);
        const current = paths(manifest, installation);
        const observed = await fresh(manifest, installation, signal);
        const previous = phaseCapture(manifest);

        if (!previous || previous.snapshot.digest !== observed.snapshot.digest)
          throw new Held(
            "snapshot-changed",
            "The allocation changed; its cleanup grant must be renewed.",
          );

        if (input.action === "restore") {
          if (manifest.phase.kind !== "quarantined")
            throw new Held(
              "phase",
              "Only a quarantined allocation can be restored.",
            );

          if (await statOrNull(current.payload))
            throw new Held(
              "restore-collision",
              "The original allocation path already exists; restore never overwrites it.",
            );
          await assertIdle(current.quarantine, signal);
          manifest.phase = {
            kind: "restore-intent",
            capture: observed,
            quarantinedAt: manifest.phase.quarantinedAt,
            intentAt: now(),
          };
          manifest.revision++;
          manifest.hold = platformHold();
          await save(manifest);
          await options.fault?.("after-intent", manifest.id);
          signal?.throwIfAborted();
          await validateParents(manifest, installation);

          if (await statOrNull(current.payload))
            throw new Held(
              "restore-collision",
              "The original allocation path already exists; restore never overwrites it.",
            );
          const latest = await capture(current.quarantine, signal);

          if (latest.snapshot.digest !== observed.snapshot.digest)
            throw new Held(
              "snapshot-changed",
              "The quarantined allocation changed before restore.",
            );
          await assertNoMounts(current.quarantine, signal);
          await fs.rename(current.quarantine, current.payload);
          await syncDirectory(current.container);
          await options.fault?.("after-rename", manifest.id);
          const restored = await capture(current.payload, signal);

          if (!sameAfterRename(observed, restored))
            throw new Held(
              "snapshot-changed",
              "The allocation changed during restore; its bytes remain held.",
            );
          manifest.phase = { kind: "kept", capture: restored };
          manifest.reason =
            "The allocation was restored; prior cleanup permission is revoked.";
        } else {
          assertDeclaration(manifest, observed);
          assertConsumers(manifest, input.settledConsumerThreadIds);
          const authority = phaseAuthority(manifest);

          if (authority.grant === null || authority.reviewedAt === null)
            throw new Held(
              "owner-grant",
              "Physical cleanup requires a current native owner grant and administrative review.",
            );
          await assertIdle(currentPath(manifest, installation), signal);

          if (input.action === "quarantine") {
            if (manifest.phase.kind !== "approved")
              throw new Held(
                "phase",
                "Only an approved allocation can enter quarantine.",
              );

            if (await statOrNull(current.quarantine))
              throw new Held(
                "quarantine-collision",
                "The quarantine path is already occupied.",
              );

            const granted = {
              kind: "granted",
              grant: authority.grant,
              reviewedAt: authority.reviewedAt,
            } satisfies z.infer<typeof authoritySchema>;

            manifest.phase = {
              kind: "quarantine-intent",
              capture: observed,
              authority: granted,
              intentAt: now(),
            };
            manifest.revision++;
            manifest.hold = platformHold();
            await save(manifest);
            await options.fault?.("after-intent", manifest.id);
            signal?.throwIfAborted();
            await validateParents(manifest, installation);
            const latest = await capture(current.payload, signal);

            if (latest.snapshot.digest !== observed.snapshot.digest)
              throw new Held(
                "snapshot-changed",
                "The allocation changed before quarantine.",
              );

            if (await statOrNull(current.quarantine))
              throw new Held(
                "quarantine-collision",
                "The quarantine path is already occupied.",
              );
            await assertNoMounts(current.payload, signal);
            await fs.rename(current.payload, current.quarantine);
            await syncDirectory(current.container);
            await options.fault?.("after-rename", manifest.id);
            const quarantined = await capture(current.quarantine, signal);

            if (!sameAfterRename(observed, quarantined))
              throw new Held(
                "snapshot-changed",
                "The allocation changed during quarantine; its bytes remain held.",
              );
            manifest.phase = {
              kind: "quarantined",
              capture: quarantined,
              authority: granted,
              quarantinedAt: now(),
            };
            await assertIdle(current.quarantine, signal);
          } else {
            if (manifest.phase.kind !== "quarantined")
              throw new Held(
                "phase",
                "Only a quarantined allocation can be permanently removed.",
              );

            const floor =
              Math.max(
                manifest.phase.quarantinedAt,
                input.expiryEnabledAt ?? 0,
              ) + MANAGED_HOLDING_MS;

            if (now() < floor)
              throw new Held(
                "holding-period",
                "The fixed seven-day restore period has not elapsed.",
              );
            manifest.phase = {
              kind: "purge-intent",
              capture: observed,
              authority: {
                kind: "granted",
                grant: authority.grant,
                reviewedAt: authority.reviewedAt,
              },
              quarantinedAt: manifest.phase.quarantinedAt,
              intentAt: now(),
            };
            manifest.revision++;
            manifest.hold = platformHold();
            await save(manifest);
            await options.fault?.("after-intent", manifest.id);
            signal?.throwIfAborted();

            await assertNoMounts(current.quarantine, signal);

            const unlinkedInodes = new Set<string>();

            for (const expected of [...observed.entries].sort(
              (left, right) =>
                right.relative.split(path.sep).length -
                  left.relative.split(path.sep).length ||
                right.relative.localeCompare(left.relative),
            )) {
              signal?.throwIfAborted();
              await options.fault?.("before-unlink", manifest.id);
              await assertUnlinkParents(
                manifest,
                installation,
                current.quarantine,
                observed.entries,
                expected.relative,
              );

              const target = expected.relative
                ? path.join(current.quarantine, expected.relative)
                : current.quarantine;

              const actual = await entry(
                target,
                expected.relative,
                expected.dev,
              );

              const actualComparable =
                actual.kind === "directory"
                  ? {
                      ...actual,
                      ctimeNs: "purging",
                      mtimeNs: "purging",
                      nlink: "purging",
                      size: "purging",
                    }
                  : unlinkedInodes.has(`${expected.dev}:${expected.ino}`)
                    ? {
                        ...actual,
                        ctimeNs: "unlinked-alias",
                        nlink: "unlinked-alias",
                      }
                    : actual;

              const expectedComparable =
                expected.kind === "directory"
                  ? {
                      ...expected,
                      ctimeNs: "purging",
                      mtimeNs: "purging",
                      nlink: "purging",
                      size: "purging",
                    }
                  : unlinkedInodes.has(`${expected.dev}:${expected.ino}`)
                    ? {
                        ...expected,
                        ctimeNs: "unlinked-alias",
                        nlink: "unlinked-alias",
                      }
                    : expected;

              if (
                JSON.stringify(actualComparable) !==
                JSON.stringify(expectedComparable)
              )
                throw new Held(
                  "snapshot-changed",
                  "A purge entry changed identity; remaining bytes are held.",
                );

              if (mounts.recheck === "per-unlink")
                await assertNoMounts(current.quarantine, signal);

              if (expected.kind === "directory") await fs.rmdir(target);
              else {
                await fs.unlink(target);
                unlinkedInodes.add(`${expected.dev}:${expected.ino}`);
              }

              await options.fault?.("after-unlink", manifest.id);
            }

            await syncDirectory(current.container);
            manifest.phase = {
              kind: "removed",
              removedLogicalBytes: observed.snapshot.logicalBytes,
              removedAt: now(),
            };
          }
        }

        manifest.revision++;
        manifest.hold = platformHold();
        await save(manifest);
      } catch (error) {
        hold(manifest, error);
        await save(manifest);
      }

      return project(manifest, installation);
    });
  }

  async function reconcileOne(
    manifest: Manifest,
    installation: Installation,
    signal?: AbortSignal,
  ) {
    try {
      await validateParents(manifest, installation);
      const current = paths(manifest, installation);
      const phase = manifest.phase;

      if (phase.kind === "purge-intent") {
        throw new Held(
          "partial-purge",
          "A permanent-removal intent was interrupted. Remaining bytes are held; deletion is never automatically replayed.",
        );
      }

      if (
        phase.kind === "quarantine-intent" ||
        phase.kind === "restore-intent"
      ) {
        const payload = await statOrNull(current.payload);
        const quarantined = await statOrNull(current.quarantine);

        if (Boolean(payload) === Boolean(quarantined))
          throw new Held(
            "ambiguous-transition",
            "The interrupted transition has ambiguous physical paths; no effect will be replayed.",
          );
        const target = payload ? current.payload : current.quarantine;
        const observed = await capture(target, signal);

        if (!sameAfterRename(phase.capture, observed))
          throw new Held(
            "snapshot-changed",
            "The interrupted transition no longer matches its recorded exact tree.",
          );

        if (phase.kind === "quarantine-intent") {
          if (payload) {
            manifest.phase =
              phase.authority.kind === "granted"
                ? {
                    kind: "approved",
                    capture: observed,
                    authority: phase.authority,
                  }
                : { kind: "kept", capture: observed };
          } else
            manifest.phase = {
              kind: "quarantined",
              capture: observed,
              authority: phase.authority,
              quarantinedAt: Math.max(phase.intentAt, now()),
            };
        } else
          manifest.phase = payload
            ? { kind: "kept", capture: observed }
            : {
                kind: "quarantined",
                capture: observed,
                authority: { kind: "revoked" },
                quarantinedAt: phase.quarantinedAt,
              };
        manifest.revision++;
        manifest.hold = platformHold();
        await save(manifest);
      }
    } catch (error) {
      hold(manifest, error);
      await save(manifest);
    }

    return manifest;
  }

  async function reconcile(
    { id }: { id: string | null },
    signal?: AbortSignal,
  ) {
    const ids =
      id === null
        ? (await fs.readdir(manifestsRoot))
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -5))
        : [managedIdSchema.parse(id)];

    const result = [];

    for (const value of ids)
      result.push(
        await serialize(async () => {
          const installation = await initialize();

          return project(
            await reconcileOne(await load(value), installation, signal),
            installation,
          );
        }),
      );

    return result;
  }

  async function reanchor(
    { previewDigest }: { previewDigest: string | null },
    signal?: AbortSignal,
  ) {
    return serialize(async () => {
      const started = Date.now();
      const installation = await initialize();
      const root = rootFor(installation);

      const expected = [
        home,
        path.join(home, "scratch"),
        path.join(home, "scratch", "omnyo"),
        root,
      ];

      if (installation.anchors.length !== expected.length)
        throw new Error("The managed namespace anchors are incomplete.");
      const anchors = [];

      for (const [index, target] of expected.entries()) {
        const previous = installation.anchors[index];
        const current = await directoryIdentity(target);

        if (previous?.path !== target || previous.identity.ino !== current.ino)
          throw new Error(
            "The managed namespace path or inode changed; reanchoring is refused.",
          );
        anchors.push({ path: target, identity: current });
      }

      const markerPath = path.join(root, ".managed-cleanup.json");
      const markerStat = await fs.lstat(markerPath);

      if (!markerStat.isFile() || markerStat.isSymbolicLink())
        throw new Error(
          "The managed namespace marker is not an ordinary file.",
        );

      const marker = z
        .object({ version: z.literal(1), installationId: managedIdSchema })
        .strict()
        .parse(JSON.parse(await fs.readFile(markerPath, "utf8")));

      if (marker.installationId !== installation.id)
        throw new Error("The managed namespace marker changed.");
      await assertNoMounts(root, signal);
      await assertIdle(root, signal);

      const names = (await fs.readdir(manifestsRoot))
        .filter((name) => name.endsWith(".json"))
        .sort();

      if (names.length > 2000)
        throw new Error(
          "The complete allocation list exceeded its metadata bound.",
        );
      const selected = [];

      for (const name of names) {
        signal?.throwIfAborted();

        if (Date.now() - started > 10000)
          throw new Error("The namespace preview exceeded its time bound.");
        const manifest = await load(name.slice(0, -5));

        if (
          manifest.phase.kind !== "allocated" &&
          manifest.phase.kind !== "kept"
        )
          throw new Error(
            "Reanchoring requires every allocation to be kept or allocated; active cleanup states remain held.",
          );
        assertConsumers(manifest, []);
        const current = paths(manifest, installation);
        const ownerIdentity = await directoryIdentity(current.owner);
        const containerIdentity = await directoryIdentity(current.container);
        const payloadIdentity = await directoryIdentity(current.payload);

        if (
          ownerIdentity.ino !== manifest.ownerIdentity.ino ||
          containerIdentity.ino !== manifest.containerIdentity.ino ||
          payloadIdentity.ino !== manifest.payloadIdentity.ino
        )
          throw new Error(
            "An allocation inode changed; reanchoring is refused.",
          );
        const observed = await capture(current.payload, signal);
        selected.push({
          manifest,
          ownerIdentity,
          containerIdentity,
          payloadIdentity,
          observed,
        });
      }

      const selectedDigest = digest({
        installation,
        anchors,
        marker,
        allocations: selected.map(
          ({
            manifest,
            ownerIdentity,
            containerIdentity,
            payloadIdentity,
            observed,
          }) => ({
            manifest,
            ownerIdentity,
            containerIdentity,
            payloadIdentity,
            entries: observed.entries,
          }),
        ),
      });

      if (previewDigest === null)
        return {
          digest: selectedDigest,
          allocationCount: selected.length,
          applied: false,
        };

      if (previewDigest !== selectedDigest)
        throw new Error(
          "The managed namespace changed. Preview reanchoring again.",
        );
      await assertIdle(root, signal);

      for (const item of selected) {
        signal?.throwIfAborted();

        if (
          (await capture(paths(item.manifest, installation).payload, signal))
            .snapshot.digest !== item.observed.snapshot.digest
        )
          throw new Error(
            "An allocation changed before reanchoring; remaining identities are held.",
          );
        item.manifest.ownerIdentity = item.ownerIdentity;
        item.manifest.containerIdentity = item.containerIdentity;
        item.manifest.payloadIdentity = item.payloadIdentity;
        item.manifest.phase = { kind: "kept", capture: null };
        item.manifest.closeout = null;
        item.manifest.reason =
          "Namespace identity explicitly reanchored; previous cleanup permission is revoked.";
        item.manifest.hold = platformHold();
        item.manifest.revision++;
        await save(item.manifest);
      }

      const updated = { ...installation, anchors };
      await atomicWrite(path.join(stateRoot, "installation.json"), updated);
      initialization = Promise.resolve(updated);

      return {
        digest: selectedDigest,
        allocationCount: selected.length,
        applied: true,
      };
    });
  }

  return {
    managedReanchor: reanchor,
    managedAllocate: allocate,
    managedInspect: inspect,
    managedList: (_input: null = null, signal?: AbortSignal) =>
      serialize(() => list(_input, signal)),
    managedOwnerDecision: ownerDecision,
    managedReview: review,
    managedTransition: transition,
    managedReconcile: reconcile,
  };
}

export type ManagedHost = ReturnType<typeof createManagedHost>;
