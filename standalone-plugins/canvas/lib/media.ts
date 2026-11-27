import { createRequire } from "node:module";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { mediaManifestSchema, mediaVariantSchema, type MediaManifest } from "../media-contract";

const require = createRequire(new URL("../dist/media-codec/loader.cjs", import.meta.url));

const platformSchema = z.object({ platform: z.string(), arch: z.string() });

const platform = platformSchema.parse(require("./platform.json"));

if (platform.platform !== process.platform || platform.arch !== process.arch)
  throw new Error("Canvas image codec must be prepared for this coordinator's platform");

const sharp: typeof import("sharp").default = require("sharp");

sharp.concurrency(1);

sharp.cache({ memory: 16, files: 0, items: 8 });

const maximumPixels = 16_777_216;

const asset = z.object({ mime: mediaVariantSchema.shape.mime, content: z.instanceof(Buffer) });

const storedManifest = z.object({ manifest_json: z.string() });

export class MediaService {
  private readonly requests = new Map<string, Promise<MediaManifest>>();
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly api: PluginApi) {
    api.onDispose(() => {
      this.disposed = true;
    });
  }

  isImage(id: string): boolean {
    return (
      this.api.storage
        .database()
        .prepare("SELECT 1 FROM assets WHERE id = ? AND mime LIKE 'image/%'")
        .get(id) !== undefined
    );
  }

  exists(id: string): boolean {
    return (
      this.api.storage.database().prepare("SELECT 1 FROM assets WHERE id = ?").get(id) !== undefined
    );
  }

  manifest(id: string): MediaManifest | null {
    const row = this.api.storage
      .database()
      .prepare("SELECT manifest_json FROM canvas_media WHERE asset_id = ?")
      .get(id);

    return row === undefined
      ? null
      : mediaManifestSchema.parse(JSON.parse(storedManifest.parse(row).manifest_json));
  }

  prepare(id: string): Promise<MediaManifest> {
    const cached = this.manifest(id);

    if (cached !== null) return Promise.resolve(cached);
    const existing = this.requests.get(id);

    if (existing !== undefined) return existing;

    if (this.requests.size >= 200)
      return Promise.reject(new Error("Image preparation is busy. Try again shortly."));
    const operation = this.pending.then(() => this.encode(id));
    this.requests.set(id, operation);
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.finally(() => this.requests.delete(id)).catch(() => undefined);

    return operation;
  }

  async prewarm(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.disposed) {
      if (this.requests.size >= 200) {
        await new Promise<void>((resolve) => {
          const stopped = () => resolve();
          signal.addEventListener("abort", stopped, { once: true });
          void this.pending.finally(() => {
            signal.removeEventListener("abort", stopped);
            resolve();
          });
        });
        continue;
      }

      const row = this.api.storage
        .database()
        .prepare(
          "SELECT DISTINCT a.id FROM assets a JOIN nodes n ON n.asset_id = a.id JOIN canvas_threads t ON t.thread_id = n.thread_id WHERE n.archived = 0 AND t.enabled = 1 AND a.mime LIKE 'image/%' AND NOT EXISTS (SELECT 1 FROM canvas_media m WHERE m.asset_id = a.id) AND NOT EXISTS (SELECT 1 FROM canvas_media_failures f WHERE f.asset_id = a.id) LIMIT 1",
        )
        .get();

      if (row === undefined) return;
      const id = z.object({ id: z.string() }).parse(row).id;

      try {
        await this.prepare(id);
      } catch (error) {
        if (signal.aborted || this.disposed) return;
        const message = error instanceof Error ? error.message : "Image preparation failed";
        this.api.storage
          .database()
          .prepare("INSERT OR REPLACE INTO canvas_media_failures(asset_id, message) VALUES (?, ?)")
          .run(id, message);
        this.api.log.warn(
          JSON.stringify({
            message: "Canvas image preparation failed",
            assetId: id,
            detail: message,
          }),
        );
      }
    }
  }

  private async encode(id: string): Promise<MediaManifest> {
    if (this.disposed) throw new Error("Canvas image preparation stopped");
    const database = this.api.storage.database();
    const row = database.prepare("SELECT mime, content FROM assets WHERE id = ?").get(id);

    if (row === undefined) throw new Error("Image not found");
    const image = asset.parse(row);
    const metadata = await sharp(image.content, { limitInputPixels: false }).metadata();
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;

    if (!width || !height) throw new Error("Image dimensions could not be read");
    const originalUrl = `/api/v1/plugins/canvas/http/asset?id=${id}`;
    const animated = (metadata.pages ?? 1) > 1;
    const manifest: MediaManifest = { width, height, animated, originalUrl, variants: [] };
    const variants: { width: number; content: Buffer }[] = [];

    if (
      animated ||
      width * height > maximumPixels ||
      metadata.depth !== "uchar" ||
      metadata.space !== "srgb"
    ) {
      manifest.variants.push({ width, height, url: originalUrl, mime: image.mime, lossless: true });
    } else {
      const deadline = Date.now() + 15_000;

      const create = () =>
        sharp(image.content, { limitInputPixels: maximumPixels })
          .autoOrient()
          .keepIccProfile()
          .timeout({ seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) });

      for (const size of new Set([Math.min(640, width), Math.min(1280, width), width])) {
        if (Date.now() > deadline) throw new Error("Image preparation exceeded its time limit");

        if (size === width && width > 1280) {
          manifest.variants.push({
            width,
            height,
            url: originalUrl,
            mime: image.mime,
            lossless: true,
          });
          continue;
        }

        const result = await create()
          .resize({ width: size, withoutEnlargement: true })
          .webp({ lossless: true, exact: true, effort: 0 })
          .toBuffer({ resolveWithObject: true });

        if (size === width) {
          const [before, after] = await Promise.all([
            create().ensureAlpha().raw().toBuffer(),
            sharp(result.data, { limitInputPixels: maximumPixels }).ensureAlpha().raw().toBuffer(),
          ]);

          if (!before.equals(after)) throw new Error("Lossless image verification failed");

          if (result.data.length >= image.content.length) {
            manifest.variants.push({
              width,
              height,
              url: originalUrl,
              mime: image.mime,
              lossless: true,
            });
            continue;
          }
        }

        variants.push({ width: size, content: result.data });
        manifest.variants.push({
          width: result.info.width,
          height: result.info.height,
          mime: "image/webp",
          lossless: true,
          url: `${originalUrl}&width=${size}`,
        });
      }
    }

    if (this.disposed) throw new Error("Canvas image preparation stopped");
    database.transaction(() => {
      for (const variant of variants)
        database
          .prepare(
            "INSERT OR REPLACE INTO canvas_media_variants(asset_id, width, content) VALUES (?, ?, ?)",
          )
          .run(id, variant.width, variant.content);
      database
        .prepare("INSERT OR REPLACE INTO canvas_media(asset_id, manifest_json) VALUES (?, ?)")
        .run(id, JSON.stringify(manifest));
      database.prepare("DELETE FROM canvas_media_failures WHERE asset_id = ?").run(id);
    })();

    return manifest;
  }
}
