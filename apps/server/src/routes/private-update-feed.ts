import { createHash } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports -- Private feed bytes are server-owned release storage, not machine workspace access.
import { constants, lstat, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquirePublicationReader } from "@omnyo/process-utils";
import { RELEASE_VERSION_PATTERN } from "@omnyo/config/release-version";
import type { Hono } from "hono";
import { z } from "zod";

const channelSchema = z.enum(["latest", "nightly"]);

const platformSchema = z.enum(["macos", "windows"]);

const basenameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u);

const approvedManifestSchema = z
  .object({
    schema: z.literal(1),
    approved: z.literal(true),
    approvalRef: z.string().min(1).max(256),
    version: z.string().regex(RELEASE_VERSION_PATTERN),
    protocolVersion: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    channel: channelSchema,
    files: z
      .array(
        z
          .object({
            platform: platformSchema,
            name: basenameSchema,
            size: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 ** 3),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (manifest) =>
      new Set(manifest.files.map((file) => file.platform + "/" + file.name))
        .size === manifest.files.length,
  );

async function directory(path: string): Promise<void> {
  const entry = await lstat(path);

  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Private feed directory is invalid");
}

async function readApprovedManifest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const entry = await file.stat();

    if (!entry.isFile() || entry.size > 65536)
      throw new Error("Private feed manifest is invalid");

    return approvedManifestSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );
  } finally {
    await file.close();
  }
}

interface PrivateUpdateFeedLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

interface VerifiedFile {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
}

function sameFile(
  verified: VerifiedFile | undefined,
  entry: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  sha256: string,
): boolean {
  return (
    verified !== undefined &&
    verified.sha256 === sha256 &&
    verified.dev === entry.dev &&
    verified.ino === entry.ino &&
    verified.size === entry.size &&
    verified.mtimeNs === entry.mtimeNs &&
    verified.ctimeNs === entry.ctimeNs
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function digest(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");

  for await (const bytes of file.createReadStream({
    start: 0,
    autoClose: false,
  }))
    hash.update(bytes);

  return hash.digest("hex");
}

export function registerPrivateUpdateFeedRoutes(
  app: Hono,
  dataDir: string,
  logger: PrivateUpdateFeedLogger,
): void {
  const root = resolve(dataDir, "private-updates");
  const verified = new Map<string, VerifiedFile>();
  app.on(
    ["GET", "HEAD"],
    "/private-updates/:channel/:platform/:file",
    async (context) => {
      let file: FileHandle | null = null;
      let releaseReader: (() => Promise<void>) | null = null;
      const requested = context.req.path;

      try {
        const channel = channelSchema.parse(context.req.param("channel"));
        const platform = platformSchema.parse(context.req.param("platform"));
        const name = basenameSchema.parse(context.req.param("file"));
        const channelDirectory = join(root, channel);
        await directory(root);
        await directory(channelDirectory);

        const manifest = await readApprovedManifest(
          join(channelDirectory, "approved.json"),
        );

        if (manifest.channel !== channel)
          throw new Error("Private feed channel differs");

        const artifact = manifest.files.find(
          (entry) => entry.platform === platform && entry.name === name,
        );

        if (!artifact) throw new Error("Private feed file is not approved");
        releaseReader = await acquirePublicationReader(
          channelDirectory,
          manifest.sourceCommit,
        );
        const releaseDirectory = join(channelDirectory, manifest.sourceCommit);
        const platformDirectory = join(releaseDirectory, platform);
        await directory(releaseDirectory);
        await directory(platformDirectory);
        const path = join(platformDirectory, name);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await file.stat({ bigint: true });

        if (!before.isFile() || before.size !== BigInt(artifact.size))
          throw new Error("Private feed bytes differ");

        if (!sameFile(verified.get(path), before, artifact.sha256)) {
          if ((await digest(file)) !== artifact.sha256)
            throw new Error("Private feed bytes differ");
          verified.set(path, {
            dev: before.dev,
            ino: before.ino,
            size: before.size,
            mtimeNs: before.mtimeNs,
            ctimeNs: before.ctimeNs,
            sha256: artifact.sha256,
          });
        }

        const headers = {
          "cache-control": "private, no-store, no-transform",
          "content-type": name.endsWith(".yml")
            ? "application/yaml"
            : "application/octet-stream",
          "content-encoding": "identity",
          "content-length": String(artifact.size),
          "x-content-type-options": "nosniff",
          etag: `"sha256-${artifact.sha256}"`,
        };

        if (context.req.method === "HEAD") {
          await file.close();
          file = null;
          await releaseReader();
          releaseReader = null;

          return new Response(null, { headers });
        }

        const openedFile = file;
        const closeReader = releaseReader;
        releaseReader = null;
        file = null;
        let closed = false;

        const close = async () => {
          if (closed) return;
          closed = true;

          try {
            await openedFile.close();
          } finally {
            await closeReader();
          }
        };

        const hash = createHash("sha256");
        let position = 0;

        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const bytes = Buffer.alloc(
                Math.min(65536, artifact.size - position),
              );

              const read = await openedFile.read(
                bytes,
                0,
                bytes.length,
                position,
              );

              if (read.bytesRead !== bytes.length)
                throw new Error("Private feed stream changed");
              position += read.bytesRead;
              hash.update(bytes);

              if (position === artifact.size) {
                const after = await openedFile.stat({ bigint: true });

                if (
                  hash.digest("hex") !== artifact.sha256 ||
                  after.size !== before.size ||
                  after.mtimeNs !== before.mtimeNs ||
                  after.ctimeNs !== before.ctimeNs ||
                  after.ino !== before.ino
                ) {
                  verified.delete(path);
                  throw new Error("Private feed stream changed");
                }

                await close();
                controller.enqueue(bytes);
                controller.close();

                return;
              }

              controller.enqueue(bytes);
            } catch (error) {
              await close();
              logger.warn(
                { path: requested, reason: reason(error) },
                "Private update stream failed",
              );
              controller.error(new Error("Private feed stream is unavailable"));
            }
          },
          async cancel() {
            await close();
          },
        });

        return new Response(body, { headers });
      } catch (error) {
        try {
          if (file) await file.close();
        } finally {
          if (releaseReader) await releaseReader();
        }

        logger.warn(
          { path: requested, reason: reason(error) },
          "Private update file is unavailable",
        );

        return new Response("Private update file is unavailable", {
          status: 404,
          headers: { "cache-control": "no-store" },
        });
      }
    },
  );
  app.all(
    "/private-updates/*",
    () =>
      new Response("Private update file is unavailable", {
        status: 404,
        headers: { "cache-control": "no-store" },
      }),
  );
}
