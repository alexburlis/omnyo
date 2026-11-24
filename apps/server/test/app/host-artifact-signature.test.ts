import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import {
  createHostArtifactSignatureReader,
  HOST_ARTIFACT_SIGNATURES_DIRECTORY,
} from "../../src/services/install/omnyo-app-artifact.js";
import { readJson } from "../helpers/json.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const roots: string[] = [];

const VERSION = "0.46.2+private.1";

const TARBALL = Buffer.from("host artifact tarball");

const DIGEST = createHash("sha256").update(TARBALL).digest("hex");

const KEY_ID = "0123456789abcdef";

const SIGNATURE = Buffer.alloc(64, 7).toString("base64");

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    keyId: KEY_ID,
    version: VERSION,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    digest: DIGEST,
    signature: SIGNATURE,
    ...overrides,
  };
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-host-signature-"));
  roots.push(root);

  return root;
}

async function writeSignature(
  dataDir: string,
  contents: string,
  name = `${DIGEST}.json`,
): Promise<void> {
  await mkdir(join(dataDir, HOST_ARTIFACT_SIGNATURES_DIRECTORY), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, HOST_ARTIFACT_SIGNATURES_DIRECTORY, name),
    contents,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("host artifact signature reader", () => {
  const subject = {
    version: VERSION,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    digest: DIGEST,
  };

  async function reader() {
    const dataDir = await scratch();
    const logger = { warn: vi.fn() };

    return {
      dataDir,
      logger,
      reader: createHostArtifactSignatureReader({ dataDir, logger }),
    };
  }

  it("returns a record that matches the served artifact", async () => {
    const test = await reader();

    await writeSignature(test.dataDir, JSON.stringify(record()));
    await expect(test.reader.read(subject)).resolves.toEqual(record());
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("returns null with one warning per artifact and reason when the file is absent", async () => {
    const test = await reader();

    await expect(test.reader.read(subject)).resolves.toBeNull();
    await expect(test.reader.read(subject)).resolves.toBeNull();
    expect(test.logger.warn).toHaveBeenCalledOnce();
    expect(test.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ artifactDigest: DIGEST, reason: "missing" }),
      expect.stringContaining("no usable release signature"),
    );
  });

  it("picks up a signature written after an earlier miss", async () => {
    const test = await reader();

    await expect(test.reader.read(subject)).resolves.toBeNull();
    await writeSignature(test.dataDir, JSON.stringify(record()));
    await expect(test.reader.read(subject)).resolves.toEqual(record());
  });

  it.each([
    ["is not JSON", "{broken", "invalid"],
    ["has an unknown field", JSON.stringify(record({ extra: 1 })), "invalid"],
    [
      "has another schema version",
      JSON.stringify(record({ schemaVersion: 2 })),
      "invalid",
    ],
    [
      "has a malformed signature",
      JSON.stringify(record({ signature: "!!!" })),
      "invalid",
    ],
    [
      "has a malformed key id",
      JSON.stringify(record({ keyId: "XYZ" })),
      "invalid",
    ],
    [
      "names another version",
      JSON.stringify(record({ version: "0.46.3+private.1" })),
      "mismatched",
    ],
    [
      "names another protocol",
      JSON.stringify(record({ protocolVersion: 1 })),
      "mismatched",
    ],
    [
      "names another digest",
      JSON.stringify(record({ digest: "f".repeat(64) })),
      "mismatched",
    ],
  ])("treats a file that %s as absent", async (_name, contents, reason) => {
    const test = await reader();

    await writeSignature(test.dataDir, contents);
    await expect(test.reader.read(subject)).resolves.toBeNull();
    expect(test.logger.warn).toHaveBeenCalledOnce();
    expect(test.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason }),
      expect.any(String),
    );
  });

  it("never builds a path from a digest that is not lowercase hex", async () => {
    const test = await reader();

    await writeSignature(test.dataDir, JSON.stringify(record()), "x.json");
    await expect(
      test.reader.read({ ...subject, digest: "../x" }),
    ).resolves.toBeNull();
    expect(test.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "invalid" }),
      expect.any(String),
    );
  });
});

describe("install routes and release signatures", () => {
  async function withApp(
    run: (args: {
      request: (path: string, init?: RequestInit) => Promise<Response>;
      dataDir: string;
      warn: ReturnType<typeof vi.spyOn>;
    }) => Promise<void>,
  ) {
    const harness = await createTestAppHarness();
    const root = await scratch();
    const artifactPath = join(root, "omnyo-app.tgz");
    await writeFile(artifactPath, TARBALL);

    const { app } = createApp(harness.deps, {
      appArtifactService: {
        getArtifact: async () => ({
          digest: DIGEST,
          path: artifactPath,
          size: TARBALL.length,
        }),
        getVersion: async () => VERSION,
      },
    });

    const warn = vi.spyOn(harness.deps.logger, "warn");

    try {
      await run({
        request: async (path, init) => app.request(path, init),
        dataDir: harness.deps.config.dataDir,
        warn,
      });
    } finally {
      warn.mockRestore();
      await harness.cleanup();
    }
  }

  it("serves the original version fields with a null signature when none exists", async () => {
    await withApp(async ({ request, warn }) => {
      const response = await request("/install/version");

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        version: VERSION,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        artifactDigest: DIGEST,
        artifactSignature: null,
        artifactSignatureKeyId: null,
      });
      await request("/install/version");
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  it("serves the signature and key id for the served artifact", async () => {
    await withApp(async ({ request, dataDir, warn }) => {
      await writeSignature(dataDir, JSON.stringify(record()));
      const response = await request("/install/version");

      await expect(readJson(response)).resolves.toEqual({
        version: VERSION,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        artifactDigest: DIGEST,
        artifactSignature: SIGNATURE,
        artifactSignatureKeyId: KEY_ID,
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("serves null for a signature that names another release", async () => {
    await withApp(async ({ request, dataDir, warn }) => {
      await writeSignature(
        dataDir,
        JSON.stringify(record({ version: "0.46.3+private.1" })),
      );
      const response = await request("/install/version");

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        artifactDigest: DIGEST,
        artifactSignature: null,
        artifactSignatureKeyId: null,
      });
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  it("adds signature headers to the tarball and its not-modified answer", async () => {
    await withApp(async ({ request, dataDir, warn }) => {
      await writeSignature(dataDir, JSON.stringify(record()));

      const full = await request("/install/omnyo-app.tgz");

      expect(full.status).toBe(200);
      expect(full.headers.get("x-omnyo-artifact-sha256")).toBe(DIGEST);
      expect(full.headers.get("x-omnyo-artifact-signature")).toBe(SIGNATURE);
      expect(full.headers.get("x-omnyo-artifact-signature-key-id")).toBe(
        KEY_ID,
      );
      expect(Buffer.from(await full.arrayBuffer())).toEqual(TARBALL);

      const notModified = await request("/install/omnyo-app.tgz", {
        headers: { "if-none-match": `"sha256-${DIGEST}"` },
      });

      expect(notModified.status).toBe(304);
      expect(notModified.headers.get("x-omnyo-artifact-signature")).toBe(
        SIGNATURE,
      );
      expect(notModified.headers.get("x-omnyo-artifact-signature-key-id")).toBe(
        KEY_ID,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("still serves the tarball without signature headers when none exists", async () => {
    await withApp(async ({ request, warn }) => {
      const response = await request("/install/omnyo-app.tgz");

      expect(response.status).toBe(200);
      expect(response.headers.get("x-omnyo-artifact-sha256")).toBe(DIGEST);
      expect(response.headers.has("x-omnyo-artifact-signature")).toBe(false);
      expect(response.headers.has("x-omnyo-artifact-signature-key-id")).toBe(
        false,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(TARBALL);
      expect(warn).toHaveBeenCalledOnce();
    });
  });
});
