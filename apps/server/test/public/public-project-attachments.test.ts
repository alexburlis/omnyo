import { afterEach, describe, expect, it, vi } from "vitest";
import * as fileSystem from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  projectAttachments,
  projectAttachmentThreads,
  threads,
} from "@omnyo/db";
import {
  uploadedPromptAttachmentSchema,
  type AttachmentDiagnostic,
} from "@omnyo/server-contract";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThreadFixture,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

async function upload(
  app: {
    request(input: string, init?: RequestInit): Response | Promise<Response>;
  },
  projectId: string,
  file: File,
  extraField?: [string, string],
): Promise<Response> {
  const form = new FormData();
  form.set("file", file);

  if (extraField) form.set(...extraField);

  return app.request(`/api/v1/projects/${projectId}/attachments`, {
    body: form,
    method: "POST",
  });
}

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  return { ...actual, readFile: vi.fn(actual.readFile) };
});

afterEach(() => vi.restoreAllMocks());

describe("public project attachments", () => {
  it("retains existing attachments for a public cross-project owner and rejects invalid claims", async () => {
    await withTestHarness(async (harness) => {
      const owner = seedThreadFixture(harness);
      const source = seedThreadFixture(harness);
      expect(owner.project.id).not.toBe(source.project.id);

      const uploaded = uploadedPromptAttachmentSchema.parse(
        await readJson(
          await upload(
            harness.app,
            source.project.id,
            new File(["image"], "result.png", { type: "image/png" }),
          ),
        ),
      );

      const retain = (projectId: string, body: unknown) =>
        harness.app.request(
          `/api/v1/projects/${projectId}/attachments/retain`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );

      const valid = { threadId: owner.thread.id, paths: [uploaded.path] };

      for (const body of [
        { ...valid, paths: [uploaded.path, "missing.png"] },
        { ...valid, paths: ["../result.png"] },
        { ...valid, paths: Array.from({ length: 25 }, () => uploaded.path) },
        { ...valid, ignored: true },
      ]) {
        expect((await retain(source.project.id, body)).status).toBe(400);
        expect(
          harness.db.select().from(projectAttachmentThreads).all(),
        ).toEqual([]);
      }

      expect((await retain(owner.project.id, valid)).status).toBe(400);
      expect((await retain("missing-project", valid)).status).toBe(404);
      expect(
        (
          await retain(source.project.id, {
            ...valid,
            threadId: "missing-thread",
          })
        ).status,
      ).toBe(404);

      for (let count = 0; count < 2; count += 1) {
        const response = await retain(source.project.id, valid);
        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({ ok: true });
      }

      expect(
        harness.db.select().from(projectAttachmentThreads).all(),
      ).toHaveLength(1);
      harness.db
        .update(threads)
        .set({ deletedAt: Date.now() })
        .where(eq(threads.id, owner.thread.id))
        .run();
      expect((await retain(source.project.id, valid)).status).toBe(404);
    });
  });

  it("preserves text and binary bytes plus upload filename and MIME metadata", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachments",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const fixtures = [
        {
          bytes: new TextEncoder().encode("alpha\nβeta\n"),
          filename: "notes.txt",
          mimeType: "text/plain;charset=utf-8",
          type: "localFile" as const,
        },
        {
          bytes: new Uint8Array([0, 255, 1, 128, 13, 10]),
          filename: "payload.bin",
          mimeType: "application/x-omnyo-binary",
          type: "localFile" as const,
        },
      ];

      for (const fixture of fixtures) {
        const response = await upload(
          harness.app,
          project.id,
          new File([fixture.bytes], fixture.filename, {
            type: fixture.mimeType,
          }),
        );

        expect(response.status).toBe(201);

        const uploaded = uploadedPromptAttachmentSchema.parse(
          await readJson(response),
        );

        expect(uploaded).toMatchObject({
          type: fixture.type,
          sourceProjectId: project.id,
          name: fixture.filename,
          mimeType: fixture.mimeType,
          sizeBytes: fixture.bytes.byteLength,
        });

        const contentUrl = `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`;
        const content = await harness.app.request(contentUrl);
        expect(content.status).toBe(200);
        expect(new Uint8Array(await content.arrayBuffer())).toEqual(
          fixture.bytes,
        );
        expect(content.headers.get("cache-control")).toBe(
          "private, immutable, max-age=31536000",
        );
        expect(content.headers.get("content-length")).toBe(
          String(fixture.bytes.byteLength),
        );
        const etag = content.headers.get("etag");
        expect(etag).toMatch(/^"[^"]+"$/u);

        const read = vi.mocked(fileSystem.readFile);
        read.mockClear();

        const revalidated = await harness.app.request(contentUrl, {
          headers: { "if-none-match": etag ?? "" },
        });

        expect(
          read.mock.calls.some(([path]) =>
            String(path).endsWith(uploaded.path),
          ),
        ).toBe(false);
        read.mockClear();

        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.get("etag")).toBe(etag);
        expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
      }
    });
  });

  it("returns stable invalid_request envelopes for oversize and ambiguous forms", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachment-limits",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const retinaScreenshot = await upload(
        harness.app,
        project.id,
        new File([new Uint8Array(30 * 1024 * 1024)], "screenshot.png", {
          type: "image/png",
        }),
      );

      expect(retinaScreenshot.status).toBe(201);

      const oversized = await upload(
        harness.app,
        project.id,
        new File([new Uint8Array(36 * 1024 * 1024)], "huge.png", {
          type: "image/png",
        }),
      );

      expect(oversized.status).toBe(400);
      await expect(readJson(oversized)).resolves.toEqual({
        code: "invalid_request",
        message: "huge.png is 36MB, over the 35MB attachment limit",
      });

      const oversizedFile = await upload(
        harness.app,
        project.id,
        new File(
          [new Uint8Array(35 * 1024 * 1024 + 512 * 1024)],
          "huge-archive.bin",
          {
            type: "application/octet-stream",
          },
        ),
      );

      expect(oversizedFile.status).toBe(400);
      await expect(readJson(oversizedFile)).resolves.toEqual({
        code: "invalid_request",
        message: "huge-archive.bin is 35.5MB, over the 35MB attachment limit",
      });

      const ambiguous = await upload(
        harness.app,
        project.id,
        new File(["ok"], "ok.txt", { type: "text/plain" }),
        ["filename", "ignored.txt"],
      );

      expect(ambiguous.status).toBe(400);
      await expect(readJson(ambiguous)).resolves.toEqual({
        code: "invalid_request",
        message:
          'Attachment upload accepts exactly one multipart field named "file"',
      });
    });
  });

  it("rejects an empty or malformed multipart body as invalid_request", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachment-malformed",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      for (const body of ["", "not a multipart body"]) {
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/attachments`,
          {
            body,
            headers: {
              "content-type":
                "multipart/form-data; boundary=----WebKitFormBoundaryabc",
            },
            method: "POST",
          },
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
          code: "invalid_request",
          message: "Request body is not valid multipart form data",
        });
      }
    });
  });

  it("rejects HEIC/HEIF image uploads instead of storing an image nothing can render", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachment-heic",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const heicBytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
        0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
      ]);

      const rejected = {
        code: "invalid_request",
        message:
          "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.",
      };

      const heic = await upload(
        harness.app,
        project.id,
        new File([heicBytes], "IMG_0001.heic", { type: "image/heic" }),
      );

      expect(heic.status).toBe(400);
      await expect(readJson(heic)).resolves.toEqual(rejected);

      const heif = await upload(
        harness.app,
        project.id,
        new File([heicBytes], "IMG_0002.HEIF", {
          type: "Image/HEIF; charset=binary",
        }),
      );

      expect(heif.status).toBe(400);
      await expect(readJson(heif)).resolves.toEqual(rejected);

      const asFile = await upload(
        harness.app,
        project.id,
        new File([heicBytes], "IMG_0003.heic", {
          type: "application/octet-stream",
        }),
      );

      expect(asFile.status).toBe(201);
      expect(
        uploadedPromptAttachmentSchema.parse(await readJson(asFile)),
      ).toMatchObject({ type: "localFile", name: "IMG_0003.heic" });

      const stillAcceptsOtherImages = await upload(
        harness.app,
        project.id,
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "ok.png", {
          type: "image/png",
        }),
      );

      expect(stillAcceptsOtherImages.status).toBe(201);
    });
  });

  it("rejects and logs an empty upload without storing it", async () => {
    await withTestHarness(async (harness) => {
      const warn = vi.spyOn(harness.deps.logger, "warn");

      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachment-empty",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const response = await upload(
        harness.app,
        project.id,
        new File([], "image.png", { type: "image/png" }),
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toEqual({
        code: "attachment_empty",
        message: "The attachment arrived empty. Copy it again and paste.",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          mimeType: "image/png",
          extension: "png",
        }),
        "Rejected empty attachment upload",
      );
      expect(harness.db.select().from(projectAttachments).all()).toEqual([]);
    });
  });

  it("logs allowlisted attachment diagnostics and rejects content-bearing fields", async () => {
    await withTestHarness(async (harness) => {
      const warn = vi.spyOn(harness.deps.logger, "warn");

      const diagnostic: AttachmentDiagnostic = {
        occurredAt: Date.now() - 1000,
        clientBundle: "index-abc123.js",
        userAgentFamily: "desktop",
        cause: "empty_on_server",
        source: "paste",
        mimeType: "image/png",
        extension: "png",
        sizeAtUpload: 280_000,
        sizeAtPaste: 280_000,
        readableBytes: null,
        readError: "not_readable",
        msSincePaste: 1200,
        msSinceLastModified: 1300,
        clipboardTypes: ["Files", "image/png"],
        pastedFileCount: 1,
        nativeResolver: true,
        nativePath: false,
        replayed: true,
      };

      const post = (body: unknown) =>
        harness.app.request("/api/v1/system/attachment-diagnostic", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-omnyo-app-surface": "desktop",
          },
          body: JSON.stringify(body),
        });

      expect((await post(diagnostic)).status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining(diagnostic),
        "Attachment upload diagnostic",
      );
      warn.mockClear();

      expect(
        (await post({ ...diagnostic, userAgentFamily: "bb-desktop" })).status,
      ).toBe(200);
      warn.mockClear();

      for (const body of [
        { ...diagnostic, filename: "secret-plan.png" },
        { ...diagnostic, path: "/Users/developer/Desktop/shot.png" },
        { ...diagnostic, clipboardTypes: ["text/plain secret"] },
        { ...diagnostic, cause: "arbitrary text" },
      ]) {
        expect((await post(body)).status).toBe(400);
      }

      expect(warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "Attachment upload diagnostic",
      );
    });
  });

  it("keeps attachment read tokens scoped to their owning project", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-attachment-scope",
      });

      const { project: owner } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const { project: other } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const response = await upload(
        harness.app,
        owner.id,
        new File(["secret"], "owner.txt", { type: "text/plain" }),
      );

      const uploaded = uploadedPromptAttachmentSchema.parse(
        await readJson(response),
      );

      const foreignRead = await harness.app.request(
        `/api/v1/projects/${other.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`,
      );

      expect(foreignRead.status).toBe(404);
      await expect(readJson(foreignRead)).resolves.toEqual({
        code: "invalid_request",
        message: "Attachment not found",
      });
    });
  });
});

describe("attachment request body boundary", () => {
  it("rejects a declared multi-gigabyte body before pulling any bytes", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-body-header",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      let pulls = 0;

      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.error(new Error("Oversized body must not be read"));
          },
        },
        { highWaterMark: 0 },
      );

      const requestOptions: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=owned",
          "content-length": "3140809851",
        },
        body,
        duplex: "half",
      };

      const request = new Request(
        `http://localhost/api/v1/projects/${project.id}/attachments`,
        requestOptions,
      );

      const response = await harness.app.request(request);
      expect(response.status).toBe(413);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
      });
      expect(pulls).toBe(0);
    });
  });

  it("bounds a chunked multipart body before consuming its tail", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-body-stream",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      let pulls = 0;
      const chunk = new Uint8Array(1024 * 1024);

      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;

            if (pulls > 40)
              controller.error(new Error("Unbounded multipart read"));
            else controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );

      const requestOptions: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=owned",
          "transfer-encoding": "chunked",
        },
        body,
        duplex: "half",
      };

      const request = new Request(
        `http://localhost/api/v1/projects/${project.id}/attachments`,
        requestOptions,
      );

      const response = await harness.app.request(request);
      expect(response.status).toBe(413);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
      });
      expect(pulls).toBeLessThanOrEqual(38);
      expect(pulls).toBeGreaterThan(35);
    });
  });
});
