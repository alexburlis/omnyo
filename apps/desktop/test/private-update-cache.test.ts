import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { writePrivateUpdateCacheMetadata } from "../scripts/private-update-cache.mjs";

describe("private updater packaged cache metadata", () => {
  it.each([
    { appId: "dev.omnyo.private", platform: "darwin" },
    { appId: "dev.omnyo.private.nightly", platform: "darwin" },
    { appId: "dev.omnyo.private", platform: "win32" },
    { appId: "dev.omnyo.private.nightly", platform: "win32" },
  ] satisfies { appId: string; platform: "darwin" | "win32" }[])(
    "writes exact $appId cache ownership and replaces identical metadata idempotently",
    async ({ appId, platform }) => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-private-cache-test-"));

      try {
        await writePrivateUpdateCacheMetadata(root, appId, platform);
        const initial = await readFile(join(root, "app-update.yml"), "utf8");
        expect(parse(initial)).toEqual({
          updaterCacheDirName: `${appId}-updater`,
        });
        await writePrivateUpdateCacheMetadata(root, appId, platform);
        expect(await readFile(join(root, "app-update.yml"), "utf8")).toBe(
          initial,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it.each([
    { appId: "dev.bb.private", platform: "darwin" },
    { appId: "dev.bb.private", platform: "win32" },
    { appId: "dev.foreign.private", platform: "darwin" },
  ] satisfies { appId: string; platform: "darwin" | "win32" }[])(
    "refuses $appId for $platform before changing cache files",
    async ({ appId, platform }) => {
      const root = await mkdtemp(
        join(tmpdir(), "omnyo-private-cache-refusal-"),
      );

      try {
        await writeFile(join(root, "keeper"), "unknown bytes");
        await expect(
          writePrivateUpdateCacheMetadata(root, appId, platform),
        ).rejects.toThrow("Private updater cache identity is invalid");
        expect(await readFile(join(root, "keeper"), "utf8")).toBe(
          "unknown bytes",
        );
        await expect(
          readFile(join(root, "app-update.yml")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true });
      }
    },
  );

  it("keeps a stable staging ZIP intact when nightly resolves another digest through the real updater cache owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-private-channel-cache-"));

    try {
      const stableResources = join(root, "stable");
      const nightlyResources = join(root, "nightly");
      await writePrivateUpdateCacheMetadata(
        stableResources,
        "dev.omnyo.private",
        "darwin",
      );
      await writePrivateUpdateCacheMetadata(
        nightlyResources,
        "dev.omnyo.private.nightly",
        "darwin",
      );

      const stableName = parse(
        await readFile(join(stableResources, "app-update.yml"), "utf8"),
      ).updaterCacheDirName;

      const nightlyName = parse(
        await readFile(join(nightlyResources, "app-update.yml"), "utf8"),
      ).updaterCacheDirName;

      const stable = new DownloadedUpdateHelper(join(root, stableName));
      const nightly = new DownloadedUpdateHelper(join(root, nightlyName));
      const bytes = Buffer.from("stable selected ZIP bytes");
      const digest = createHash("sha512").update(bytes).digest("base64");
      const pending = stable.cacheDirForPendingUpdate;
      await mkdir(pending, { recursive: true });
      const zip = join(pending, "stable.zip");
      await writeFile(zip, bytes);
      await writeFile(
        join(pending, "update-info.json"),
        JSON.stringify({
          fileName: "stable.zip",
          sha512: digest,
          isAdminRightsRequired: false,
        }),
      );

      const info = {
        url: new URL("https://inert.invalid/nightly.zip"),
        info: {
          url: "nightly.zip",
          sha512: Buffer.alloc(64, 2).toString("base64"),
        },
      };

      await nightly.validateDownloadedPath(
        join(nightly.cacheDirForPendingUpdate, "nightly.zip"),
        {
          path: "nightly.zip",
          sha512: info.info.sha512,
          version: "0.46.3",
          releaseDate: "2026-10-13",
          files: [info.info],
        },
        info,
        { info() {}, warn() {}, error() {} },
      );
      expect(await readFile(zip)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
