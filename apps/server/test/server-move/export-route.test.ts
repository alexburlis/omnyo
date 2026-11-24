import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setExperiments } from "@omnyo/db";
import { defaultExperiments } from "@omnyo/domain";
import { extractServerArchive } from "@omnyo/server-archive";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

const EXPORT_PATH = "/api/v1/server/export";

const ATTACHMENT_PATH = "attachments/project-1/recording.bin";

const ATTACHMENT_BYTES = 16 * 1024 * 1024;

const CLEANUP_DEADLINE_MS = 30_000;

const EXPORT_TEST_TIMEOUT_MS = 60_000;

let server: RunningTestServer | null = null;

const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function startExportServer(): Promise<RunningTestServer> {
  const running = await startTestServer();
  server = running;
  setExperiments(running.db, { ...defaultExperiments, serverMove: true });

  const attachmentPath = join(
    running.config.dataDir,
    ...ATTACHMENT_PATH.split("/"),
  );

  await mkdir(dirname(attachmentPath), { recursive: true });
  await writeFile(attachmentPath, randomBytes(ATTACHMENT_BYTES));

  return running;
}

function exportWorkRoot(running: RunningTestServer): string {
  return join(running.config.dataDir, "server-export");
}

function listExportFiles(running: RunningTestServer): string[] {
  const root = exportWorkRoot(running);

  return existsSync(root)
    ? readdirSync(root, { recursive: true }).map(String)
    : [];
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return condition();
}

interface OpenExportRequest {
  request: http.ClientRequest;
  response: Promise<http.IncomingMessage>;
}

function openExportRequest(running: RunningTestServer): OpenExportRequest {
  const url = new URL(EXPORT_PATH, running.baseUrl);

  const request = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
  });

  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });

  response.catch(() => undefined);
  request.end();

  return { request, response };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function downloadExport(
  running: RunningTestServer,
): Promise<{ bytes: Buffer; headers: Headers; status: number }> {
  const response = await fetch(new URL(EXPORT_PATH, running.baseUrl), {
    method: "POST",
  });

  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
    status: response.status,
  };
}

describe(
  "POST /api/v1/server/export streaming",
  { timeout: EXPORT_TEST_TIMEOUT_MS },
  () => {
    it("streams an archive whose content-length and sha256 headers match the body, without keeping export files", async () => {
      const running = await startExportServer();

      const download = await downloadExport(running);

      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/gzip");
      expect(download.headers.get("content-length")).toBe(
        String(download.bytes.length),
      );
      expect(download.headers.get("x-omnyo-archive-sha256")).toBe(
        sha256(download.bytes),
      );
      const root = await mkdtemp(join(tmpdir(), "omnyo-export-route-"));
      tempDirs.push(root);
      const archivePath = join(root, "export.tar.gz");
      await writeFile(archivePath, download.bytes);

      const manifest = await extractServerArchive({
        archivePath,
        destinationDir: join(root, "staging"),
      });

      expect(manifest.entries.map((entry) => entry.path)).toContain(
        ATTACHMENT_PATH,
      );
      await waitFor(
        () => listExportFiles(running).length === 0,
        CLEANUP_DEADLINE_MS,
      );
      expect(listExportFiles(running)).toEqual([]);
    });

    it("stops the export and leaves no export files behind when the client disconnects mid-download", async () => {
      const running = await startExportServer();
      const { request, response } = openExportRequest(running);
      const message = await response;
      expect(message.statusCode).toBe(200);
      await new Promise((resolve) => message.once("data", resolve));
      message.pause();

      request.destroy();

      await waitFor(
        () => listExportFiles(running).length === 0,
        CLEANUP_DEADLINE_MS,
      );
      expect(listExportFiles(running)).toEqual([]);
    });

    it("stops the export and leaves no export files behind when the client disconnects while the snapshot is taken", async () => {
      const running = await startExportServer();
      const { request } = openExportRequest(running);
      expect(
        await waitFor(
          () => listExportFiles(running).length > 0,
          CLEANUP_DEADLINE_MS,
        ),
      ).toBe(true);

      request.destroy();

      await waitFor(
        () => listExportFiles(running).length === 0,
        CLEANUP_DEADLINE_MS,
      );
      expect(listExportFiles(running)).toEqual([]);
    });

    it("completes a concurrent export while another client disconnects, and leaves no export files behind", async () => {
      const running = await startExportServer();
      const abandoned = openExportRequest(running);
      expect(
        await waitFor(
          () => listExportFiles(running).length > 0,
          CLEANUP_DEADLINE_MS,
        ),
      ).toBe(true);
      const completed = downloadExport(running);

      abandoned.request.destroy();
      const download = await completed;

      expect(download.status).toBe(200);
      expect(download.headers.get("x-omnyo-archive-sha256")).toBe(
        sha256(download.bytes),
      );
      await waitFor(
        () => listExportFiles(running).length === 0,
        CLEANUP_DEADLINE_MS,
      );
      expect(listExportFiles(running)).toEqual([]);
    });
  },
);
