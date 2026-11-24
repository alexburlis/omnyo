import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOmnyoAppVersion,
  readWorkerRuntimeVersion,
} from "./package-layout.js";

const roots: string[] = [];

async function createPackageRoot(manifest: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-package-layout-test-"));
  roots.push(root);

  if (manifest !== null) {
    await writeFile(join(root, "package.json"), manifest);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worker runtime version", () => {
  it("uses the packaged worker version instead of its launcher's inherited version", async () => {
    const packageRoot = await createPackageRoot(
      JSON.stringify({ version: "0.46.63+private.1" }),
    );

    await expect(
      readWorkerRuntimeVersion({
        env: { OMNYO_APP_VERSION: "0.46.24+private.1" },
        packageRoot,
      }),
    ).resolves.toBe("0.46.63+private.1");
    await expect(
      readOmnyoAppVersion({
        env: { OMNYO_APP_VERSION: "0.46.24+private.1" },
        packageRoot,
      }),
    ).resolves.toBe("0.46.24+private.1");
  });

  it.each([
    { name: "missing", manifest: null },
    { name: "malformed", manifest: "{" },
    { name: "invalid", manifest: JSON.stringify({ version: 63 }) },
  ])(
    "keeps the development fallback visible for a $name package manifest",
    async ({ manifest }) => {
      const packageRoot = await createPackageRoot(manifest);

      await expect(
        readWorkerRuntimeVersion({
          env: { OMNYO_APP_VERSION: "0.46.24+private.1" },
          packageRoot,
        }),
      ).resolves.toBe("0.0.0-dev");
    },
  );

  it.each([
    {
      env: { OMNYO_APP_VERSION: " 0.46.24+private.1 " },
      expected: "0.46.24+private.1",
    },
    { env: { OMNYO_APP_VERSION: " " }, expected: "0.0.0-dev" },
    { env: {}, expected: "0.0.0-dev" },
  ])(
    "preserves unpackaged worker version configuration for $env",
    async ({ env, expected }) => {
      await expect(
        readWorkerRuntimeVersion({ env, packageRoot: null }),
      ).resolves.toBe(expected);
    },
  );
});
