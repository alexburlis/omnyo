import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { registerPrivateUpdateFeedRoutes } from "../../src/routes/private-update-feed.js";

function recordingLogger() {
  const warnings: Array<{ details: Record<string, unknown>; message: string }> =
    [];

  return {
    warnings,
    warn(details: Record<string, unknown>, message: string) {
      warnings.push({ details, message });
    },
  };
}

it("serves only approved immutable feed bytes over actual HTTP", async () => {
  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-private-feed-http-")),
  );

  const root = join(dataDir, "private-updates", "latest");
  const sourceCommit = "a".repeat(40);
  const directory = join(root, sourceCommit, "macos");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(1500000, 37);
  const name = "omnyo-private-0.46.3-arm64.zip";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(directory, name), bytes);

  const manifest = {
    schema: 1,
    approved: true,
    approvalRef: "synthetic-http-proof",
    version: "0.46.3+private.1",
    protocolVersion: 236,
    sourceCommit,
    channel: "latest",
    files: [{ platform: "macos", name, size: bytes.length, sha256 }],
  };

  const app = new Hono();
  const logger = recordingLogger();
  registerPrivateUpdateFeedRoutes(app, dataDir, logger);
  app.get("*", () => new Response("application shell"));
  let port = 0;

  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
    (info) => {
      port = info.port;
    },
  );

  while (port === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const url = `http://127.0.0.1:${port}/private-updates/latest/macos/${name}`;

  try {
    expect((await fetch(url)).status).toBe(404);
    await writeFile(join(root, "approved.json"), JSON.stringify(manifest));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("etag")).toBe(`"sha256-${sha256}"`);
    expect(
      createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex"),
    ).toBe(sha256);
    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url.replace(name, "unapproved.exe"))).status).toBe(404);
    expect(logger.warnings.at(-1)?.details.reason).toBe(
      "Private feed file is not approved",
    );
    expect(
      (await fetch(url.replace(name, "%2e%2e%2fapproved.json"))).status,
    ).toBe(404);
    expect((await fetch(url.replace("macos", "windows"))).status).toBe(404);
    await writeFile(join(directory, name), Buffer.alloc(bytes.length, 38));
    expect((await fetch(url)).status).toBe(404);
    await writeFile(
      join(root, "approved.json"),
      JSON.stringify({ ...manifest, approved: false }),
    );
    expect((await fetch(url)).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
    await expect(readFile(join(directory, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("serves an untagged 1.x feed and refuses a malformed version", async () => {
  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-private-feed-untagged-")),
  );

  const root = join(dataDir, "private-updates", "latest");
  const sourceCommit = "c".repeat(40);
  const directory = join(root, sourceCommit, "windows");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("synthetic untagged NSIS bytes");
  const name = "Omnyo-Private-1.0.1-x64.exe";
  await writeFile(join(directory, name), bytes);

  const manifest = {
    schema: 1,
    approved: true,
    approvalRef: "synthetic-http-proof",
    version: "1.0.1",
    protocolVersion: 256,
    sourceCommit,
    channel: "latest",
    files: [
      {
        platform: "windows",
        name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };

  await writeFile(join(root, "approved.json"), JSON.stringify(manifest));
  const app = new Hono();
  registerPrivateUpdateFeedRoutes(app, dataDir, recordingLogger());
  let port = 0;

  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
    (info) => {
      port = info.port;
    },
  );

  while (port === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const url = `http://127.0.0.1:${port}/private-updates/latest/windows/${name}`;

  try {
    expect((await fetch(url)).status).toBe(200);
    await writeFile(
      join(root, "approved.json"),
      JSON.stringify({ ...manifest, version: "1.0.1+build.1" }),
    );
    expect((await fetch(url)).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("refuses symlinked manifests and artifact paths over HTTP", async () => {
  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-private-feed-symlink-")),
  );

  const root = join(dataDir, "private-updates", "latest");
  const sourceCommit = "b".repeat(40);
  const directory = join(root, sourceCommit, "windows");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("synthetic NSIS delivery bytes");
  const name = "bb-private-0.46.3-x64.exe";

  const manifest = {
    schema: 1,
    approved: true,
    approvalRef: "synthetic-http-proof",
    version: "0.46.3+private.1",
    protocolVersion: 236,
    sourceCommit,
    channel: "latest",
    files: [
      {
        platform: "windows",
        name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };

  await writeFile(join(dataDir, "external.exe"), bytes);
  await symlink(join(dataDir, "external.exe"), join(directory, name));
  await writeFile(join(root, "approved.json"), JSON.stringify(manifest));
  const app = new Hono();
  const logger = recordingLogger();
  registerPrivateUpdateFeedRoutes(app, dataDir, logger);
  let port = 0;

  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
    (info) => {
      port = info.port;
    },
  );

  while (port === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const url = `http://127.0.0.1:${port}/private-updates/latest/windows/${name}`;

  try {
    expect((await fetch(url)).status).toBe(404);
    await rm(join(root, "approved.json"));
    await writeFile(join(dataDir, "external.json"), JSON.stringify(manifest));
    await symlink(join(dataDir, "external.json"), join(root, "approved.json"));
    expect((await fetch(url)).status).toBe(404);
    await rm(join(root, "approved.json"));
    await writeFile(join(root, "approved.json"), JSON.stringify(manifest));
    await rm(directory, { recursive: true });
    await symlink(dataDir, directory);
    expect((await fetch(url)).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
  }
});
