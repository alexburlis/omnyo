import { createHash, randomUUID } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports -- Owns server-local web update generations, never workspace files.
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  webBuildSchema,
  webUpdateIdentitySchema,
  type WebBuild,
  type WebUpdateBegin,
  type WebUpdateUpload,
  type WebUpdateApply,
  type WebUpdateRollback,
  type WebUpdateStatus,
  type WebAssetManifest,
} from "@omnyo/server-contract";
import { assertStorageAdmission } from "@omnyo/process-utils";
import { ApiError } from "../../errors.js";
import { runEventLoopWork } from "./event-loop-work.js";

const stateSchema = z
  .object({
    baselineId: z.string().regex(/^[a-f0-9]{64}$/u),
    compatibilityHash: z.string().regex(/^[a-f0-9]{64}$/u),
    active: webUpdateIdentitySchema.nullable(),
    previous: webUpdateIdentitySchema.nullable(),
  })
  .strict();

const uploadMarkerSchema = z
  .object({
    schema: z.literal(1),
    owner: z.literal("omnyo-private-web-upload"),
    uploadId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const generationOwnerSchema = z
  .object({
    schema: z.literal(1),
    owner: z.literal("omnyo-web-generation"),
    generation: z.string().regex(/^[a-f0-9]{64}$/u),
    assets: z.array(
      z
        .object({
          path: z
            .string()
            .regex(/^assets\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/u)
            .refine(
              (path) =>
                !path.split("/").some((part) => part === "." || part === ".."),
            ),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          size: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

const assetOwnershipSchema = z
  .object({
    schema: z.literal(1),
    owner: z.literal("omnyo-web-assets"),
    assets: generationOwnerSchema.shape.assets,
  })
  .strict();

const clientSchema = z
  .object({
    schema: z.literal(1),
    owner: z.literal("omnyo-web-client"),
    generation: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const WEB_STORAGE_LIMIT = 4 * 1024 ** 3;

const WEB_CLIENT_LIMIT = 4096;

const WEB_STORAGE_SCAN_CONCURRENCY = 64;

function requireConnected(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Web publication was canceled.", "AbortError");
}

async function storedBytes(
  root: string,
  signal?: AbortSignal,
): Promise<number> {
  const paths = [root];
  let total = 0;

  while (paths.length > 0) {
    requireConnected(signal);

    const batch = paths.splice(
      Math.max(0, paths.length - WEB_STORAGE_SCAN_CONCURRENCY),
    );

    await Promise.all(
      batch.map(async (path) => {
        const entry = await lstat(path).catch((cause: unknown) => {
          if (missing.safeParse(cause).success) return null;
          throw cause;
        });

        if (entry === null) return;

        if (entry.isSymbolicLink())
          throw new Error(
            "Web publication storage contains an unknown symbolic link",
          );

        if (entry.isDirectory()) {
          for (const name of await readdir(path)) paths.push(join(path, name));
        } else {
          total += entry.size;
        }
      }),
    );
  }

  return total;
}

const missing = z.object({ code: z.literal("ENOENT") });

const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function regular(path: string) {
  const entry = await lstat(path);

  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Web update file is invalid");

  return readFile(path);
}

const WEB_ASSET_FILE = /^assets\/[^/]+\.(?:js|css)$/u;

const BOOT_ASSET_REFERENCE = /(?:src|href)="(\/assets\/[^"/]+\.(?:js|css))"/gu;

export function webAssetManifestFromBuild(args: {
  generation: string;
  build: WebBuild;
  indexHtml: string;
}): WebAssetManifest {
  const boot = new Set<string>();

  for (const match of args.indexHtml.matchAll(BOOT_ASSET_REFERENCE)) {
    const path = match[1];

    if (path !== undefined) boot.add(path);
  }

  return {
    generation: args.generation,
    boot: [...boot],
    assets: args.build.files
      .filter((file) => WEB_ASSET_FILE.test(file.path))
      .map((file) => ({ path: `/${file.path}`, bytes: file.size })),
  };
}

export class WebUpdateService {
  private readonly root: string;
  private readonly uploads = new Map<
    string,
    {
      build: WebBuild;
      expectedActive: string | null;
      createdAt: number;
      baselineId: string;
    }
  >();
  private baselineSnapshot: {
    signature: string;
    build: WebBuild;
    id: string;
  } | null = null;
  private baselineRead: Promise<typeof this.baselineSnapshot> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private manifestSnapshot: WebAssetManifest | null = null;

  constructor(
    dataDir: string,
    private readonly staticDir: string | undefined,
    private readonly publicationBlocked: () => boolean = () => false,
    private readonly onActiveChanged: () => void = () => {},
  ) {
    this.root = join(dataDir, "private-web-updates");
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private requirePublicationAdmission(): void {
    if (this.publicationBlocked())
      throw new ApiError(
        409,
        "app_update_in_progress",
        "The runtime is restarting. Publish the web update after it finishes.",
      );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  private baseline() {
    if (this.baselineRead) return this.baselineRead;
    const pending = this.readBaseline();
    this.baselineRead = pending;
    void pending.then(
      () => {
        this.baselineRead = null;
      },
      () => {
        this.baselineRead = null;
      },
    );

    return pending;
  }

  private async readBaseline() {
    if (!this.staticDir) return null;

    try {
      const path = join(this.staticDir, "web-build.json");
      const entry = await lstat(path, { bigint: true });

      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Web update file is invalid");

      const signature = [
        entry.dev,
        entry.ino,
        entry.size,
        entry.mtimeNs,
        entry.ctimeNs,
      ].join(":");

      if (this.baselineSnapshot?.signature === signature)
        return this.baselineSnapshot;

      const build = webBuildSchema.parse(
        JSON.parse((await readFile(path)).toString()),
      );

      this.baselineSnapshot = {
        signature,
        build,
        id: hash(JSON.stringify(build)),
      };

      return this.baselineSnapshot;
    } catch (cause) {
      this.baselineSnapshot = null;

      if (missing.safeParse(cause).success) return null;
      throw cause;
    }
  }

  private async state() {
    try {
      return stateSchema.parse(
        JSON.parse((await regular(join(this.root, "active.json"))).toString()),
      );
    } catch (cause) {
      if (missing.safeParse(cause).success) return null;
      throw cause;
    }
  }

  async status(): Promise<WebUpdateStatus> {
    const [packaged, active] = await Promise.allSettled([
      this.baseline(),
      this.state(),
    ]);

    if (packaged.status === "rejected") throw packaged.reason;

    if (active.status === "rejected") throw active.reason;
    const snapshot = packaged.value;
    const state = active.value;
    const baseline = snapshot?.build ?? null;

    const compatible =
      snapshot !== null &&
      state?.compatibilityHash === snapshot.build.compatibilityHash &&
      state.baselineId === snapshot.id;

    return {
      supported: baseline !== null,
      packagedSourceCommit: baseline?.sourceCommit ?? null,
      compatibilityHash: baseline?.compatibilityHash ?? null,
      active: compatible ? state.active : null,
      previous: compatible ? state.previous : null,
      inactiveReason:
        state && !compatible
          ? "The packaged runtime changed; its bundled interface is active."
          : null,
    };
  }

  async roots(createClientLease = false) {
    const read = async () => {
      const status = await this.status();
      let clientLease: string | null = null;

      if (
        createClientLease &&
        status.active &&
        (await this.generationOwner(status.active.id))
      ) {
        const clients = join(this.root, "clients");

        const entries = await readdir(clients).catch((cause: unknown) => {
          if (missing.safeParse(cause).success) return [];
          throw cause;
        });

        if (entries.length >= WEB_CLIENT_LIMIT)
          throw new ApiError(
            503,
            "conflict",
            "The web client retention budget is full. Close unused Omnyo tabs before opening another.",
          );
        await mkdir(clients, { recursive: true });
        clientLease = randomUUID();
        await writeFile(
          join(clients, clientLease + ".json"),
          JSON.stringify({
            schema: 1,
            owner: "omnyo-web-client",
            generation: status.active.id,
          }),
          { flag: "wx" },
        );
      }

      return {
        shell: status.active
          ? join(this.root, "generations", status.active.id)
          : this.staticDir,
        assets: join(this.root, "public"),
        sourceCommit: status.active?.sourceCommit ?? null,
        clientLease,
      };
    };

    return createClientLease ? this.serialize(read) : read();
  }

  releaseClient(clientLease: string) {
    return this.serialize(async () => {
      if (!z.string().uuid().safeParse(clientLease).success)
        throw new Error("Web client lease is invalid");
      const path = join(this.root, "clients", clientLease + ".json");

      const raw = await regular(path).catch((cause: unknown) => {
        if (missing.safeParse(cause).success) return null;
        throw cause;
      });

      if (raw !== null) {
        clientSchema.parse(JSON.parse(raw.toString()));
        await rm(path);
      }
    });
  }

  private async generationOwner(id: string) {
    const path = join(this.root, "generations", id, ".generation-owner.json");

    const raw = await regular(path).catch((cause: unknown) => {
      if (missing.safeParse(cause).success) return null;
      throw cause;
    });

    if (raw === null) return null;
    const owner = generationOwnerSchema.parse(JSON.parse(raw.toString()));

    if (owner.generation !== id)
      throw new Error("Web generation ownership changed");

    return owner;
  }

  private async pruneGenerations(signal?: AbortSignal) {
    const state = await this.state();
    const keep = new Set([state?.active?.id, state?.previous?.id]);
    const clients = join(this.root, "clients");

    for (const name of await readdir(clients).catch((cause: unknown) => {
      if (missing.safeParse(cause).success) return [];
      throw cause;
    })) {
      requireConnected(signal);

      if (
        !z
          .string()
          .uuid()
          .safeParse(name.replace(/\.json$/u, "")).success
      )
        throw new Error("Web client ownership is unknown");
      keep.add(
        clientSchema.parse(
          JSON.parse((await regular(join(clients, name))).toString()),
        ).generation,
      );
    }

    const root = join(this.root, "generations");

    const generations = await readdir(root).catch((cause: unknown) => {
      if (missing.safeParse(cause).success) return [];
      throw cause;
    });

    const candidates = [];
    const referenced = new Set<string>();

    for (const session of this.uploads.values())
      for (const file of session.build.files) referenced.add(file.path);

    for (const id of generations) {
      requireConnected(signal);

      if (!/^[a-f0-9]{64}$/u.test(id))
        throw new Error("Web generation ownership is unknown");

      const build = webBuildSchema.parse(
        JSON.parse(
          (await regular(join(root, id, "web-build.json"))).toString(),
        ),
      );

      if (hash(JSON.stringify(build)) !== id)
        throw new Error("Web generation identity changed");
      const owner = await this.generationOwner(id);

      if (owner) {
        const filesByPath = new Map(
          build.files.map((file) => [file.path, file]),
        );

        for (const asset of owner.assets) {
          const file = filesByPath.get(asset.path);

          if (file?.sha256 !== asset.sha256 || file.size !== asset.size)
            throw new Error(
              "Web generation asset ownership differs from its build manifest",
            );
        }
      }

      if (!owner || keep.has(id))
        for (const file of build.files) referenced.add(file.path);
      else candidates.push({ id, build, owner });
    }

    for (const candidate of candidates) {
      requireConnected(signal);
      await this.verifyGeneration(candidate.id);

      const expected = new Set([
        "web-build.json",
        ".generation-owner.json",
        ...candidate.build.files
          .filter((file) => !file.path.startsWith("assets/"))
          .map((file) => file.path),
      ]);

      const files = await this.generationFiles(join(root, candidate.id));

      if (
        files.some((path) => !expected.has(path)) ||
        files.length !== expected.size
      )
        throw new Error(
          "Web generation contains unknown files; retention stopped",
        );
    }

    requireConnected(signal);

    for (const candidate of candidates)
      await rm(join(root, candidate.id), { recursive: true });
    const ownership = await this.assetOwnership();
    const retained = [];

    for (const asset of ownership.assets) {
      if (referenced.has(asset.path)) {
        retained.push(asset);
        continue;
      }

      const path = join(this.root, "public", asset.path);

      const bytes = await regular(path).catch((cause: unknown) => {
        if (missing.safeParse(cause).success) return null;
        throw cause;
      });

      if (bytes !== null) {
        if (bytes.length !== asset.size || hash(bytes) !== asset.sha256)
          throw new Error("Web retention asset identity changed");
        await rm(path);
      }
    }

    await this.saveAssetOwnership(retained);
  }

  private async assetOwnership() {
    const raw = await regular(join(this.root, ".asset-ownership.json")).catch(
      (cause: unknown) => {
        if (missing.safeParse(cause).success) return null;
        throw cause;
      },
    );

    return raw === null
      ? assetOwnershipSchema.parse({
          schema: 1,
          owner: "omnyo-web-assets",
          assets: [],
        })
      : assetOwnershipSchema.parse(JSON.parse(raw.toString()));
  }

  private async saveAssetOwnership(
    assets: z.infer<typeof generationOwnerSchema>["assets"],
  ) {
    await mkdir(this.root, { recursive: true });
    const pending = join(this.root, ".asset-ownership-" + randomUUID());

    try {
      await writeFile(
        pending,
        JSON.stringify({ schema: 1, owner: "omnyo-web-assets", assets }),
        { flag: "wx" },
      );
      await rename(pending, join(this.root, ".asset-ownership.json"));
    } finally {
      await rm(pending, { force: true });
    }
  }

  private async generationFiles(
    root: string,
    relative = "",
  ): Promise<string[]> {
    const path = relative ? join(root, relative) : root;
    const entry = await lstat(path);

    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Web generation directory is invalid");
    const files: string[] = [];

    for (const name of await readdir(path)) {
      const child = relative ? relative + "/" + name : name;
      const entry = await lstat(join(root, child));

      if (entry.isDirectory() && !entry.isSymbolicLink())
        files.push(...(await this.generationFiles(root, child)));
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(child);
      else throw new Error("Web generation has unknown files");
    }

    return files;
  }

  async assetManifest(): Promise<WebAssetManifest | null> {
    const [status, baseline] = await Promise.all([
      this.status(),
      this.baseline(),
    ]);

    const generation = status.active?.id ?? baseline?.id ?? null;

    if (generation === null) return null;

    if (this.manifestSnapshot?.generation === generation)
      return this.manifestSnapshot;

    const shell = status.active
      ? join(this.root, "generations", status.active.id)
      : this.staticDir;

    if (shell === undefined) return null;

    const [buildBytes, indexHtml] = await Promise.all([
      regular(join(shell, "web-build.json")),
      regular(join(shell, "index.html")),
    ]);

    const manifest = webAssetManifestFromBuild({
      generation,
      build: webBuildSchema.parse(JSON.parse(buildBytes.toString())),
      indexHtml: indexHtml.toString(),
    });

    this.manifestSnapshot = manifest;

    return manifest;
  }

  private async requireActive(expected: string | null) {
    const status = await this.status();

    if ((status.active?.id ?? null) !== expected)
      throw new ApiError(
        409,
        "conflict",
        "The web interface changed. Read its status before publishing again.",
      );

    return status;
  }

  private async requireUploadMarker({
    uploadId,
    expectedCreatedAt,
  }: {
    uploadId: string;
    expectedCreatedAt: number | undefined;
  }): Promise<string> {
    if (!z.string().uuid().safeParse(uploadId).success)
      throw new Error("Web upload ownership is invalid");
    const directory = join(this.root, "staging", uploadId);
    const entry = await lstat(directory);

    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Web upload directory is invalid");

    const raw = await regular(join(directory, ".upload.json")).catch(
      (cause: unknown) => {
        if (missing.safeParse(cause).success)
          throw new Error("Web upload marker is missing");
        throw cause;
      },
    );

    let value: unknown;

    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Web upload marker is invalid");
    }

    const parsed = uploadMarkerSchema.safeParse(value);

    if (!parsed.success) throw new Error("Web upload marker is invalid");
    const marker = parsed.data;

    const ownedBytes = JSON.stringify({
      schema: marker.schema,
      owner: marker.owner,
      uploadId: marker.uploadId,
      createdAt: marker.createdAt,
    });

    if (raw.toString("utf8") !== ownedBytes)
      throw new Error("Web upload marker has ambiguous or foreign bytes");

    if (
      marker.uploadId !== uploadId ||
      (expectedCreatedAt !== undefined &&
        marker.createdAt !== expectedCreatedAt)
    )
      throw new Error("Web upload ownership changed");

    return hash(raw);
  }

  private async pruneUploads(signal?: AbortSignal) {
    const stagingRoot = join(this.root, "staging");

    const stagingInfo = await lstat(stagingRoot).catch((cause: unknown) => {
      if (missing.safeParse(cause).success) return null;
      throw cause;
    });

    if (
      stagingInfo !== null &&
      (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink())
    )
      throw new Error("Web upload staging directory is invalid");
    const entries = stagingInfo === null ? [] : await readdir(stagingRoot);
    const abandoned: Array<{ uploadId: string; digest: string }> = [];

    for (const uploadId of entries) {
      requireConnected(signal);

      if (!z.string().uuid().safeParse(uploadId).success)
        throw new Error("Unrecognized web upload cannot be pruned");
      const session = this.uploads.get(uploadId);

      const digest = await this.requireUploadMarker({
        uploadId,
        expectedCreatedAt: session?.createdAt,
      });

      if (session && Date.now() - session.createdAt < 30 * 60_000) continue;
      abandoned.push({ uploadId, digest });
    }

    await this.pruneGenerations(signal);

    for (const { uploadId, digest } of abandoned) {
      if (
        (await this.requireUploadMarker({
          uploadId,
          expectedCreatedAt: this.uploads.get(uploadId)?.createdAt,
        })) !== digest
      )
        throw new Error("Web upload ownership changed before recovery");
      this.uploads.delete(uploadId);
      await rm(join(stagingRoot, uploadId), { recursive: true, force: true });
    }
  }

  begin(input: WebUpdateBegin, signal?: AbortSignal) {
    return this.serialize(async () => {
      requireConnected(signal);
      const status = await this.requireActive(input.expectedActive);

      if (
        !status.supported ||
        status.compatibilityHash !== input.build.compatibilityHash
      )
        throw new ApiError(
          409,
          "conflict",
          "This change requires a full Omnyo release.",
        );
      requireConnected(signal);
      await runEventLoopWork("web-update prune ownership", () =>
        this.pruneUploads(signal),
      );

      if (this.uploads.size >= 2)
        throw new ApiError(
          409,
          "conflict",
          "A web upload is already in progress.",
        );

      const expectedBytes = Math.max(
        1,
        input.build.files.reduce((sum, file) => sum + file.size, 0) * 2 + 65536,
      );

      const retainedBytes = await runEventLoopWork(
        "web-update measure retained bytes",
        () => storedBytes(this.root, signal),
      );

      const reservedBytes = [...this.uploads.values()].reduce(
        (sum, session) =>
          sum +
          session.build.files.reduce((bytes, file) => bytes + file.size, 0) * 2,
        0,
      );

      if (retainedBytes + reservedBytes + expectedBytes > WEB_STORAGE_LIMIT)
        throw new ApiError(
          409,
          "conflict",
          "Web publication storage is full. Retained clients, rollback and legacy assets need owner review before another upload.",
        );
      await runEventLoopWork("web-update check filesystem reserve", () =>
        assertStorageAdmission({
          directory: this.root,
          expectedBytes,
          minimumFreeBytes: 1024 ** 3,
        }),
      );
      requireConnected(signal);
      const uploadId = randomUUID();
      const createdAt = Date.now();
      await mkdir(join(this.root, "staging"), { recursive: true });
      await mkdir(join(this.root, "staging", uploadId));
      await writeFile(
        join(this.root, "staging", uploadId, ".upload.json"),
        JSON.stringify({
          schema: 1,
          owner: "omnyo-private-web-upload",
          uploadId,
          createdAt,
        }),
        { flag: "wx" },
      );
      this.uploads.set(uploadId, {
        ...input,
        createdAt,
        baselineId: (await this.baseline())?.id ?? hash("null"),
      });

      if (signal?.aborted) {
        await this.removeUpload(uploadId);
        requireConnected(signal);
      }

      return { uploadId };
    });
  }

  upload(input: WebUpdateUpload) {
    return this.serialize(async () => {
      const session = this.uploads.get(input.uploadId);

      const file = session?.build.files.find(
        (entry) => entry.path === input.path,
      );

      if (!session || !file)
        throw new ApiError(
          404,
          "not_found",
          "The web upload or file is unavailable.",
        );
      await this.requireUploadMarker({
        uploadId: input.uploadId,
        expectedCreatedAt: session.createdAt,
      });
      const bytes = Buffer.from(input.content, "base64");

      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        throw new ApiError(
          400,
          "invalid_request",
          "Web update bytes do not match the build manifest.",
        );
      const path = join(this.root, "staging", input.uploadId, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: "wx" });

      return { ok: true as const };
    });
  }

  private async removeUpload(uploadId: string) {
    const session = this.uploads.get(uploadId);

    if (!session) return;

    await this.requireUploadMarker({
      uploadId,
      expectedCreatedAt: session.createdAt,
    });
    await rm(join(this.root, "staging", uploadId), {
      recursive: true,
      force: true,
    });
    this.uploads.delete(uploadId);
  }

  abort(uploadId: string) {
    return this.serialize(async () => {
      await this.removeUpload(uploadId);

      return { ok: true as const };
    });
  }

  private async save(state: z.infer<typeof stateSchema>) {
    const pending = join(this.root, ".active-" + randomUUID());

    try {
      await writeFile(pending, JSON.stringify(state) + "\n", { flag: "wx" });
      this.requirePublicationAdmission();
      await rename(pending, join(this.root, "active.json"));
    } finally {
      await rm(pending, { force: true });
    }

    this.onActiveChanged();
  }

  private async verifyGeneration(id: string) {
    const root = join(this.root, "generations", id);

    const build = webBuildSchema.parse(
      JSON.parse((await regular(join(root, "web-build.json"))).toString()),
    );

    if (hash(JSON.stringify(build)) !== id)
      throw new Error("Web generation identity changed");

    for (const file of build.files) {
      const bytes = await regular(
        join(
          file.path.startsWith("assets/") ? join(this.root, "public") : root,
          file.path,
        ),
      );

      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        throw new Error("Web generation bytes changed");
    }
  }

  apply(input: WebUpdateApply) {
    return this.serialize(async () => {
      this.requirePublicationAdmission();
      const session = this.uploads.get(input.uploadId);

      if (!session)
        throw new ApiError(404, "not_found", "The web upload is unavailable.");
      await this.requireUploadMarker({
        uploadId: input.uploadId,
        expectedCreatedAt: session.createdAt,
      });
      const status = await this.requireActive(input.expectedActive);

      if (
        session.baselineId !== ((await this.baseline())?.id ?? hash("null")) ||
        session.expectedActive !== input.expectedActive ||
        session.build.compatibilityHash !== status.compatibilityHash
      )
        throw new ApiError(
          409,
          "conflict",
          "The web build no longer matches this runtime.",
        );
      const staging = join(this.root, "staging", input.uploadId);

      for (const file of session.build.files) {
        const bytes = await regular(join(staging, file.path)).catch(
          (cause: unknown) => {
            if (missing.safeParse(cause).success)
              throw new ApiError(
                400,
                "invalid_request",
                "The web upload is incomplete.",
              );
            throw cause;
          },
        );

        if (bytes.length !== file.size || hash(bytes) !== file.sha256)
          throw new ApiError(
            400,
            "invalid_request",
            "The web upload is incomplete or changed.",
          );
      }

      const id = hash(JSON.stringify(session.build));
      const generation = join(this.root, "generations", id);
      await mkdir(dirname(generation), { recursive: true });

      const ownership = await this.assetOwnership();

      const knownOwnedAssets = new Set<string>(
        ownership.assets.map((file) => file.path),
      );

      for (const prior of await readdir(join(this.root, "generations"))) {
        if (!/^[a-f0-9]{64}$/u.test(prior))
          throw new Error("Web generation ownership is unknown");

        for (const file of (await this.generationOwner(prior))?.assets ?? [])
          knownOwnedAssets.add(file.path);
      }

      const ownedAssets = [];

      for (const file of session.build.files.filter((file) =>
        file.path.startsWith("assets/"),
      )) {
        const target = join(this.root, "public", file.path);
        await mkdir(dirname(target), { recursive: true });

        try {
          const existing = await regular(target);

          if (hash(existing) !== file.sha256)
            throw new Error("A retained web asset has conflicting bytes");
        } catch (cause) {
          if (!missing.safeParse(cause).success) throw cause;
          await rename(join(staging, file.path), target);
          knownOwnedAssets.add(file.path);
        }

        if (knownOwnedAssets.has(file.path)) ownedAssets.push(file);
      }

      const assetRecords = new Map(
        ownership.assets.map((file) => [file.path, file]),
      );

      for (const file of ownedAssets) assetRecords.set(file.path, file);
      await this.saveAssetOwnership([...assetRecords.values()]);
      await rm(join(staging, "assets"), { recursive: true, force: true });
      await rm(join(staging, ".upload.json"));
      await writeFile(
        join(staging, "web-build.json"),
        JSON.stringify(session.build),
      );
      await writeFile(
        join(staging, ".generation-owner.json"),
        JSON.stringify({
          schema: 1,
          owner: "omnyo-web-generation",
          generation: id,
          assets: ownedAssets,
        }),
        { flag: "wx" },
      );
      this.uploads.delete(input.uploadId);

      try {
        await rename(staging, generation);
      } catch (cause) {
        const alreadyExists = z
          .object({ code: z.enum(["EEXIST", "ENOTEMPTY"]) })
          .safeParse(cause).success;

        if (!alreadyExists) throw cause;
        await rm(staging, { recursive: true, force: true });
      }

      await this.verifyGeneration(id);
      await this.save({
        baselineId: session.baselineId,
        compatibilityHash: session.build.compatibilityHash,
        active: { id, sourceCommit: session.build.sourceCommit },
        previous: status.active?.id === id ? status.previous : status.active,
      });

      return this.status();
    });
  }

  rollback(input: WebUpdateRollback) {
    return this.serialize(async () => {
      this.requirePublicationAdmission();
      const status = await this.requireActive(input.expectedActive);

      if ((!status.active && !status.previous) || !status.compatibilityHash)
        throw new ApiError(
          409,
          "conflict",
          "No previous web update is available.",
        );

      if (status.previous) await this.verifyGeneration(status.previous.id);
      await this.save({
        baselineId: (await this.baseline())?.id ?? hash("null"),
        compatibilityHash: status.compatibilityHash,
        active: status.previous,
        previous: status.active,
      });

      return this.status();
    });
  }
}
