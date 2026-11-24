import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  parseHostArtifactSignatureRecord,
  type HostArtifactSignatureRecord,
  type HostArtifactSignatureSubject,
} from "@omnyo/host-daemon-contract/host-artifact-signature";
import { resolveBundledNpmCli } from "@omnyo/plugin-build";
import { omitNpmScriptPolicyEnv } from "@omnyo/process-utils";

const execFileAsync = promisify(execFile);

const preparedArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
  })
  .strict();

export interface OmnyoAppArtifact {
  digest: string;
  path: string;
  size: number;
}

export interface OmnyoAppArtifactService {
  getArtifact(): Promise<OmnyoAppArtifact>;
  getVersion(): Promise<string>;
}

export interface HostArtifactSignatureReader {
  read(
    subject: HostArtifactSignatureSubject,
  ): Promise<HostArtifactSignatureRecord | null>;
}

interface HostArtifactSignatureLogger {
  warn(context: object, message: string): void;
}

export interface OmnyoAppArtifactCommandRunner {
  (command: string, args: readonly string[], cwd: string): Promise<string>;
}

interface CreateOmnyoAppArtifactServiceOptions {
  dataDir: string;
  commandRunner?: OmnyoAppArtifactCommandRunner;
  protocolVersion?: number;
  serverEntryUrl: string;
}

interface OmnyoAppPackageJson {
  dependencies: Record<string, string>;
  engines: { node: string };
  name: "omnyo-app";
  os: string[];
  version: string;
}

export async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const npmCliPath = command === "npm" ? resolveBundledNpmCli() : null;

  const result = await execFileAsync(
    npmCliPath === null ? command : process.execPath,
    npmCliPath === null ? [...args] : [npmCliPath, ...args],
    {
      cwd,
      env: omitNpmScriptPolicyEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return result.stdout;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function readOmnyoAppPackageJson(
  packageRoot: string,
): Promise<OmnyoAppPackageJson> {
  const parsed: unknown = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("name" in parsed) ||
    parsed.name !== "omnyo-app" ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !("dependencies" in parsed) ||
    !isStringRecord(parsed.dependencies) ||
    !("engines" in parsed) ||
    parsed.engines === null ||
    typeof parsed.engines !== "object" ||
    !("node" in parsed.engines) ||
    typeof parsed.engines.node !== "string" ||
    !("os" in parsed) ||
    !Array.isArray(parsed.os) ||
    !parsed.os.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Expected an omnyo-app package at ${packageRoot}`);
  }

  return {
    dependencies: parsed.dependencies,
    engines: { node: parsed.engines.node },
    name: parsed.name,
    os: parsed.os,
    version: parsed.version,
  };
}

interface ResolvedOmnyoAppPackage {
  layout: "packaged" | "repo";
  packageJson: OmnyoAppPackageJson;
  root: string;
}

export async function resolveOmnyoAppPackage(
  serverEntryUrl: string,
): Promise<ResolvedOmnyoAppPackage> {
  const serverEntryDir = dirname(fileURLToPath(serverEntryUrl));

  const candidates: readonly { layout: "packaged" | "repo"; root: string }[] = [
    { layout: "packaged", root: resolve(serverEntryDir, "../..") },
    {
      layout: "repo",
      root: resolve(serverEntryDir, "../../../packages/omnyo-app"),
    },
  ];

  for (const candidate of candidates) {
    try {
      const packageJson = await readOmnyoAppPackageJson(candidate.root);

      return { ...candidate, packageJson };
    } catch {}
  }

  throw new Error(
    `Unable to locate the omnyo-app package from ${serverEntryDir}; tried ${candidates
      .map((candidate) => candidate.root)
      .join(", ")}`,
  );
}

export const HOST_ARTIFACT_SIGNATURES_DIRECTORY = "host-artifact-signatures";

const SIGNATURE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function createHostArtifactSignatureReader(options: {
  dataDir: string;
  logger: HostArtifactSignatureLogger;
}): HostArtifactSignatureReader {
  const warned = new Set<string>();

  function unavailable(
    subject: HostArtifactSignatureSubject,
    reason: "missing" | "unreadable" | "invalid" | "mismatched",
  ): null {
    const key = `${subject.digest}:${reason}`;

    if (!warned.has(key)) {
      warned.add(key);
      options.logger.warn(
        {
          artifactDigest: subject.digest,
          reason,
          signatureFile: `${HOST_ARTIFACT_SIGNATURES_DIRECTORY}/${subject.digest}.json`,
        },
        "The served Omnyo host artifact has no usable release signature; machines that require signed updates will not install it. Run the release signing step for this artifact.",
      );
    }

    return null;
  }

  return {
    async read(subject) {
      if (!SIGNATURE_DIGEST_PATTERN.test(subject.digest))
        return unavailable(subject, "invalid");
      let text: string;

      try {
        text = await readFile(
          join(
            options.dataDir,
            HOST_ARTIFACT_SIGNATURES_DIRECTORY,
            `${subject.digest}.json`,
          ),
          "utf8",
        );
      } catch (error) {
        return unavailable(
          subject,
          error instanceof Error && "code" in error && error.code === "ENOENT"
            ? "missing"
            : "unreadable",
        );
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch {
        return unavailable(subject, "invalid");
      }

      const record = parseHostArtifactSignatureRecord(parsed);

      if (record === null) return unavailable(subject, "invalid");

      return record.version === subject.version &&
        record.protocolVersion === subject.protocolVersion &&
        record.digest === subject.digest
        ? record
        : unavailable(subject, "mismatched");
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createOmnyoAppArtifactService(
  options: CreateOmnyoAppArtifactServiceOptions,
): OmnyoAppArtifactService {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const cacheDir = join(options.dataDir, "install-cache");

  const protocolVersion =
    options.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION;

  let resolvedPackagePromise: Promise<ResolvedOmnyoAppPackage> | undefined;
  let artifactPromise: Promise<OmnyoAppArtifact> | undefined;

  function getResolvedPackage(): Promise<ResolvedOmnyoAppPackage> {
    resolvedPackagePromise ??= resolveOmnyoAppPackage(options.serverEntryUrl);

    return resolvedPackagePromise;
  }

  async function buildArtifact(): Promise<OmnyoAppArtifact> {
    const resolved = await getResolvedPackage();
    const { packageJson, root: packageRoot } = resolved;

    if (resolved.layout === "packaged") {
      const descriptor = preparedArtifactSchema.parse(
        JSON.parse(
          await readFile(join(packageRoot, "dist/host-artifact.json"), "utf8"),
        ),
      );

      if (
        descriptor.version !== packageJson.version ||
        descriptor.protocolVersion !== protocolVersion
      ) {
        throw new Error(
          "Prepared host artifact does not match the runtime version and protocol",
        );
      }

      const path = join(packageRoot, "dist/host-artifact.tgz");
      const info = await lstat(path);

      if (
        !info.isFile() ||
        info.size !== descriptor.size ||
        sha256(await readFile(path)) !== descriptor.digest
      ) {
        throw new Error("Prepared host artifact integrity check failed");
      }

      return { digest: descriptor.digest, path, size: descriptor.size };
    }

    await mkdir(cacheDir, { recursive: true });
    const repoRoot = resolve(packageRoot, "../..");
    await commandRunner(
      "pnpm",
      ["exec", "turbo", "run", "build:host", "--filter=omnyo-app"],
      repoRoot,
    );
    const hostPackageRoot = join(packageRoot, "host-package");

    const stdout = await commandRunner(
      "npm",
      ["pack", "--pack-destination", cacheDir],
      hostPackageRoot,
    );

    const packedName = stdout.trim().split(/\r?\n/u).at(-1);

    if (!packedName) {
      throw new Error("npm pack did not report a tarball name");
    }

    const packedPath = join(cacheDir, packedName);
    const bytes = await readFile(packedPath);
    const digest = sha256(bytes);

    const artifactPath = join(
      cacheDir,
      `omnyo-app-host-${packageJson.version}-protocol-${protocolVersion}-${digest}.tgz`,
    );

    await rename(packedPath, artifactPath);
    const artifactStats = await lstat(artifactPath);

    return { digest, path: artifactPath, size: artifactStats.size };
  }

  return {
    async getArtifact(): Promise<OmnyoAppArtifact> {
      artifactPromise ??= buildArtifact().catch((error: unknown) => {
        artifactPromise = undefined;
        throw error;
      });

      return artifactPromise;
    },
    async getVersion(): Promise<string> {
      return (await getResolvedPackage()).packageJson.version;
    },
  };
}
