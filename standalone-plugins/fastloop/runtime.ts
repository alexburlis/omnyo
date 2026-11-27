import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  copyFile,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { experimental_readProcessIdentity } from "@omnyo/plugin-sdk/host";
import { packageArchiveBase64, runtimeMetadata } from "./generated/runtime-payload.js";
import {
  PayloadError,
  runtimeLockSchema,
  runtimeManifestSchema,
  sha256,
  validateRuntimePackage,
  type RuntimeManifest,
} from "./package-payload.js";

const metadata = z
  .strictObject({ lock: runtimeLockSchema, manifest: runtimeManifestSchema })
  .parse(runtimeMetadata);

import currentLock from "./runtime.lock.json";
import { SdkBridge } from "./bridge.js";

if (JSON.stringify(runtimeLockSchema.parse(currentLock)) !== JSON.stringify(metadata.lock))
  throw new PayloadError("RUNTIME_PREPARATION_STALE");

const archive = Buffer.from(packageArchiveBase64, "base64");

const validated = validateRuntimePackage({
  archive,
  expectedSha256: metadata.lock.packageSha256,
  lock: metadata.lock,
});

const setupSchema = z.strictObject({
  nodeExecutable: z.string().min(1),
  nativeBinaryPath: z.string().min(1).optional(),
  nativeLicensePaths: z.array(z.string().min(1)).max(64).optional(),
});

const recordSchema = z.strictObject({
  schema: z.literal(1),
  packageSha256: z.string(),
  nodeExecutable: z.string(),
  nodeVersion: z.string(),
  nativeRelativePath: z
    .string()
    .refine(
      (value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
      "Invalid native path",
    )
    .nullable(),
  licenses: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
});

const lockSchema = z.strictObject({
  pid: z.number().int().positive(),
  commandHash: z.string(),
  startedAt: z.number(),
  token: z.string(),
});

const probeSchema = z.strictObject({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  sqlite: z.literal(true),
});

const doctorSchema = z.object({
  node: z.string(),
  qualifiedPlatform: z.boolean(),
  status: z.string(),
  nativeBinaryPresent: z.boolean(),
  nativeBinarySha256: z.string().nullable(),
  missing: z.array(z.string()),
  browserPresent: z.boolean(),
  providerConfigured: z.boolean(),
  plannerConfigured: z.boolean(),
});

const serviceProbeSchema = z.strictObject({
  connected: z.literal(true),
  closed: z.literal(true),
  dataRootRemoved: z.boolean(),
  node: z.string(),
});

export async function atomicJSON(
  path: string,
  data: z.infer<ReturnType<typeof z.json>>,
): Promise<void> {
  const temporary = `${path}.pending-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try {
      await file.writeFile(JSON.stringify(data));
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function contained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);

  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

export async function noSymlinkDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);

  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PayloadError("RUNTIME_DIRECTORY_UNSAFE");
}

async function boundedText(
  executable: string,
  args: string[],
  context: { cwd: string; signal: AbortSignal; timeoutMs?: number },
): Promise<{ stdout: string; exitCode: number }> {
  context.signal.throwIfAborted();

  if (!isAbsolute(executable)) throw new PayloadError("RUNTIME_EXECUTABLE_NOT_ABSOLUTE");

  return new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      cwd: context.cwd,
      env: {
        HOME: homedir(),
        PATH: `${dirname(executable)}${process.platform === "win32" ? ";" : ":"}${process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"}`,
        TMPDIR: process.env.TMPDIR,
        USER: process.env.USER,
        LANG: "en_US.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal: context.signal,
      windowsHide: true,
      shell: false,
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;

    const timeout = setTimeout(() => {
      exceeded = true;
      child.kill("SIGKILL");
    }, context.timeoutMs ?? 8000);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > 262144) {
        exceeded = true;
        child.kill("SIGTERM");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timeout);
      reject(
        new PayloadError(
          context.signal.aborted ? "RUNTIME_REQUEST_CANCELLED" : "RUNTIME_PROCESS_FAILED",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);

      if (exceeded) reject(new PayloadError("RUNTIME_PROCESS_BOUND_EXCEEDED"));
      else accept({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 1 });
    });
  });
}

async function nodeProbe(executable: string, cwd: string, signal: AbortSignal) {
  const canonical = await realpath(executable).catch(() => {
    throw new PayloadError("NODE_RUNTIME_UNAVAILABLE");
  });

  const result = await boundedText(
    canonical,
    [
      "--input-type=module",
      "-e",
      'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE capability(id INTEGER)"); db.close(); process.stdout.write(JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch,sqlite:true}));',
    ],
    { cwd, signal },
  );

  if (result.exitCode !== 0) throw new PayloadError("NODE_RUNTIME_UNAVAILABLE");
  const probe = probeSchema.parse(JSON.parse(result.stdout));

  if (
    !probe.node.startsWith("24.") ||
    !metadata.manifest.qualifiedPlatforms.some(
      (target) => target.platform === probe.platform && target.arch === probe.arch,
    )
  )
    throw new PayloadError("NODE_RUNTIME_UNAVAILABLE");

  return { ...probe, executable: canonical };
}

export class HostRuntime {
  readonly root: string;
  readonly packageRoot: string;
  private active = 0;
  constructor(readonly dataDir: string) {
    this.root = join(realpathSync(dataDir), "runtime", metadata.lock.packageSha256);
    this.packageRoot = join(this.root, "package");
  }
  get identity() {
    return {
      packageSha256: metadata.lock.packageSha256,
      manifestSha256: metadata.lock.manifestSha256,
      packageVersion: metadata.manifest.packageVersion,
      protocolVersion: metadata.manifest.protocolVersion,
      adapterNode: process.versions.node,
      qualifiedPlatforms: metadata.manifest.qualifiedPlatforms,
    };
  }

  private async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted();
    const directory = join(this.dataDir, "runtime");
    await noSymlinkDirectory(directory);
    const path = join(directory, `${metadata.lock.packageSha256}.lock`);
    const identity = await experimental_readProcessIdentity(process.pid);

    if (!identity?.command || identity.startedAt === null)
      throw new PayloadError("RUNTIME_OWNER_UNCERTAIN");

    const owner = {
      pid: process.pid,
      commandHash: sha256(Buffer.from(identity.command)),
      startedAt: identity.startedAt,
      token: randomUUID(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const file = await open(path, "wx", 0o600);

        try {
          await file.writeFile(JSON.stringify(owner));
          await file.sync();
        } finally {
          await file.close();
        }

        return async () => {
          const current = lockSchema.parse(JSON.parse(await readFile(path, "utf8")));

          if (current.token !== owner.token) throw new PayloadError("RUNTIME_LOCK_OWNER_CHANGED");
          await rm(path);
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const previousBytes = await readFile(path);
        const previous = lockSchema.parse(JSON.parse(previousBytes.toString("utf8")));
        const actual = await experimental_readProcessIdentity(previous.pid);
        let gone = false;

        try {
          process.kill(previous.pid, 0);
        } catch (status) {
          gone = status instanceof Error && "code" in status && status.code === "ESRCH";
        }

        const different =
          actual?.command &&
          actual.startedAt !== null &&
          (sha256(Buffer.from(actual.command)) !== previous.commandHash ||
            Math.abs(actual.startedAt - previous.startedAt) > 2500);

        if (!gone && !different)
          throw new PayloadError(actual ? "RUNTIME_SETUP_BUSY" : "RUNTIME_OWNER_UNCERTAIN");

        if (!previousBytes.equals(await readFile(path)))
          throw new PayloadError("RUNTIME_LOCK_OWNER_CHANGED");
        await rm(path);
      }
    }

    throw new PayloadError("RUNTIME_SETUP_BUSY");
  }
  async assertMaterialized(): Promise<void> {
    const root = await realpath(this.packageRoot).catch(() => {
      throw new PayloadError("RUNTIME_SETUP_REQUIRED");
    });

    if (root !== this.packageRoot) throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");
    const allowed = new Set(metadata.manifest.files.map((file) => file.path));
    allowed.add("runtime-manifest.json");
    let record: z.infer<typeof recordSchema> | undefined;

    try {
      record = recordSchema.parse(
        JSON.parse(await readFile(join(this.root, "setup.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    if (record?.nativeRelativePath) {
      if (
        !contained(
          this.packageRoot,
          await realpath(join(this.packageRoot, record.nativeRelativePath)),
        )
      )
        throw new PayloadError("RUNTIME_NATIVE_PATH_INVALID");
      allowed.add(record.nativeRelativePath);
    }

    for (let offset = 0; offset < metadata.manifest.files.length; offset += 32) {
      await Promise.all(
        metadata.manifest.files.slice(offset, offset + 32).map(async (file) => {
          const target = resolve(this.packageRoot, file.path);

          if (!contained(this.packageRoot, target))
            throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");

          const stat = await lstat(target).catch(() => {
            throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");
          });

          if ("link" in file) {
            if (
              !stat.isSymbolicLink() ||
              (await readlink(target)) !== file.link ||
              !contained(root, await realpath(target))
            )
              throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");
          } else if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size !== file.bytes ||
            (stat.mode & 0o777) !== file.mode ||
            sha256(await readFile(target)) !== file.sha256
          )
            throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");
        }),
      );
    }

    if (
      sha256(await readFile(join(this.packageRoot, "runtime-manifest.json"))) !==
      metadata.lock.manifestSha256
    )
      throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");

    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);

        if (entry.isDirectory()) await inspect(absolute);
        else if (!allowed.has(relative(this.packageRoot, absolute).split(sep).join("/")))
          throw new PayloadError("RUNTIME_MATERIALIZATION_ALTERED");
      }
    };

    await inspect(this.packageRoot);

    if (
      record?.nativeRelativePath &&
      sha256(await readFile(join(this.packageRoot, record.nativeRelativePath))) !==
        metadata.manifest.native.binarySha256
    )
      throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");

    if (record)
      for (const license of record.licenses)
        if (
          !contained(this.root, resolve(this.root, license.path)) ||
          !contained(this.root, await realpath(resolve(this.root, license.path))) ||
          sha256(await readFile(resolve(this.root, license.path))) !== license.sha256
        )
          throw new PayloadError("RUNTIME_LICENSE_ALTERED");
  }
  private async materialize(): Promise<void> {
    if (
      await lstat(this.root).then(
        () => true,
        () => false,
      )
    ) {
      await this.assertMaterialized();

      return;
    }

    const staging = join(this.dataDir, "runtime", `.stage-${randomUUID()}`);
    await noSymlinkDirectory(staging);

    try {
      const regular = [...validated.members.values()].filter(
        (member) => member.kind === "file" || member.kind === "directory",
      );

      for (let offset = 0; offset < regular.length; offset += 32)
        await Promise.all(
          regular.slice(offset, offset + 32).map(async (member) => {
            const target = join(staging, member.path);

            if (member.kind === "directory") {
              await mkdir(target, { recursive: true, mode: 0o700 });

              return;
            }

            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const file = await open(target, "wx", member.mode);

            try {
              await file.writeFile(member.data);
            } finally {
              await file.close();
            }

            await chmod(target, member.mode);
          }),
        );

      for (const member of validated.members.values()) {
        if (member.kind === "hardlink")
          throw new PayloadError("RUNTIME_HARDLINK_MATERIALIZATION_UNSUPPORTED");

        if (member.kind === "symlink") {
          const target = join(staging, member.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await symlink(member.link, target);
        }
      }

      await rename(staging, this.root);
      await this.assertMaterialized();
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async setup(input: z.infer<typeof setupSchema>, signal: AbortSignal) {
    const options = setupSchema.parse(input);

    if (this.active) throw new PayloadError("RUNTIME_SETUP_BUSY");
    const release = await this.acquire(signal);

    try {
      const node = await nodeProbe(options.nodeExecutable, this.dataDir, signal);
      await this.materialize();
      let prior: z.infer<typeof recordSchema> | undefined;

      try {
        prior = recordSchema.parse(
          JSON.parse(await readFile(join(this.root, "setup.json"), "utf8")),
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }

      const licenses = prior?.licenses ?? [];
      let nativeRelativePath = prior?.nativeRelativePath ?? null;

      if (options.nativeBinaryPath) {
        if (!isAbsolute(options.nativeBinaryPath) || !options.nativeLicensePaths?.length)
          throw new PayloadError("RUNTIME_NATIVE_LICENSE_REQUIRED");

        if (
          sha256(await readFile(options.nativeBinaryPath)) !== metadata.manifest.native.binarySha256
        )
          throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");

        const binaryDirectory = await realpath(
          join(this.packageRoot, "node_modules/agent-browser/bin"),
        );

        if (!contained(this.packageRoot, binaryDirectory))
          throw new PayloadError("RUNTIME_NATIVE_PATH_INVALID");
        const target = join(binaryDirectory, metadata.manifest.native.binaryName);
        const pending = `${target}.pending-${randomUUID()}`;

        try {
          await copyFile(options.nativeBinaryPath, pending, constants.COPYFILE_EXCL);
          await chmod(pending, 0o755);

          if (sha256(await readFile(pending)) !== metadata.manifest.native.binarySha256)
            throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");
          await rename(pending, target);
        } finally {
          await rm(pending, { force: true });
        }

        if (sha256(await readFile(target)) !== metadata.manifest.native.binarySha256)
          throw new PayloadError("RUNTIME_NATIVE_HASH_MISMATCH");
        nativeRelativePath = relative(this.packageRoot, target).split(sep).join("/");
        await noSymlinkDirectory(join(this.root, "native-licenses"));

        licenses.length = 0;
        const licenseSet = randomUUID();

        for (const [index, source] of options.nativeLicensePaths.entries()) {
          if (!isAbsolute(source)) throw new PayloadError("RUNTIME_NATIVE_LICENSE_REQUIRED");
          const bytes = await readFile(source);

          if (bytes.length > 4 * 1024 * 1024) throw new PayloadError("RUNTIME_LICENSE_TOO_LARGE");
          const path = `native-licenses/${licenseSet}-${index}.txt`;
          const file = await open(join(this.root, path), "wx", 0o600);

          try {
            await file.writeFile(bytes);
          } finally {
            await file.close();
          }

          licenses.push({ path, sha256: sha256(bytes) });
        }
      }

      await atomicJSON(join(this.root, "setup.json"), {
        schema: 1,
        packageSha256: metadata.lock.packageSha256,
        nodeExecutable: node.executable,
        nodeVersion: node.node,
        nativeRelativePath,
        licenses,
      });
      await this.assertMaterialized();

      return {
        ...this.identity,
        prepared: true,
        materialized: true,
        node24: node.node,
        nativeInstalled: nativeRelativePath !== null,
        installationScope: "plugin-owned runtime only",
      };
    } finally {
      await release();
    }
  }
  async doctor(projectRoot: string, options: { probeService?: boolean }, signal: AbortSignal) {
    await this.assertMaterialized();

    const record = recordSchema.parse(
      JSON.parse(await readFile(join(this.root, "setup.json"), "utf8")),
    );

    if (record.packageSha256 !== metadata.lock.packageSha256)
      throw new PayloadError("RUNTIME_LOCK_MISMATCH");
    const node = await nodeProbe(record.nodeExecutable, this.dataDir, signal);
    this.active += 1;

    try {
      const result = await boundedText(
        node.executable,
        [
          join(this.packageRoot, metadata.manifest.entries.cli),
          "doctor",
          "--project",
          projectRoot,
          "--json",
        ],
        { cwd: projectRoot, signal },
      );

      if (![0, 2].includes(result.exitCode)) throw new PayloadError("RUNTIME_ENGINE_DOCTOR_FAILED");
      const engine = doctorSchema.parse(JSON.parse(result.stdout));
      let serviceProbe: z.infer<typeof serviceProbeSchema> | null = null;

      if (options.probeService) {
        const probeData = join(this.dataDir, "probes", randomUUID());
        await noSymlinkDirectory(dirname(probeData));

        const source =
          'import {pathToFileURL} from "node:url"; import {existsSync} from "node:fs"; import {rm} from "node:fs/promises"; const {createClient}=await import(pathToFileURL(process.argv[1]).href);const client=await createClient({projectRoot:process.argv[2],dataRoot:process.argv[3],ephemeral:true});try{process.stdout.write("");}finally{await client.close();await rm(process.argv[3],{recursive:true});}process.stdout.write(JSON.stringify({connected:true,closed:true,dataRootRemoved:!existsSync(process.argv[3]),node:process.versions.node}));';

        const probe = await boundedText(
          node.executable,
          [
            "--input-type=module",
            "-e",
            source,
            join(this.packageRoot, metadata.manifest.entries.sdk),
            projectRoot,
            probeData,
          ],
          { cwd: projectRoot, signal },
        );

        if (probe.exitCode !== 0) throw new PayloadError("RUNTIME_SERVICE_PROBE_FAILED");
        serviceProbe = serviceProbeSchema.parse(JSON.parse(probe.stdout));

        if (!serviceProbe.dataRootRemoved)
          throw new PayloadError("RUNTIME_PROBE_CLEANUP_INCOMPLETE");
      }

      return {
        ...this.identity,
        prepared: true,
        materialized: true,
        engine,
        serviceProbe,
        limitations: [
          "Browser admission requires the owning Omnyo server thread lifecycle; setup and doctor create no browser jobs.",
        ],
      };
    } finally {
      this.active -= 1;
    }
  }
  async openBridge(options: {
    projectRoot: string;
    clientId: string;
    dataRoot?: string;
    archive?: boolean;
    onExit(): void;
  }): Promise<SdkBridge> {
    await this.assertMaterialized();

    const record = recordSchema.parse(
      JSON.parse(await readFile(join(this.root, "setup.json"), "utf8")),
    );

    const node = await nodeProbe(record.nodeExecutable, this.dataDir, AbortSignal.timeout(8000));
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      options.onExit();
    };

    this.active += 1;

    try {
      return await SdkBridge.connect({
        nodeExecutable: node.executable,
        sdkPath: join(this.packageRoot, metadata.manifest.entries.sdk),
        projectRoot: options.projectRoot,
        dataRoot: options.dataRoot,
        archive: options.archive,
        clientId: options.clientId,
        onExit: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
  async status() {
    try {
      await this.assertMaterialized();

      return {
        ...this.identity,
        prepared: true,
        materialized: true,
        browserAdmission: "requires_server_ownership",
      };
    } catch (error) {
      return {
        ...this.identity,
        prepared: true,
        materialized: false,
        code: error instanceof PayloadError ? error.code : "RUNTIME_SETUP_REQUIRED",
        browserAdmission: "requires_server_ownership",
      };
    }
  }
}

export const embeddedRuntimeManifest: RuntimeManifest = metadata.manifest;
