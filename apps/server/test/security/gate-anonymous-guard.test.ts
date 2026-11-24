import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHost } from "@omnyo/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { readJson } from "../helpers/json.js";
import { seedHost } from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const ANONYMOUS = { "x-omnyo-gate-auth": "anonymous" };

const ARTIFACT_DIGEST = "b".repeat(64);

async function withGateApp(
  run: (args: {
    app: ReturnType<typeof createApp>["app"];
    harness: TestAppHarness;
  }) => Promise<void>,
): Promise<void> {
  const harness = await createTestAppHarness();
  const staticDir = mkdtempSync(join(tmpdir(), "omnyo-gate-anonymous-"));
  writeFileSync(join(staticDir, "index.html"), "web shell");
  const artifactPath = join(staticDir, "omnyo-app.tgz");
  writeFileSync(artifactPath, "tarball");

  const { app } = createApp(harness.deps, {
    appArtifactService: {
      getArtifact: async () => ({
        digest: ARTIFACT_DIGEST,
        path: artifactPath,
        size: 7,
      }),
      getVersion: async () => "9.9.9-test",
    },
    staticDir,
  });

  try {
    await run({ app, harness });
  } finally {
    rmSync(staticDir, { force: true, recursive: true });
    await harness.cleanup();
  }
}

describe("anonymous gate forwards", () => {
  it("reach the installer and preview-content handlers", async () => {
    await withGateApp(async ({ app }) => {
      const installScript = await app.request("/install.sh", {
        headers: ANONYMOUS,
      });

      expect(installScript.status).toBe(200);
      expect(installScript.headers.get("content-type")).toBe(
        "text/x-shellscript; charset=utf-8",
      );

      const windowsScript = await app.request("/install.ps1", {
        headers: ANONYMOUS,
      });

      expect(windowsScript.status).toBe(200);
      expect(await windowsScript.text()).toContain(
        "This installer needs an enrollment command.",
      );

      const version = await app.request("/install/version", {
        headers: ANONYMOUS,
      });

      expect(version.status).toBe(200);
      await expect(readJson(version)).resolves.toMatchObject({
        version: "9.9.9-test",
        artifactDigest: ARTIFACT_DIGEST,
      });

      const versionHead = await app.request("/install/version", {
        method: "HEAD",
        headers: ANONYMOUS,
      });

      expect(versionHead.status).toBe(200);

      const tarball = await app.request("/install/omnyo-app.tgz", {
        headers: ANONYMOUS,
      });

      expect(tarball.status).toBe(200);
      expect(await tarball.text()).toBe("tarball");

      for (const path of [
        "/preview-content/preview_1/capability/index.html",
        "/preview-content/preview_1/capability/",
        "/preview-content/preview_1/capability",
        "/preview-content/preview_1/capability/a%0Ab.html",
        "/preview-content/preview_1/capability/a%E2%80%A8b.html",
      ]) {
        const preview = await app.request(path, { headers: ANONYMOUS });
        expect(preview.status, path).toBe(403);
        await expect(readJson(preview), path).resolves.toMatchObject({
          code: "preview_access_expired",
        });
      }

      const previewHead = await app.request(
        "/preview-content/preview_1/capability/index.html",
        { method: "HEAD", headers: ANONYMOUS },
      );

      expect(previewHead.status).toBe(403);
    });
  });

  it("are refused before API, internal, plugin and app routes run", async () => {
    await withGateApp(async ({ app, harness }) => {
      const host = seedHost(harness.deps, {
        id: "host_anonymous_guard",
        name: "Original name",
      });

      const refused: Array<[string, RequestInit]> = [
        [`/api/v1/hosts/${host.id}`, { headers: ANONYMOUS }],
        [
          `/api/v1/hosts/${host.id}`,
          {
            method: "PATCH",
            headers: { ...ANONYMOUS, "content-type": "application/json" },
            body: JSON.stringify({ name: "Renamed by anonymous" }),
          },
        ],
        [`/api/v1/hosts/${host.id}`, { method: "DELETE", headers: ANONYMOUS }],
        ["/api/v1/plugins", { headers: ANONYMOUS }],
        ["/api/v1/plugins/example/http/hook", { headers: ANONYMOUS }],
        ["/internal/ws", { headers: ANONYMOUS }],
        ["/internal/hosts/enroll", { method: "POST", headers: ANONYMOUS }],
        ["/health", { headers: ANONYMOUS }],
        ["/", { headers: ANONYMOUS }],
        ["/preview/preview_1", { headers: ANONYMOUS }],
        ["/private-updates/stable/darwin/latest.json", { headers: ANONYMOUS }],
        ["/install/unknown.tgz", { headers: ANONYMOUS }],
        ["/install.sh", { method: "POST", headers: ANONYMOUS }],
        ["/m/ABCD-1234", { method: "POST", headers: ANONYMOUS }],
        ["/m/ABCD-1234/extra", { headers: ANONYMOUS }],
        ["/m/", { headers: ANONYMOUS }],
        [
          "/preview-content/preview_1/capability/index.html",
          { method: "POST", headers: ANONYMOUS, body: "x" },
        ],
        [
          "/preview-content/preview_1/capability/index.html",
          { method: "OPTIONS", headers: ANONYMOUS },
        ],
        ["/preview-content/preview_1", { headers: ANONYMOUS }],
        [
          `/api/v1/hosts/${host.id}`,
          { headers: { "x-omnyo-gate-auth": "owner" } },
        ],
      ];

      for (const [path, init] of refused) {
        const response = await app.request(path, init);
        const label = `${init.method ?? "GET"} ${path}`;
        expect(response.status, label).toBe(404);
        await expect(readJson(response), label).resolves.toEqual({
          code: "not_found",
          message: "Not found",
        });
      }

      expect(getHost(harness.db, host.id)).toMatchObject({
        name: "Original name",
      });
    });
  });

  it("leave requests without the gate header and owner gate kinds unchanged", async () => {
    await withGateApp(async ({ app, harness }) => {
      const host = seedHost(harness.deps, {
        id: "host_anonymous_guard_owner",
        name: "Original name",
      });

      const ownerHeaders: Array<Record<string, string>> = [
        {},
        { "x-omnyo-gate-auth": "session" },
      ];

      for (const headers of ownerHeaders) {
        const read = await app.request(`/api/v1/hosts/${host.id}`, {
          headers,
        });

        expect(read.status).toBe(200);
      }

      const health = await app.request("/health");
      expect(health.status).toBe(200);

      const shell = await app.request("/");
      expect(shell.status).toBe(200);
      expect(await shell.text()).toBe("web shell");

      const rename = await app.request(`/api/v1/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed by owner" }),
      });

      expect(rename.status).toBe(200);
      expect(getHost(harness.db, host.id)).toMatchObject({
        name: "Renamed by owner",
      });
    });
  });
});
