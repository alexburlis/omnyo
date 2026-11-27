import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "../server";
import { CanvasService } from "../lib/service";
import { mediaManifestSchema } from "../media-contract";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function fixture(bytes: Buffer) {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  plugin(host.api);
  const service = new CanvasService(host.api);
  service.enable("media-test", "agent");
  const result = service.addMedia("media-test", bytes, { id: "image" });
  const node = service.board("media-test")?.nodes.find((entry) => entry.id === result.id);

  if (!node?.assetId) throw new Error("No image asset was stored");
  const id = node.assetId;
  const fetch = (path: string) => host.harness.behavior.fetchHttp("GET", path);

  return { id, fetch };
}

describe("prepared image transport", () => {
  it("compresses previews losslessly, deduplicates concurrent preparation and preserves exact originals", async () => {
    const width = 96;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 4);

    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = (index / 4) % 251;
      pixels[index + 1] = 127;
      pixels[index + 2] = 223;
      pixels[index + 3] = index % 5 === 0 ? 0 : 255;
    }

    const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const { id, fetch } = fixture(bytes);

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => fetch(`/asset-info?id=${id}`)),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const manifest = mediaManifestSchema.parse(await responses[0]?.json());
    expect(manifest.variants.map((entry) => entry.width)).toEqual([96]);
    const full = manifest.variants.find((entry) => entry.width === width);

    if (!full) throw new Error("Full-resolution variant missing");
    const encoded = await fetch(full.url.replace("/api/v1/plugins/canvas/http", ""));
    expect(encoded.headers.get("content-type")).toBe("image/webp");
    const compressed = Buffer.from(await encoded.arrayBuffer());
    expect(compressed.length).toBeLessThan(bytes.length / 10);
    expect(await sharp(compressed).ensureAlpha().raw().toBuffer()).toEqual(pixels);
    const original = await fetch(`/asset?id=${id}`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);

    for (const variant of manifest.variants.slice(0, 2)) {
      const response = await fetch(variant.url.replace("/api/v1/plugins/canvas/http", ""));
      const image = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(image).toMatchObject({ width: variant.width, height: variant.height, hasAlpha: true });
    }

    expect(await fetch(`/asset?id=${id}&width=999`).then((response) => response.status)).toBe(404);
  });

  it("prepares responsive widths without enlarging images", async () => {
    const bytes = await sharp({
      create: { width: 1300, height: 2, channels: 4, background: "red" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const { id, fetch } = fixture(bytes);
    const response = await fetch(`/asset-info?id=${id}`);
    expect(response.status).toBe(200);
    const manifest = mediaManifestSchema.parse(await response.json());
    expect(manifest.variants.map((entry) => entry.width)).toEqual([640, 1280, 1300]);

    for (const variant of manifest.variants) {
      const response = await fetch(variant.url.replace("/api/v1/plugins/canvas/http", ""));
      expect((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width).toBe(
        variant.width,
      );
    }
  });

  it("prepares existing images before their first preview request", async () => {
    const bytes = await sharp({
      create: { width: 1300, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();

    const host = createFakePluginHost({ pluginId: "canvas" });
    hosts.push(host);
    plugin(host.api);
    const service = new CanvasService(host.api);
    service.enable("media-test", "agent");
    service.addMedia("media-test", bytes, { id: "image" });
    const id = service.board("media-test")?.nodes[0]?.assetId;
    const before = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}&width=640`);
    expect(before.status).toBe(404);
    const preparation = host.harness.behavior.runService("canvas-media-preparation");
    await preparation.done;
    const prepared = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}&width=640`);
    expect(prepared.status).toBe(200);
  });

  it("retains animation instead of flattening GIF frames", async () => {
    const bytes = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
      raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
    })
      .gif({ delay: [100, 200], loop: 2 })
      .toBuffer();

    expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
    const { id, fetch } = fixture(bytes);

    const manifest = mediaManifestSchema.parse(
      await fetch(`/asset-info?id=${id}`).then((response) => response.json()),
    );

    expect(manifest).toMatchObject({
      animated: true,
      variants: [{ mime: "image/gif", lossless: true }],
    });
    expect(manifest.variants[0]?.url).toBe(manifest.originalUrl);
    const original = await fetch(`/asset?id=${id}`);
    const body = await original.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bytes);
  });

  it("keeps high-bit-depth pixels in the original format", async () => {
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } })
      .toColourspace("rgb16")
      .png()
      .toBuffer();

    expect((await sharp(bytes).metadata()).depth).toBe("ushort");
    const { id, fetch } = fixture(bytes);

    const manifest = mediaManifestSchema.parse(
      await fetch(`/asset-info?id=${id}`).then((response) => response.json()),
    );

    expect(manifest.variants).toEqual([
      { width: 32, height: 24, url: manifest.originalUrl, mime: "image/png", lossless: true },
    ]);
    const original = await fetch(`/asset?id=${id}`);
    const body = await original.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bytes);
  });

  it("returns an explicit preparation error without serving an unrelated or original preview", async () => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(24, 1),
    ]);

    const { id, fetch } = fixture(bytes);
    const response = await fetch(`/asset-info?id=${id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Image preview could not be prepared. Try again.",
    });
    expect(await fetch(`/asset?id=${id}&width=640`).then((result) => result.status)).toBe(404);
  });
});
