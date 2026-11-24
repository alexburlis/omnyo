import type { MachineExecutor } from "@omnyo/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Status } from "nice-grpc-common";
import { ensureModalImage, type ModalImageRequest } from "./image.js";
import { ModalClient, NotFoundError, type Sandbox } from "modal";

export interface ModalSandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ModalSandboxHandle {
  readonly sandboxId: string;
  exec(
    command: readonly string[],
    options: {
      timeoutMs: number;
      signal: AbortSignal;
      stdin?: string;
      maxOutputBytes?: number;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<ModalSandboxExecResult>;
  terminate(): Promise<void>;
  snapshotFilesystem(options: {
    timeoutMs: number;
    ttlMs: number | null;
  }): Promise<string>;
}

export function createModalSandboxExecutor(
  sandbox: ModalSandboxHandle,
): MachineExecutor {
  return {
    async exec({ command, ...options }) {
      const { exitCode } = await sandbox.exec(command, {
        ...options,
        maxOutputBytes: 0,
      });

      return { exitCode };
    },
  };
}

export type ModalSandboxImage =
  | { type: "snapshot"; imageId: string }
  | { type: "image"; imageId: string };

export interface ModalSandboxCreateRequest {
  appName: string;
  name: string;
  image: ModalSandboxImage;
  timeoutMs: number;
  cpu: number | null;
  memoryMiB: number | null;
  tags: Record<string, string>;
}

export interface ModalSandboxClient {
  accountIdentity(): Promise<string>;
  validateOwnership(appName: string, key: string): Promise<void>;
  ensureModalImage(request: ModalImageRequest): Promise<string>;
  close(): void;
  observe(request: {
    sandboxId: string;
    appName: string;
    key: string;
    debug?: boolean;
  }): Promise<{ running: boolean; expiresAt: number | null }>;
  create(request: ModalSandboxCreateRequest): Promise<ModalSandboxHandle>;
  deleteSnapshot(imageId: string): Promise<void>;
  fromId(
    sandboxId: string,
    expectedKey?: string,
    debug?: boolean,
  ): Promise<ModalSandboxHandle | null>;
  fromName(appName: string, name: string): Promise<ModalSandboxHandle | null>;
  listByKey(key: string): AsyncIterable<ModalSandboxHandle>;
}

export class ModalOwnershipError extends Error {}

export function readModalOwnershipTagsV1(
  value: unknown,
  expectedKey?: string,
  expectedDebug = false,
) {
  const parsed = z.record(z.string(), z.string()).safeParse(value);

  if (!parsed.success)
    throw new ModalOwnershipError("Malformed Modal ownership tags");
  const tags = parsed.data;
  const machineKey = tags.omnyoMachineKey ?? null;
  const debugValue = tags.omnyoDebug ?? null;

  if (
    machineKey === "" ||
    (debugValue !== null && debugValue !== "true" && debugValue !== "false") ||
    (debugValue !== null && machineKey === null)
  )
    throw new ModalOwnershipError("Malformed Modal ownership tags");

  if (
    expectedKey !== undefined &&
    (machineKey !== expectedKey || (debugValue === "true") !== expectedDebug)
  )
    throw new ModalOwnershipError("Foreign Modal sandbox ownership");

  return { machineKey, debug: debugValue === "true", tags };
}

export interface ModalCredentials {
  tokenId: string;
  tokenSecret: string;
}

export type ModalSandboxClientFactory = (
  credentials: ModalCredentials,
) => ModalSandboxClient;

async function collectOutput(
  stream: AsyncIterable<string>,
  maxBytes: number | undefined,
  onOutput: ((chunk: string) => void) | undefined,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  for await (const chunk of stream) {
    onOutput?.(chunk);
    const data = Buffer.from(chunk);
    const remaining = (maxBytes ?? Number.POSITIVE_INFINITY) - size;

    if (data.length > remaining) truncated = true;

    if (remaining > 0) {
      const kept = data.subarray(0, remaining);
      chunks.push(kept);
      size += kept.length;
    }
  }

  return (
    Buffer.concat(chunks).toString("utf8") +
    (truncated ? "\n[output truncated]" : "")
  );
}

function wrapSandbox(sandbox: Sandbox): ModalSandboxHandle {
  return {
    sandboxId: sandbox.sandboxId,
    async exec(command, options) {
      options.signal.throwIfAborted();
      let onAbort: () => void = () => {};

      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        return await Promise.race([
          aborted,
          (async () => {
            const process = await sandbox.exec([...command], {
              mode: "text",
              stdout: "pipe",
              stderr: "pipe",
              timeoutMs: Math.max(
                1000,
                Math.floor(options.timeoutMs / 1000) * 1000,
              ),
            });

            const input = async () => {
              try {
                options.signal.throwIfAborted();

                if (options.stdin !== undefined) {
                  await process.stdin.writeText(options.stdin);
                }
              } finally {
                await process.stdin.close();
              }
            };

            const [stdout, stderr, exitCode] = await Promise.all([
              collectOutput(
                process.stdout,
                options.maxOutputBytes,
                options.onOutput,
              ),
              collectOutput(
                process.stderr,
                options.maxOutputBytes,
                options.onOutput,
              ),
              process.wait(),
              input(),
            ]);

            return { exitCode, stdout, stderr };
          })(),
        ]);
      } finally {
        options.signal.removeEventListener("abort", onAbort);
      }
    },
    async terminate() {
      await sandbox.terminate();
    },
    async snapshotFilesystem(options) {
      const image = await sandbox.snapshotFilesystem({
        ...options,
        timeoutMs: Math.max(1000, Math.floor(options.timeoutMs / 1000) * 1000),
      });

      return image.imageId;
    },
  };
}

export const createModalSandboxClient: ModalSandboxClientFactory = (
  credentials,
) => {
  const client = new ModalClient({
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
  });

  async function ownedInApp(appName: string, key: string, debug = false) {
    const app = await client.apps.fromName(appName);

    const sandboxes: Awaited<
      ReturnType<typeof client.cpClient.sandboxList>
    >["sandboxes"] = [];

    let beforeTimestamp: number | undefined;

    for (;;) {
      const page = await client.cpClient.sandboxList({
        appId: app.appId,
        beforeTimestamp,
        environmentName: client.environmentName(),
        includeFinished: false,
        tags: [{ tagName: "omnyoMachineKey", tagValue: key }],
      });

      const last = page.sandboxes.at(-1);

      if (last === undefined) break;

      if (
        !Number.isFinite(last.createdAt) ||
        last.createdAt <= 0 ||
        (beforeTimestamp !== undefined && last.createdAt >= beforeTimestamp)
      )
        throw new ModalOwnershipError("Malformed Modal sandbox pagination");
      sandboxes.push(...page.sandboxes);
      beforeTimestamp = last.createdAt;
    }

    const ids = new Set<string>();

    for (const sandbox of sandboxes) {
      const tagNames = new Set<string>();

      for (const tag of sandbox.tags) {
        if (tagNames.has(tag.tagName))
          throw new ModalOwnershipError("Duplicate Modal sandbox tag");
        tagNames.add(tag.tagName);
      }

      const tags = Object.fromEntries(
        sandbox.tags.map((tag) => [tag.tagName, tag.tagValue]),
      );

      readModalOwnershipTagsV1(tags, key, debug);

      if (
        sandbox.appId !== app.appId ||
        sandbox.name !== key ||
        ids.has(sandbox.id)
      )
        throw new ModalOwnershipError(
          "Ambiguous or foreign Modal sandbox identity",
        );
      ids.add(sandbox.id);
    }

    if (sandboxes.length > 1)
      throw new ModalOwnershipError(
        "Multiple Modal sandboxes own the same managed name",
      );

    return sandboxes;
  }

  async function fromId(
    sandboxId: string,
    expectedKey?: string,
    debug = false,
  ) {
    try {
      const sandbox = await client.sandboxes.fromId(sandboxId);

      if ((await sandbox.poll()) !== null) return null;

      if (expectedKey !== undefined)
        readModalOwnershipTagsV1(await sandbox.getTags(), expectedKey, debug);

      return wrapSandbox(sandbox);
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        (error instanceof Error &&
          error.name === "ClientError" &&
          "code" in error &&
          error.code === Status.NOT_FOUND)
      )
        return null;
      throw error;
    }
  }

  return {
    close: () => client.close(),
    async validateOwnership(appName, key) {
      try {
        await ownedInApp(appName, key);
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
    },
    ensureModalImage: (request) => ensureModalImage(credentials, request),
    async accountIdentity() {
      const identity = z
        .object({ workspaceId: z.string().min(1) })
        .parse(await client.cpClient.tokenInfoGet({}));

      return createHash("sha256").update(identity.workspaceId).digest("hex");
    },
    async observe(request) {
      const sandbox = (
        await ownedInApp(request.appName, request.key, request.debug ?? false)
      ).find((candidate) => candidate.id === request.sandboxId);

      if (sandbox === undefined) return { running: false, expiresAt: null };

      const expiresAt = Math.floor(
        (sandbox.createdAt + sandbox.timeoutSecs) * 1000,
      );

      if (!Number.isFinite(expiresAt) || sandbox.timeoutSecs <= 0)
        throw new Error("Modal did not report a finite sandbox deadline");

      return { running: true, expiresAt };
    },
    async create(request) {
      const ownership = readModalOwnershipTagsV1(request.tags);

      if (
        ownership.machineKey !== null &&
        ownership.machineKey !== request.name
      )
        throw new ModalOwnershipError(
          "Modal managed name does not match its ownership key",
        );

      const app = await client.apps.fromName(request.appName, {
        createIfMissing: true,
      });

      const image = await client.images.fromId(request.image.imageId);

      const sandbox = await client.sandboxes.create(app, image, {
        name: request.name,
        timeoutMs: request.timeoutMs,
        tags: ownership.tags,
        env: {},
        ...(request.cpu === null ? {} : { cpu: request.cpu }),
        ...(request.memoryMiB === null ? {} : { memoryMiB: request.memoryMiB }),
      });

      return wrapSandbox(sandbox);
    },
    async deleteSnapshot(imageId) {
      try {
        await client.images.delete(imageId);
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
    },
    fromId,
    async *listByKey(key) {
      const sandboxes: Sandbox[] = [];

      for await (const sandbox of client.sandboxes.list({
        tags: { omnyoMachineKey: key },
      }))
        sandboxes.push(sandbox);

      const ids = new Set<string>();

      for (let index = 0; index < sandboxes.length; index += 4) {
        await Promise.all(
          sandboxes.slice(index, index + 4).map(async (sandbox) => {
            readModalOwnershipTagsV1(await sandbox.getTags(), key);

            if (ids.has(sandbox.sandboxId))
              throw new ModalOwnershipError(
                "Ambiguous Modal sandbox ownership",
              );
            ids.add(sandbox.sandboxId);
          }),
        );
      }

      for (const sandbox of sandboxes) yield wrapSandbox(sandbox);
    },
    async fromName(appName, name) {
      try {
        const sandbox = (await ownedInApp(appName, name))[0];

        return sandbox === undefined ? null : fromId(sandbox.id, name);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  };
};
