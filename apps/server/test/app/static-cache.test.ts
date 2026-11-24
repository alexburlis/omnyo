import { Buffer } from "node:buffer";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("production static cache headers", () => {
  it("shares immutable assets across fetch and module origins without changing API policy", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "omnyo-static-cors-"));
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "current shell");
    await writeFile(
      join(staticDir, "assets", "feature.js"),
      "export const value = 42;",
    );

    const harness = await createTestAppHarness({
      appAliasOrigins: ["https://phone.example"],
    });

    const serverApp = createApp(harness.deps, { staticDir });

    try {
      for (const origin of [
        undefined,
        "http://localhost",
        "https://phone.example",
        "https://untrusted.example",
      ]) {
        const headers = new Headers();

        if (origin !== undefined) headers.set("origin", origin);

        const asset = await serverApp.app.request("/assets/feature.js", {
          headers,
        });

        expect(asset.status).toBe(200);
        expect(asset.headers.get("access-control-allow-origin")).toBe("*");
        expect(asset.headers.has("access-control-allow-credentials")).toBe(
          false,
        );
        expect(asset.headers.get("vary")?.toLowerCase()).not.toContain(
          "origin",
        );
        expect(await asset.text()).toBe("export const value = 42;");
      }

      const allowed = await serverApp.app.request("/api/v1/system/config", {
        headers: { origin: "https://phone.example" },
      });

      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "https://phone.example",
      );
      expect(allowed.headers.get("vary")?.toLowerCase()).toContain("origin");

      const denied = await serverApp.app.request("/api/v1/system/config", {
        headers: { origin: "https://untrusted.example" },
      });

      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();

      const badHost = await serverApp.app.request(
        "http://untrusted.example/assets/feature.js",
      );

      expect(badHost.status).toBe(403);
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("serves retained hashed modules while keeping current HTML authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-static-generations-"));
    const staticDir = join(root, "current");
    const retained = join(root, "previous");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await mkdir(join(retained, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "current shell");
    await writeFile(join(retained, "index.html"), "obsolete shell");
    await writeFile(
      join(retained, "assets", "settings-old.js"),
      "export const view = 'old';",
    );
    const harness = await createTestAppHarness();

    const serverApp = createApp(harness.deps, {
      staticDir,
      retainedStaticDirs: [retained],
    });

    try {
      const module = await serverApp.app.request("/assets/settings-old.js");
      expect(module.status).toBe(200);
      expect(await module.text()).toContain("export const view");
      expect(module.headers.get("cache-control")).toContain("immutable");
      const page = await serverApp.app.request("/settings");
      expect(await page.text()).toBe("current shell");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      expect((await serverApp.app.request("/assets/missing.js")).status).toBe(
        404,
      );
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps current plus two prior complete asset generations across restarts", async () => {
    const { prepareStaticAppAssets } =
      await import("../../src/services/system/static-app-assets.js");

    const root = await mkdtemp(join(tmpdir(), "omnyo-static-retention-"));
    const staticDir = join(root, "build");
    const dataDir = join(root, "data");
    const harness = await createTestAppHarness();

    try {
      for (const generation of ["a", "b", "c", "d"]) {
        await rm(staticDir, { recursive: true, force: true });
        await mkdir(join(staticDir, "assets"), { recursive: true });
        await writeFile(join(staticDir, "index.html"), `shell ${generation}`);
        await writeFile(
          join(staticDir, "assets", `${generation}.js`),
          `export default '${generation}';`,
        );

        const retainedStaticDirs = await prepareStaticAppAssets({
          staticDir,
          dataDir,
        });

        expect(retainedStaticDirs).toHaveLength(
          Math.min("abcd".indexOf(generation) + 1, 3),
        );

        const serverApp = createApp(harness.deps, {
          staticDir,
          retainedStaticDirs,
        });

        try {
          expect((await serverApp.app.request("/assets/a.js")).status).toBe(
            generation === "d" ? 404 : 200,
          );
          expect(
            (await serverApp.app.request(`/assets/${generation}.js`)).status,
          ).toBe(200);
        } finally {
          await serverApp.closeWebSockets();
        }
      }

      const restarted = await prepareStaticAppAssets({ staticDir, dataDir });
      expect(restarted).toHaveLength(3);
    } finally {
      await harness.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves complete generations and removes staging after a failed copy", async () => {
    const { prepareStaticAppAssets } =
      await import("../../src/services/system/static-app-assets.js");

    const root = await mkdtemp(join(tmpdir(), "omnyo-static-failure-"));
    const staticDir = join(root, "build");
    const dataDir = join(root, "data");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "complete");
    await writeFile(
      join(staticDir, "assets", "valid.js"),
      "export default true;",
    );

    try {
      const before = await prepareStaticAppAssets({ staticDir, dataDir });
      await rm(join(staticDir, "assets"), { recursive: true, force: true });
      await writeFile(join(staticDir, "index.html"), "incomplete");
      await expect(
        prepareStaticAppAssets({ staticDir, dataDir }),
      ).rejects.toThrow();
      const { readdir, readFile } = await import("node:fs/promises");
      expect(
        await readFile(join(before[0]!, "assets", "valid.js"), "utf8"),
      ).toContain("export default true");
      expect(
        (await readdir(join(dataDir, "web-asset-generations"))).some((name) =>
          name.startsWith(".stage-"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates index.html on every navigation while allowing immutable hashed assets", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "omnyo-server-static-"));
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(
      join(staticDir, "index.html"),
      '<!doctype html><script type="module" src="/assets/index-test.js"></script>',
    );
    const bundleBody = `console.log('${"fresh bundle ".repeat(600)}');`;
    const bundlePath = join(staticDir, "assets", "index-test.js");
    const brotliBundle = brotliCompressSync(Buffer.from(bundleBody));
    const gzipBundle = gzipSync(Buffer.from(bundleBody));
    await writeFile(bundlePath, bundleBody);
    await writeFile(`${bundlePath}.br`, brotliBundle);
    await writeFile(`${bundlePath}.gz`, gzipBundle);
    await writeFile(
      join(staticDir, "assets", "dynamic-only.js"),
      `console.log('${"dynamic bundle ".repeat(600)}');`,
    );
    await writeFile(
      join(staticDir, "manifest.webmanifest"),
      JSON.stringify({ name: "omnyo", icons: [] }),
    );
    await writeFile(
      join(staticDir, "favicon-32x32.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const harness = await createTestAppHarness();
    const serverApp = createApp(harness.deps, { staticDir });

    try {
      const rootResponse = await serverApp.app.request("/");
      expect(rootResponse.headers.get("cache-control")).toBe("no-cache");
      expect(rootResponse.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/u);

      const fallbackResponse = await serverApp.app.request("/threads/thr_123");
      expect(fallbackResponse.headers.get("cache-control")).toBe("no-cache");
      expect(fallbackResponse.headers.get("etag")).toBe(
        rootResponse.headers.get("etag"),
      );

      const assetResponse = await serverApp.app.request(
        "/assets/index-test.js",
      );

      expect(assetResponse.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );

      const brotliAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "br, gzip" } },
      );

      expect(brotliAssetResponse.headers.get("content-encoding")).toBe("br");
      expect(
        brotliAssetResponse.headers.get("access-control-allow-origin"),
      ).toBe("*");
      expect(
        brotliAssetResponse.headers.get("vary")?.toLowerCase(),
      ).not.toContain("origin");
      expect(
        brotliAssetResponse.headers
          .get("vary")
          ?.split(",")
          .map((value) => value.trim()),
      ).toContain("Accept-Encoding");
      expect(brotliAssetResponse.headers.get("content-length")).toBe(
        String(brotliBundle.length),
      );
      expect((await brotliAssetResponse.arrayBuffer()).byteLength).toBe(
        brotliBundle.length,
      );

      const gzipAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "gzip" } },
      );

      expect(gzipAssetResponse.headers.get("content-encoding")).toBe("gzip");
      expect(gzipAssetResponse.headers.get("content-length")).toBe(
        String(gzipBundle.length),
      );

      const gzipPreferredAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "br;q=0, gzip;q=1" } },
      );

      expect(gzipPreferredAssetResponse.headers.get("content-encoding")).toBe(
        "gzip",
      );

      const dynamicCompressedAssetResponse = await serverApp.app.request(
        "/assets/dynamic-only.js",
        { headers: { "accept-encoding": "gzip" } },
      );

      expect(
        dynamicCompressedAssetResponse.headers.get("content-encoding"),
      ).toBe("gzip");
      expect(dynamicCompressedAssetResponse.headers.has("content-length")).toBe(
        false,
      );

      const manifestResponse = await serverApp.app.request(
        "/manifest.webmanifest",
      );

      expect(manifestResponse.headers.get("content-type")).toBe(
        "application/manifest+json",
      );
      expect(manifestResponse.headers.get("cache-control")).toBe(
        "public, max-age=86400",
      );

      const iconResponse = await serverApp.app.request("/favicon-32x32.png");
      expect(iconResponse.status).toBe(200);
      expect(iconResponse.headers.get("content-type")).toBe("image/png");
      expect(iconResponse.headers.get("cache-control")).toBe(
        "public, max-age=86400",
      );

      const apiMissResponse = await serverApp.app.request(
        "/api/v1/does-not-exist.js",
      );

      const apiMissBody = await apiMissResponse.text();
      expect(apiMissResponse.status).toBe(404);
      expect(apiMissResponse.headers.get("content-type")).toBe(
        "application/json",
      );
      expect(apiMissBody).not.toContain("index-test.js");
      expect(JSON.parse(apiMissBody)).toMatchObject({
        code: "not_found",
      });

      const assetMissResponse = await serverApp.app.request(
        "/assets/does-not-exist.js",
      );

      expect(assetMissResponse.status).toBe(404);
      expect(await assetMissResponse.text()).not.toContain("index-test.js");
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
      await rm(staticDir, { force: true, recursive: true });
    }
  });
});
