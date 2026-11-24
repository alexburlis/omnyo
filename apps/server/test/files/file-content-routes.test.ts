import { createHash } from "node:crypto";
import {
  HOST_FILE_CHUNK_MAX_BYTES,
  type HostDaemonOnlineRpcRequestMessage,
} from "@omnyo/host-daemon-contract";
import { hostDaemonSessions } from "@omnyo/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { storeAttachment } from "../../src/services/projects/attachments.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  animatedPng,
  jpegWithExtraneousScanBytes,
  solidPng,
} from "../helpers/image-fixtures.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness as TestHarness,
} from "../helpers/test-app.js";

type HostCommand = HostDaemonOnlineRpcRequestMessage["command"];

interface HostFile {
  bytes: Buffer;
  mimeType: string;
}

const REVISION = "0".repeat(64);

function serveFiles(
  harness: TestHarness,
  args: {
    hostId: string;
    sessionId: string;
    files: Map<string, HostFile>;
  },
): HostCommand[] {
  const commands: HostCommand[] = [];
  registerHostRpcResponder(harness, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    handle: ({ command }) => {
      commands.push(command);

      if (command.type !== "host.read_file_chunk") {
        throw new Error(`Unexpected command ${command.type}`);
      }

      const file = args.files.get(command.path);

      if (!file) {
        return {
          ok: false,
          errorCode: "ENOENT",
          errorMessage: `Path does not exist: ${command.path}`,
        };
      }

      return {
        ok: true,
        result: {
          path: command.path,
          content: file.bytes.subarray(
            command.offset,
            command.offset + command.length,
          ),
          offset: command.offset,
          mimeType: file.mimeType,
          modifiedAtMs: 1234,
          sizeBytes: file.bytes.length,
          revision: REVISION,
        },
      };
    },
  });

  return commands;
}

describe("file content routes", () => {
  it.each(["workspace", "thread-storage"])(
    "streams Windows %s HTML and sibling scripts without allowing escapes",
    async (source) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread, environment } = seedThreadFixture(
          harness,
          {
            session: { platform: "win32" },
            environment: { path: "D:\\workspace" },
          },
        );

        harness.db
          .update(hostDaemonSessions)
          .set({ dataDir: "C:\\Users\\pc\\.omnyo" })
          .where(eq(hostDaemonSessions.id, session.id))
          .run();

        const root =
          source === "workspace"
            ? "D:\\workspace"
            : `C:\\Users\\pc\\.omnyo\\thread-storage\\${thread.id}`;

        const html = '<script src="sounds.js"></script>';
        const script = 'document.body.dataset.loaded = "yes";';

        const commands = serveFiles(harness, {
          hostId: host.id,
          sessionId: session.id,
          files: new Map([
            [
              `${root}\\player\\listen.html`,
              { bytes: Buffer.from(html), mimeType: "text/html" },
            ],
            [
              `${root}\\player\\sounds.js`,
              { bytes: Buffer.from(script), mimeType: "text/javascript" },
            ],
          ]),
        });

        const base =
          source === "workspace"
            ? `/api/v1/environments/${environment.id}/files`
            : `/api/v1/threads/${thread.id}/thread-storage/files`;

        const pageUrl = `http://localhost${base}/player/listen.html`;
        const page = await harness.app.request(pageUrl);

        expect(page.status).toBe(200);
        await expect(page.text()).resolves.toBe(html);

        const asset = await harness.app.request(
          new URL("sounds.js", pageUrl).href,
        );

        expect(asset.status).toBe(200);
        await expect(asset.text()).resolves.toBe(script);
        expect(
          commands.every(
            (command) =>
              command.type === "host.read_file_chunk" &&
              command.rootPath === root,
          ),
        ).toBe(true);

        const count = commands.length;

        const escape = await harness.app.request(
          `${base}/player/..%5C..%5Csecret.js`,
        );

        expect(escape.status).toBe(400);
        expect(commands).toHaveLength(count);
      });
    },
  );

  it.each([
    ["svg", "image/svg+xml"],
    ["xhtml", "application/xhtml+xml"],
  ])("sends a sandbox policy for %s documents", async (extension, mimeType) => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const bytes = Buffer.from("<script>alert(document.domain)</script>");
      serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([[`/tmp/probe.${extension}`, { bytes, mimeType }]]),
      });
      const url = `/api/v1/threads/${thread.id}/host-files/tmp/probe.${extension}`;

      for (const headers of [
        new Headers(),
        new Headers({ range: "bytes=0-15" }),
      ]) {
        const response = await harness.app.request(url, { headers });
        expect(response.status).toBe(headers.has("range") ? 206 : 200);
        expect(response.headers.get("content-type")).toBe(mimeType);
        expect(response.headers.get("content-security-policy")).toBe(
          "sandbox allow-scripts",
        );
        await response.arrayBuffer();
      }
    });
  });

  it("streams thread storage with ranges and sandboxed HTML", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const storageRoot = `/tmp/omnyo-host-data/${host.id}/thread-storage/${thread.id}`;

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            `${storageRoot}/clip.mp4`,
            { bytes: Buffer.from([0, 1, 2, 3, 4, 5]), mimeType: "video/mp4" },
          ],
          [
            `${storageRoot}/reports/preview v2.html`,
            {
              bytes: Buffer.from("<!doctype html><h1>Preview</h1>"),
              mimeType: "text/html",
            },
          ],
        ]),
      });

      const baseUrl = `/api/v1/threads/${thread.id}/thread-storage/files`;

      const clip = await harness.app.request(`${baseUrl}/clip.mp4`, {
        headers: { Range: "bytes=0-1" },
      });

      expect(clip.status).toBe(206);
      expect(clip.headers.get("content-range")).toBe("bytes 0-1/6");
      expect(Buffer.from(await clip.arrayBuffer())).toEqual(
        Buffer.from([0, 1]),
      );

      const html = await harness.app.request(
        `${baseUrl}/reports/preview%20v2.html`,
      );

      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(html.headers.get("cache-control")).toBe("no-store");
      await expect(html.text()).resolves.toContain("<h1>Preview</h1>");

      expect(
        new Set(
          commands.map((command) =>
            command.type === "host.read_file_chunk" ? command.rootPath : null,
          ),
        ),
      ).toEqual(new Set([storageRoot]));
    });
  });

  it("reads the first image bytes with metadata and revalidates without reading content", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);

      const files = new Map<string, HostFile>([
        [
          "/small.jpg",
          { bytes: Buffer.from([0, 1, 255]), mimeType: "image/jpeg" },
        ],
        [
          "/large.png",
          {
            bytes: Buffer.alloc(HOST_FILE_CHUNK_MAX_BYTES + 1, 129),
            mimeType: "image/png",
          },
        ],
      ]);

      const calls = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files,
      });

      for (const [path, file] of files) {
        const url = `/api/v1/threads/${thread.id}/host-files${path}`;
        const response = await harness.app.request(url);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(file.bytes);
        expect(chunkLengths(calls, path)).toEqual(
          file.bytes.length > HOST_FILE_CHUNK_MAX_BYTES
            ? [HOST_FILE_CHUNK_MAX_BYTES, 1]
            : [HOST_FILE_CHUNK_MAX_BYTES],
        );
        const previous = calls.length;

        const cached = await harness.app.request(url, {
          headers: { "if-none-match": response.headers.get("etag")! },
        });

        expect(cached.status).toBe(304);
        expect(chunkLengths(calls.slice(previous), path)).toEqual([0]);
      }
    });
  });

  it("reports file changes before streaming as retryable conflicts", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type !== "host.read_file_chunk") {
            throw new Error("Unexpected command");
          }

          if (command.length !== 0) {
            return {
              ok: false,
              errorCode: "file_changed",
              errorMessage: "File changed",
            };
          }

          return {
            ok: true,
            result: {
              path: command.path,
              content: Buffer.alloc(0),
              offset: 0,
              sizeBytes: 30 * 1024 * 1024,
              mimeType: "video/mp4",
              modifiedAtMs: 1234,
              revision: REVISION,
            },
          };
        },
      });
      const baseUrl = `/api/v1/threads/${thread.id}/thread-storage/files`;

      const response = await harness.app.request(`${baseUrl}/clip.mp4`);

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "file_changed",
        retryable: true,
      });
    });
  });

  it("serves HTML larger than the preview render limit as sandboxed bytes", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const storageRoot = `/tmp/omnyo-host-data/${host.id}/thread-storage/${thread.id}`;
      const html = Buffer.alloc(6 * 1024 * 1024, "a");
      serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [`${storageRoot}/large.html`, { bytes: html, mimeType: "text/html" }],
        ]),
      });
      const baseUrl = `/api/v1/threads/${thread.id}/thread-storage/files`;

      const response = await harness.app.request(`${baseUrl}/large.html`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.arrayBuffer()).byteLength).toBe(html.length);
    });
  });

  it("reads thread host files from the filesystem root without a ready environment", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness, {
        environment: { status: "provisioning" },
      });

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            "/Users/me/notes/plan.md",
            { bytes: Buffer.from("# Plan\n"), mimeType: "text/markdown" },
          ],
        ]),
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/Users/me/notes/plan.md`,
      );

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("# Plan\n");
      expect(commands[0]).toMatchObject({
        type: "host.read_file_chunk",
        path: "/Users/me/notes/plan.md",
        rootPath: "/",
      });
    });
  });

  it("refuses thread host files for a thread without an environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/tmp/x.bin`,
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "thread_environment_unavailable",
        details: { reason: "never_attached" },
      });
    });
  });

  it.each([
    { errorCode: "invalid_path", expectedStatus: 400 },
    { errorCode: "ENOENT", expectedStatus: 404 },
  ])(
    "maps daemon $errorCode failures on file reads to $expectedStatus",
    async ({ errorCode, expectedStatus }) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedThreadFixture(harness);
        registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => ({
            ok: false,
            errorCode,
            errorMessage: "Read failed",
          }),
        });

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/host-files/tmp/x.bin`,
        );

        expect(response.status).toBe(expectedStatus);
        await expect(readJson(response)).resolves.toMatchObject({
          code: errorCode,
        });
      });
    },
  );

  it("reads working-tree files by chunk and git revisions in one read", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, environment } = seedThreadFixture(harness, {
        environment: { path: "/tmp/lease-env" },
      });

      const commands: HostCommand[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          commands.push(command);

          if (command.type === "host.read_file") {
            const metadata = {
              path: command.path,
              contentEncoding: "base64" as const,
              mimeType: "application/octet-stream",
              sizeBytes: 4,
              sha256: "a".repeat(64),
            };

            if (
              command.ifNoneMatch?.kind === "any" ||
              command.ifNoneMatch?.values.includes(metadata.sha256)
            ) {
              return {
                ok: true,
                result: { ...metadata, notModified: true },
              };
            }

            return {
              ok: true,
              result: {
                ...metadata,
                content: Buffer.from([0, 1, 2, 255]).toString("base64"),
              },
            };
          }

          if (command.type !== "host.read_file_chunk") {
            throw new Error(`Unexpected command ${command.type}`);
          }

          const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);

          return {
            ok: true,
            result: {
              path: command.path,
              content: bytes.subarray(
                command.offset,
                command.offset + command.length,
              ),
              offset: command.offset,
              mimeType: "application/zip",
              modifiedAtMs: 1234,
              sizeBytes: bytes.length,
              revision: REVISION,
            },
          };
        },
      });

      const zip = await harness.app.request(
        `/api/v1/environments/${environment.id}/files/dist/app.zip`,
        {
          headers: { Range: "bytes=0-3" },
        },
      );

      expect(zip.status).toBe(206);
      expect(zip.headers.get("content-range")).toBe("bytes 0-3/8");
      expect(commands.at(-1)).toMatchObject({
        type: "host.read_file_chunk",
        path: "/tmp/lease-env/dist/app.zip",
        rootPath: "/tmp/lease-env",
      });

      const head = `/api/v1/environments/${environment.id}/revisions/HEAD/files`;

      const revisionCommand = {
        type: "host.read_file",
        path: "/tmp/lease-env/logo.bin",
        rootPath: "/tmp/lease-env",
        ref: "HEAD",
      };

      const logo = await harness.app.request(`${head}/logo.bin`);
      expect(logo.status).toBe(200);
      expect(Buffer.from(await logo.arrayBuffer())).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      expect(commands.at(-1)).toEqual(revisionCommand);

      const revalidated = await harness.app.request(`${head}/logo.bin`, {
        headers: { "if-none-match": `"${"a".repeat(64)}"` },
      });

      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
      expect(revalidated.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
      expect(commands.at(-1)).toEqual({
        ...revisionCommand,
        ifNoneMatch: { kind: "sha256", values: ["a".repeat(64)] },
      });

      const weaklyRevalidated = await harness.app.request(`${head}/logo.bin`, {
        headers: { "if-none-match": `W/"${"a".repeat(64)}"` },
      });

      expect(weaklyRevalidated.status).toBe(304);
      expect(commands.at(-1)).toEqual({
        ...revisionCommand,
        ifNoneMatch: { kind: "sha256", values: ["a".repeat(64)] },
      });

      const wildcard = await harness.app.request(`${head}/logo.bin`, {
        headers: { "if-none-match": "*" },
      });

      expect(wildcard.status).toBe(304);
      expect(commands.at(-1)).toEqual({
        ...revisionCommand,
        ifNoneMatch: { kind: "any" },
      });

      const stale = await harness.app.request(`${head}/logo.bin`, {
        headers: { "if-none-match": '"stale"' },
      });

      expect(stale.status).toBe(200);
      expect(Buffer.from(await stale.arrayBuffer())).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      expect("ifNoneMatch" in (commands.at(-1) ?? {})).toBe(false);
      expect(commands.at(-1)).toEqual(revisionCommand);

      const optionRef = await harness.app.request(
        `/api/v1/environments/${environment.id}/revisions/--output=x/files/logo.bin`,
      );

      expect(optionRef.status).toBe(400);
      await expect(readJson(optionRef)).resolves.toMatchObject({
        code: "invalid_ref",
      });
    });
  });

  it("reads project files from the primary host source or a named host", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/primary/project",
      });

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            "/primary/project/qa/report.zip",
            { bytes: Buffer.from([1, 2, 3]), mimeType: "application/zip" },
          ],
        ]),
      });

      const primary = await harness.app.request(
        `/api/v1/projects/${project.id}/files/qa/report.zip`,
      );

      expect(Buffer.from(await primary.arrayBuffer())).toEqual(
        Buffer.from([1, 2, 3]),
      );

      const named = await harness.app.request(
        `/api/v1/projects/${project.id}/hosts/${host.id}/files/qa/report.zip`,
      );

      expect(Buffer.from(await named.arrayBuffer())).toEqual(
        Buffer.from([1, 2, 3]),
      );
      expect(
        commands.map((command) =>
          command.type === "host.read_file_chunk" ? command.rootPath : null,
        ),
      ).toEqual(Array(commands.length).fill("/primary/project"));
    });
  });

  it("maps Windows drive paths to the drive root and rejects backslash traversal", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            "C:\\Users\\me\\chart.png",
            { bytes: Buffer.from([7, 8]), mimeType: "image/png" },
          ],
        ]),
      });

      const chart = await harness.app.request(
        `/api/v1/hosts/${host.id}/files/C%3A/Users/me/chart.png`,
      );

      expect(chart.status).toBe(200);
      expect(commands[0]).toMatchObject({
        path: "C:\\Users\\me\\chart.png",
        rootPath: "C:\\",
      });

      const commandCount = commands.length;

      const traversal = await harness.app.request(
        `/api/v1/hosts/${host.id}/files/tmp/..%5Cetc/passwd`,
      );

      expect(traversal.status).toBe(400);
      expect(commands).toHaveLength(commandCount);
    });
  });
});

const THUMBNAIL_TAG = `W/"file-${REVISION}-w960-t1"`;

const ORIGINAL_TAG = `W/"file-${REVISION}"`;

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function imagePattern(width: number, height: number): Promise<Buffer> {
  const bytes = Buffer.alloc(width * height * 4);

  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = (offset / 4) % 251;
    bytes[offset + 1] = Math.floor(offset / (width * 4)) % 253;
    bytes[offset + 2] = Math.floor(offset / 16) % 247;
    bytes[offset + 3] = 255;
  }

  return sharp(bytes, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function profiledPattern(width: number, height: number) {
  return sharp(await imagePattern(width, height))
    .withIccProfile("p3")
    .png()
    .toBuffer();
}

function chunkLengths(commands: HostCommand[], path: string): number[] {
  return commands.flatMap((command) =>
    command.type === "host.read_file_chunk" && command.path === path
      ? [command.length]
      : [],
  );
}

function settleWithin<T>(
  ms: number,
  promise: T | Promise<T>,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function thumbnailWarnings(warn: ReturnType<typeof vi.fn>) {
  return warn.mock.calls.filter(
    ([, message]) =>
      message === "Image thumbnail could not be prepared; serving the original",
  );
}

async function expectExactOriginal(
  response: Response,
  file: HostFile,
  entityTag: string,
) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(file.mimeType);
  expect(response.headers.get("etag")).toBe(entityTag);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe(
    "sandbox allow-scripts",
  );
  expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(
    digest(file.bytes),
  );
}

describe("thread host-file thumbnails", () => {
  it("serves a pixel-exact lossless 960 derivative beside the exact original", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const path = "/tmp/thumbnails/exact.png";

      const file = {
        bytes: await imagePattern(2048, 1024),
        mimeType: "image/png",
      };

      serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([[path, file]]),
      });

      const url = `/api/v1/threads/${thread.id}/host-files${path}`;

      await expectExactOriginal(
        await harness.app.request(url),
        file,
        ORIGINAL_TAG,
      );

      const thumbnail = await harness.app.request(`${url}?thumbnailWidth=960`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get("content-type")).toBe("image/webp");
      expect(thumbnail.headers.get("etag")).toBe(THUMBNAIL_TAG);
      expect(thumbnail.headers.get("accept-ranges")).toBeNull();
      expect(thumbnail.headers.get("x-content-type-options")).toBe("nosniff");
      expect(thumbnail.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      const bytes = Buffer.from(await thumbnail.arrayBuffer());
      expect(thumbnail.headers.get("content-length")).toBe(
        String(bytes.length),
      );
      expect(bytes.length).toBeLessThan(file.bytes.length);

      const preview = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const expected = await sharp(file.bytes)
        .resize({ width: 960 })
        .ensureAlpha()
        .raw()
        .toBuffer();

      expect(preview.info).toMatchObject({
        width: 960,
        height: 480,
        channels: 4,
      });
      expect(digest(preview.data)).toBe(digest(expected));
    });
  });

  it("reads a host image once for concurrent requests and serves repeats from memory", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const path = "/tmp/thumbnails/shared.png";
      const bytes = await imagePattern(1200, 600);
      expect(bytes.length).toBeGreaterThan(HOST_FILE_CHUNK_MAX_BYTES);

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([[path, { bytes, mimeType: "image/png" }]]),
      });

      const url = `/api/v1/threads/${thread.id}/host-files${path}?thumbnailWidth=960`;

      const [first, second] = await Promise.all([
        harness.app.request(url),
        harness.app.request(url),
      ]);

      expect(first.headers.get("content-type")).toBe("image/webp");
      const thumbnail = digest(new Uint8Array(await first.arrayBuffer()));
      expect(digest(new Uint8Array(await second.arrayBuffer()))).toBe(
        thumbnail,
      );
      expect(
        chunkLengths(commands, path).filter((length) => length > 0),
      ).toHaveLength(Math.ceil(bytes.length / HOST_FILE_CHUNK_MAX_BYTES));

      const count = commands.length;
      const third = await harness.app.request(url);
      expect(digest(new Uint8Array(await third.arrayBuffer()))).toBe(thumbnail);
      expect(chunkLengths(commands.slice(count), path)).toEqual([0]);
      expect(commands).toHaveLength(count + 1);
    });
  });

  it("revalidates derivative and original outcomes with one metadata read after the server forgets them", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);

      const fixtures = [
        {
          path: "/tmp/thumbnails/revalidate-plain.png",
          bytes: await imagePattern(1200, 600),
        },
        {
          path: "/tmp/thumbnails/revalidate-profiled.png",
          bytes: await profiledPattern(1200, 600),
        },
        {
          path: "/tmp/thumbnails/revalidate-narrow.png",
          bytes: await imagePattern(512, 256),
        },
      ];

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map(
          fixtures.map(({ path, bytes }) => [
            path,
            { bytes, mimeType: "image/png" },
          ]),
        ),
      });

      for (const { path } of fixtures) {
        const count = commands.length;

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/host-files${path}?thumbnailWidth=960`,
          { headers: { "if-none-match": THUMBNAIL_TAG } },
        );

        expect(response.status).toBe(304);
        expect(response.headers.get("etag")).toBe(THUMBNAIL_TAG);
        expect(response.headers.get("content-type")).toBeNull();
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        expect(chunkLengths(commands.slice(count), path)).toEqual([0]);
        expect(commands).toHaveLength(count + 1);
      }
    });
  });

  it("keeps colour profiles in derivatives and serves exact originals where resizing would lose detail", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const profiled = await profiledPattern(1200, 600);
      const frames = Buffer.alloc(1024 * 256 * 4, 255);
      frames.fill(0, 1024 * 128 * 4);

      const originals = [
        {
          path: "/tmp/thumbnails/high-depth.png",
          bytes: await sharp(await imagePattern(1024, 64))
            .toColourspace("rgb16")
            .png()
            .toBuffer(),
          mimeType: "image/png",
          entityTag: THUMBNAIL_TAG,
        },
        {
          path: "/tmp/thumbnails/animated.webp",
          bytes: await sharp(frames, {
            raw: { width: 1024, height: 256, channels: 4, pageHeight: 128 },
          })
            .webp({ lossless: true, loop: 0, delay: [80, 80] })
            .toBuffer(),
          mimeType: "image/webp",
          entityTag: THUMBNAIL_TAG,
        },
        {
          path: "/tmp/thumbnails/narrow.png",
          bytes: await imagePattern(960, 480),
          mimeType: "image/png",
          entityTag: THUMBNAIL_TAG,
        },
        {
          path: "/tmp/thumbnails/animated.png",
          bytes: await animatedPng(1024, 64),
          mimeType: "image/png",
          entityTag: THUMBNAIL_TAG,
        },
        {
          path: "/tmp/thumbnails/taller-than-webp.png",
          bytes: await solidPng(980, 17_000),
          mimeType: "image/png",
          entityTag: THUMBNAIL_TAG,
        },
        {
          path: "/tmp/thumbnails/vector.svg",
          bytes: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="10"/>',
          ),
          mimeType: "image/svg+xml",
          entityTag: ORIGINAL_TAG,
        },
      ];

      expect((await sharp(originals[0]?.bytes).metadata()).depth).toBe(
        "ushort",
      );
      expect((await sharp(originals[1]?.bytes).metadata()).pages).toBe(2);

      serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            "/tmp/thumbnails/profiled.png",
            { bytes: profiled, mimeType: "image/png" },
          ],
          ...originals.map(
            ({ path, ...file }) => [path, file] as [string, HostFile],
          ),
        ]),
      });

      const url = (path: string) =>
        `/api/v1/threads/${thread.id}/host-files${path}?thumbnailWidth=960`;

      const derivative = await harness.app.request(
        url("/tmp/thumbnails/profiled.png"),
      );

      expect(derivative.status).toBe(200);
      expect(derivative.headers.get("content-type")).toBe("image/webp");
      expect(derivative.headers.get("etag")).toBe(THUMBNAIL_TAG);
      const bytes = Buffer.from(await derivative.arrayBuffer());
      const profile = (await sharp(profiled).metadata()).icc;
      expect(profile).toBeInstanceOf(Buffer);
      expect((await sharp(bytes).metadata()).icc).toEqual(profile);

      const preview = await sharp(bytes, { ignoreIcc: true })
        .ensureAlpha()
        .raw()
        .toBuffer();

      const expected = await sharp(profiled, { ignoreIcc: true })
        .autoOrient()
        .resize({ width: 960, withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer();

      expect(digest(preview)).toBe(digest(expected));

      const warn = vi.fn();
      harness.deps.logger.warn = warn;

      for (const { path, entityTag, ...file } of originals) {
        await expectExactOriginal(
          await harness.app.request(url(path)),
          file,
          entityTag,
        );
      }

      expect(thumbnailWarnings(warn)).toEqual([]);
    });
  });

  it("serves and remembers the exact original when an image cannot be decoded for resizing", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      const path = "/tmp/thumbnails/extraneous.jpg";

      const file = {
        bytes: await jpegWithExtraneousScanBytes(await imagePattern(1024, 256)),
        mimeType: "image/jpeg",
      };

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([[path, file]]),
      });

      const warn = vi.fn();
      harness.deps.logger.warn = warn;
      const url = `/api/v1/threads/${thread.id}/host-files${path}?thumbnailWidth=960`;

      await expectExactOriginal(
        await harness.app.request(url),
        file,
        THUMBNAIL_TAG,
      );
      expect(thumbnailWarnings(warn)).toEqual([
        [
          expect.objectContaining({
            errorMessage: expect.stringContaining("Corrupt JPEG data"),
            thumbnailWidth: 960,
          }),
          expect.any(String),
        ],
      ]);

      const count = commands.length;

      await expectExactOriginal(
        await harness.app.request(url),
        file,
        THUMBNAIL_TAG,
      );

      const [metadataLength, ...lengths] = chunkLengths(
        commands.slice(count),
        path,
      );

      expect(metadataLength).toBe(0);
      expect(lengths).toHaveLength(
        Math.ceil(file.bytes.length / HOST_FILE_CHUNK_MAX_BYTES),
      );
      expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(
        file.bytes.length,
      );
      expect(thumbnailWarnings(warn)).toHaveLength(1);
    });
  });

  it("serves empty images as empty originals and rejects unsupported widths before reading", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);

      const commands = serveFiles(harness, {
        hostId: host.id,
        sessionId: session.id,
        files: new Map([
          [
            "/tmp/thumbnails/empty.png",
            { bytes: Buffer.alloc(0), mimeType: "image/png" },
          ],
        ]),
      });

      const base = `/api/v1/threads/${thread.id}/host-files/tmp/thumbnails/empty.png`;

      const empty = await harness.app.request(`${base}?thumbnailWidth=960`);
      expect(empty.status).toBe(200);
      expect(empty.headers.get("etag")).toBe(ORIGINAL_TAG);
      expect((await empty.arrayBuffer()).byteLength).toBe(0);

      const count = commands.length;
      const invalid = await harness.app.request(`${base}?thumbnailWidth=123`);
      expect(invalid.status).toBe(400);
      expect(commands).toHaveLength(count);
    });
  });

  it("keeps project attachment thumbnails flowing while a host read is stalled", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread, project } = seedThreadFixture(harness);
      const bytes = await imagePattern(1200, 600);
      const stalled = createDeferredPromise<void>();
      const released = createDeferredPromise<void>();
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async ({ command }) => {
          if (command.type !== "host.read_file_chunk") {
            throw new Error(`Unexpected command ${command.type}`);
          }

          if (command.length > 0 && command.offset === 0) {
            stalled.resolve();
            await released.promise;
          }

          return {
            ok: true,
            result: {
              path: command.path,
              content: bytes.subarray(
                command.offset,
                command.offset + command.length,
              ),
              offset: command.offset,
              mimeType: "image/png",
              modifiedAtMs: 1234,
              sizeBytes: bytes.length,
              revision: REVISION,
            },
          };
        },
      });

      const hostThumbnail = harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/tmp/thumbnails/stalled.png?thumbnailWidth=960`,
      );

      await stalled.promise;

      const uploaded = await storeAttachment(
        harness.db,
        harness.deps.config.dataDir,
        project.id,
        new File([new Uint8Array(await imagePattern(512, 256))], "lane.png", {
          type: "image/png",
        }),
      );

      const attachment = await settleWithin(
        2000,
        harness.app.request(
          `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}&thumbnailWidth=160`,
        ),
      );

      expect(attachment?.status).toBe(200);
      expect(attachment?.headers.get("content-type")).toBe("image/webp");

      released.resolve();
      const response = await hostThumbnail;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("etag")).toBe(THUMBNAIL_TAG);
    });
  });
});
