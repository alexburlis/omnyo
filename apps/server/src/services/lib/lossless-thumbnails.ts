import { createHash } from "node:crypto";
import { ApiError } from "../../errors.js";
import type { ServerLogger } from "../../types.js";
import {
  readAttachmentBytes,
  type AttachmentMetadata,
} from "../projects/attachments.js";
import { productionErrorLogFields } from "./error-log-fields.js";

const maximumPixels = 16_777_216;

const maximumWebpDimension = 16_383;

const pngSignatureBytes = 8;

const pngChunkHeaderBytes = 8;

const maximumCacheBytes = 16 * 1024 * 1024;

const maximumEntries = 128;

const maximumPending = 64;

export const losslessThumbnailMimeTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

interface Thumbnail {
  content: Buffer;
  etag: string;
  mimeType: "image/webp";
}

type ImageCodec = typeof import("sharp").default;

type ImageRead = () => Promise<Buffer>;

interface ImageSource {
  read: ImageRead;
  remote: boolean;
}

type FailureReport = (error: unknown) => void;

const cache = new Map<string, Thumbnail | null>();

const requests = new Map<string, Promise<Thumbnail | null>>();

let cacheBytes = 0;

let pending: Promise<void> = Promise.resolve();

let bufferLane: Promise<void> = Promise.resolve();

let codec: Promise<ImageCodec> | null = null;

const settle = () => undefined;

async function imageCodec() {
  codec ??= import("sharp").then(({ default: sharp }) => {
    sharp.concurrency(1);
    sharp.cache({ memory: 16, files: 0, items: 8 });

    return sharp;
  });

  return codec;
}

function remember(key: string, thumbnail: Thumbnail | null): void {
  if (thumbnail !== null && thumbnail.content.length > maximumCacheBytes)
    return;
  cache.set(key, thumbnail);
  cacheBytes += thumbnail?.content.length ?? 0;

  while (cache.size > maximumEntries || cacheBytes > maximumCacheBytes) {
    const first = cache.entries().next().value;

    if (first === undefined) break;
    cache.delete(first[0]);
    cacheBytes -= first[1]?.content.length ?? 0;
  }
}

function isAnimatedPng(input: Buffer): boolean {
  let offset = pngSignatureBytes;

  while (offset + pngChunkHeaderBytes <= input.length) {
    const type = input.toString("latin1", offset + 4, offset + 8);

    if (type === "acTL") return true;

    if (type === "IDAT" || type === "IEND") return false;
    offset += pngChunkHeaderBytes + input.readUInt32BE(offset) + 4;
  }

  return false;
}

async function derive(
  sharp: ImageCodec,
  input: Buffer,
  width: number,
): Promise<Thumbnail | null> {
  const image = await sharp(input, { limitInputPixels: false })
    .timeout({ seconds: 15 })
    .metadata();

  if (
    !["jpeg", "png", "webp"].includes(image.format ?? "") ||
    (image.pages ?? 1) > 1 ||
    image.depth !== "uchar" ||
    image.space !== "srgb" ||
    image.width === undefined ||
    image.height === undefined ||
    image.width * image.height > maximumPixels
  )
    return null;

  const rotated = image.orientation !== undefined && image.orientation >= 5;
  const imageWidth = rotated ? image.height : image.width;
  const imageHeight = rotated ? image.width : image.height;

  if (
    imageWidth <= width ||
    Math.ceil((imageHeight * width) / imageWidth) > maximumWebpDimension
  )
    return null;

  if (image.format === "png" && isAnimatedPng(input)) return null;

  const content = await sharp(input, { limitInputPixels: maximumPixels })
    .autoOrient()
    .keepIccProfile()
    .resize({ width, withoutEnlargement: true })
    .timeout({ seconds: 15 })
    .webp({ lossless: true, exact: true, effort: 0 })
    .toBuffer();

  return {
    content,
    etag: `"${createHash("sha256").update(content).digest("hex")}"`,
    mimeType: "image/webp",
  };
}

async function encode(
  read: ImageRead,
  width: number,
  report: FailureReport,
): Promise<Thumbnail | null> {
  const [sharp, input] = await Promise.all([imageCodec(), read()]);

  try {
    return await derive(sharp, input, width);
  } catch (error) {
    report(error);

    return null;
  }
}

function enqueueEncode(
  read: ImageRead,
  width: number,
  report: FailureReport,
): Promise<Thumbnail | null> {
  const operation = pending.then(() => encode(read, width, report));
  pending = operation.then(settle, settle);

  return operation;
}

function readThenEncode(
  read: ImageRead,
  width: number,
  report: FailureReport,
): Promise<Thumbnail | null> {
  const operation = bufferLane.then(async () => {
    const input = await read();

    return enqueueEncode(async () => input, width, report);
  });

  bufferLane = operation.then(settle, settle);

  return operation;
}

export function prepareLosslessThumbnail(
  key: string,
  width: number,
  source: ImageSource,
  logger: Pick<ServerLogger, "warn">,
): Promise<Thumbnail | null> {
  const cacheKey = `${key}:${width}`;

  if (cache.has(cacheKey)) {
    const thumbnail = cache.get(cacheKey) ?? null;
    cache.delete(cacheKey);
    cache.set(cacheKey, thumbnail);

    return Promise.resolve(thumbnail);
  }

  const existing = requests.get(cacheKey);

  if (existing !== undefined) return existing;

  if (requests.size >= maximumPending)
    return Promise.reject(
      new ApiError(
        503,
        "unavailable",
        "Image preparation is busy. Try again shortly.",
      ),
    );

  const report: FailureReport = (error) =>
    logger.warn(
      {
        ...productionErrorLogFields(error),
        thumbnailKey: key,
        thumbnailWidth: width,
      },
      "Image thumbnail could not be prepared; serving the original",
    );

  const operation = (
    source.remote
      ? readThenEncode(source.read, width, report)
      : enqueueEncode(source.read, width, report)
  ).then((thumbnail) => {
    remember(cacheKey, thumbnail);

    return thumbnail;
  });

  requests.set(cacheKey, operation);
  void operation.finally(() => requests.delete(cacheKey)).catch(settle);

  return operation;
}

export function prepareAttachmentThumbnail(
  metadata: AttachmentMetadata,
  width: number,
  logger: Pick<ServerLogger, "warn">,
): Promise<Thumbnail | null> {
  if (!losslessThumbnailMimeTypes.has(metadata.mimeType ?? ""))
    return Promise.resolve(null);

  return prepareLosslessThumbnail(
    `attachment:${metadata.absolutePath}:${metadata.etag}`,
    width,
    { read: () => readAttachmentBytes(metadata), remote: false },
    logger,
  );
}
