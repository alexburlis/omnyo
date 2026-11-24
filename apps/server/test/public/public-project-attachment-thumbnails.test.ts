import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { storeAttachment } from "../../src/services/projects/attachments.js";
import {
  animatedPng,
  jpegWithExtraneousScanBytes,
  solidPng,
} from "../helpers/image-fixtures.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function pattern(width = 2048, height = 1024) {
  const bytes = Buffer.alloc(width * height * 4);

  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = (offset / 4) % 251;
    bytes[offset + 1] = Math.floor(offset / (width * 4)) % 253;
    bytes[offset + 2] = Math.floor(offset / 16) % 247;
    bytes[offset + 3] = 255;
  }

  return sharp(bytes, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

it("serves exact native originals and pixel-exact resized lossless thumbnails", async () => {
  await withTestHarness(async (harness) => {
    const { project } = seedThreadFixture(harness);
    const original = await pattern();

    const uploaded = await storeAttachment(
      harness.db,
      harness.deps.config.dataDir,
      project.id,
      new File([new Uint8Array(original)], "pixels.png", { type: "image/png" }),
    );

    const url = `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`;
    const native = await harness.app.request(url);
    expect(digest(new Uint8Array(await native.arrayBuffer()))).toBe(
      digest(original),
    );

    const [first, repeated] = await Promise.all([
      harness.app.request(`${url}&thumbnailWidth=320`),
      harness.app.request(`${url}&thumbnailWidth=320`),
    ]);

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("etag")).not.toBe(native.headers.get("etag"));
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(digest(bytes)).toBe(
      digest(new Uint8Array(await repeated.arrayBuffer())),
    );
    expect(bytes.length).toBeLessThan(original.length);

    const preview = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const expected = await sharp(original)
      .resize({ width: 320 })
      .ensureAlpha()
      .raw()
      .toBuffer();

    expect(preview.info).toMatchObject({
      width: 320,
      height: 160,
      channels: 4,
    });
    expect(digest(preview.data)).toBe(digest(expected));

    const revalidated = await harness.app.request(`${url}&thumbnailWidth=320`, {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });

    expect(revalidated.status).toBe(304);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
    expect(
      (await harness.app.request(`${url}&thumbnailWidth=123`)).status,
    ).toBe(400);
    const unchanged = await harness.app.request(url);
    expect(digest(new Uint8Array(await unchanged.arrayBuffer()))).toBe(
      digest(original),
    );
  });
});

it("resizes colour-profiled images in their own colour space and keeps the profile", async () => {
  await withTestHarness(async (harness) => {
    const { project } = seedThreadFixture(harness);

    const profiled = await sharp(await pattern(512, 256))
      .withIccProfile("p3")
      .png()
      .toBuffer();

    const profile = (await sharp(profiled).metadata()).icc;
    expect(profile).toBeInstanceOf(Buffer);

    const uploaded = await storeAttachment(
      harness.db,
      harness.deps.config.dataDir,
      project.id,
      new File([new Uint8Array(profiled)], "profile.png", {
        type: "image/png",
      }),
    );

    const url = `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`;
    const native = await harness.app.request(url);
    const requested = await harness.app.request(`${url}&thumbnailWidth=160`);
    expect(requested.status).toBe(200);
    expect(requested.headers.get("content-type")).toBe("image/webp");
    expect(requested.headers.get("etag")).not.toBe(native.headers.get("etag"));
    const bytes = Buffer.from(await requested.arrayBuffer());

    expect((await sharp(bytes).metadata()).icc).toEqual(profile);

    const preview = await sharp(bytes, { ignoreIcc: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const expected = await sharp(profiled, { ignoreIcc: true })
      .autoOrient()
      .resize({ width: 160, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer();

    expect(preview.info).toMatchObject({ width: 160, height: 80, channels: 4 });
    expect(digest(preview.data)).toBe(digest(expected));
  });
});

it("serves exact originals for high-depth, animated, narrow, over-tall and undecodable images", async () => {
  await withTestHarness(async (harness) => {
    const { project } = seedThreadFixture(harness);
    const original = await pattern(512, 256);

    const highDepth = await sharp(original)
      .toColourspace("rgb16")
      .png()
      .toBuffer();

    const frames = Buffer.alloc(256 * 256 * 4, 255);
    frames.fill(0, 256 * 128 * 4);

    const animated = await sharp(frames, {
      raw: { width: 256, height: 256, channels: 4, pageHeight: 128 },
    })
      .webp({ lossless: true, loop: 0, delay: [80, 80] })
      .toBuffer();

    const narrow = await pattern(160, 80);

    expect((await sharp(highDepth).metadata()).depth).toBe("ushort");
    expect((await sharp(animated).metadata()).pages).toBe(2);

    for (const fixture of [
      { bytes: highDepth, name: "high-depth.png", mime: "image/png" },
      { bytes: animated, name: "animated.webp", mime: "image/webp" },
      { bytes: narrow, name: "narrow.png", mime: "image/png" },
      {
        bytes: await animatedPng(512, 32),
        name: "animated.png",
        mime: "image/png",
      },
      {
        bytes: await solidPng(165, 17_000),
        name: "taller-than-webp.png",
        mime: "image/png",
      },
      {
        bytes: await jpegWithExtraneousScanBytes(original),
        name: "extraneous.jpg",
        mime: "image/jpeg",
      },
    ]) {
      const uploaded = await storeAttachment(
        harness.db,
        harness.deps.config.dataDir,
        project.id,
        new File([new Uint8Array(fixture.bytes)], fixture.name, {
          type: fixture.mime,
        }),
      );

      const url = `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(uploaded.path)}`;
      const native = await harness.app.request(url);
      const requested = await harness.app.request(`${url}&thumbnailWidth=160`);
      expect(requested.status).toBe(200);
      expect(requested.headers.get("content-type")).toBe(fixture.mime);
      expect(requested.headers.get("etag")).toBe(native.headers.get("etag"));
      expect(digest(new Uint8Array(await requested.arrayBuffer()))).toBe(
        digest(fixture.bytes),
      );
    }
  });
});
