import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { registerStaticAppRoutes } from "./server.js";

describe("app shell serving", () => {
  const shellHtml = "<!doctype html><title>omnyo</title><p>build-a</p>";
  const shellBrotli = brotliCompressSync(Buffer.from(shellHtml));
  let dir: string;
  let app: Hono;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omnyo-static-shell-"));
    await writeFile(join(dir, "index.html"), shellHtml);
    await writeFile(join(dir, "index.html.br"), shellBrotli);
    app = new Hono();
    registerStaticAppRoutes(app, dir);
  });

  it("serves the brotli sidecar with the shell headers, directly and on the SPA fallback", async () => {
    for (const path of ["/", "/threads/some-thread"]) {
      const res = await app.request(path, {
        headers: { "accept-encoding": "br, gzip" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-type")).toBe("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/u);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(shellBrotli);
    }
  });

  it("preloads bootstrap contributor modules only on thread HTML without changing compressed bytes or validators", async () => {
    const urls = ["/api/v1/plugin-app-assets/abcdef1234567890/app.js"];
    registerStaticAppRoutes(
      (app = new Hono()),
      dir,
      undefined,
      undefined,
      () => urls,
    );
    const link = `<${urls[0]}>; rel=modulepreload; crossorigin=anonymous`;

    for (const path of [
      "/threads/thread-one",
      "/projects/project-one/threads/thread-one",
    ]) {
      const response = await app.request(path, {
        headers: { "accept-encoding": "br" },
      });

      expect(response.headers.get("link")).toBe(link);
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(response.headers.get("content-length")).toBe(
        String(shellBrotli.length),
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(shellBrotli);

      const etag = response.headers.get("etag");

      expect(etag).not.toBeNull();

      const unchanged = await app.request(path, {
        headers: { "if-none-match": etag ?? "" },
      });

      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(unchanged.headers.get("link")).toBe(link);
      expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
    }

    for (const path of [
      "/",
      "/index.html",
      "/projects/project-one",
      "/threads/thread-one/settings",
      "/projects/project-one/threads/thread-one/files",
      "/assets/missing.js",
    ]) {
      const response = await app.request(path);
      expect(response.headers.get("link")).toBeNull();
    }
  });

  it("refuses to be framed by another site, compressed or not", async () => {
    for (const encoding of ["br", "identity"]) {
      const res = await app.request("/?initialPrompt=hello", {
        headers: { "accept-encoding": encoding },
      });

      expect(res.headers.get("content-security-policy"), encoding).toBe(
        "frame-ancestors 'self'",
      );
      expect(res.headers.get("x-frame-options"), encoding).toBe("SAMEORIGIN");
    }
  });

  it("serves the identity document when the client accepts no encodings", async () => {
    const res = await app.request("/threads/t");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toMatch(/^W\//u);
    expect(await res.text()).toBe(shellHtml);
  });

  it("answers a matching If-None-Match with an empty 304 on both paths", async () => {
    const first = await app.request("/");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    for (const path of ["/", "/threads/some-thread"]) {
      const res = await app.request(path, {
        headers: { "accept-encoding": "br", "if-none-match": etag ?? "" },
      });

      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("rotates the ETag when a new build lands, so old validators refetch", async () => {
    const first = await app.request("/");
    const oldEtag = first.headers.get("etag") ?? "";

    const nextBuild =
      "<!doctype html><title>omnyo</title><p>build-b with new hashed assets</p>";

    await writeFile(join(dir, "index.html"), nextBuild);

    const res = await app.request("/", {
      headers: { "if-none-match": oldEtag },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(oldEtag);
    expect(await res.text()).toBe(nextBuild);
  });

  it("keeps /assets/ misses as 404 instead of the SPA fallback", async () => {
    const res = await app.request("/assets/stale-chunk.js");
    expect(res.status).toBe(404);
  });
});
