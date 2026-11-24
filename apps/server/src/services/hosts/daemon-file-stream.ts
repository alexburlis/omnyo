import { Buffer } from "node:buffer";
import {
  HOST_FILE_CHUNK_MAX_BYTES,
  type HostDaemonOnlineRpcResultByType,
} from "@omnyo/host-daemon-contract";
import { ApiError } from "../../errors.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { LoggedWorkSessionDeps, ServerLogger } from "../../types.js";
import { callHostRetryableOnlineRpc } from "./online-rpc.js";
import {
  remapDaemonFileRouteError,
  requestMatchesEntityTag,
} from "./daemon-file-response.js";
import { parseSingleByteRange } from "./file-byte-range.js";
import {
  losslessThumbnailMimeTypes,
  prepareLosslessThumbnail,
} from "../lib/lossless-thumbnails.js";

const THUMBNAIL_TAG_TOKEN = "t1";

const THUMBNAIL_SOURCE_MAX_BYTES = 16 * 1024 * 1024;

const FILE_READ_AHEAD_CHUNKS = 16;

type FileChunk = HostDaemonOnlineRpcResultByType["host.read_file_chunk"];

type ReadChunk = (
  offset: number,
  length: number,
  revision: string | null,
  signal: AbortSignal,
) => Promise<FileChunk>;

interface ThumbnailResponseArgs {
  headers: Headers;
  key: string;
  logger: Pick<ServerLogger, "warn">;
  metadata: FileChunk;
  read: ReadChunk;
  request: Request;
  width: number;
}

async function readVerifiedChunk(
  read: ReadChunk,
  metadata: FileChunk,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunk = await read(offset, length, metadata.revision, signal);
  signal.throwIfAborted();

  if (
    chunk.revision !== metadata.revision ||
    chunk.sizeBytes !== metadata.sizeBytes ||
    chunk.offset !== offset ||
    chunk.content.byteLength !== length
  ) {
    throw new ApiError(
      409,
      "file_changed",
      "File changed or returned an incomplete chunk",
      true,
    );
  }

  return new Uint8Array(chunk.content);
}

function createVerifiedChunkReader(args: {
  read: ReadChunk;
  metadata: FileChunk;
  start: number;
  end: number;
  requestSignal: AbortSignal;
}) {
  const stop = new AbortController();
  const signal = AbortSignal.any([args.requestSignal, stop.signal]);
  const pending: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let nextOffset = args.start;

  function fillQueue(): void {
    while (pending.length < FILE_READ_AHEAD_CHUNKS && nextOffset <= args.end) {
      const offset = nextOffset;
      const length = Math.min(HOST_FILE_CHUNK_MAX_BYTES, args.end - offset + 1);
      nextOffset += length;

      const chunk = readVerifiedChunk(
        args.read,
        args.metadata,
        offset,
        length,
        signal,
      ).catch((error: unknown) => {
        stop.abort(error);
        throw error;
      });

      void chunk.catch(() => undefined);
      pending.push(chunk);
    }
  }

  return {
    async take(): Promise<Uint8Array<ArrayBuffer>> {
      signal.throwIfAborted();
      fillQueue();
      const chunk = pending.shift();

      if (chunk === undefined)
        throw new Error("File chunk stream is exhausted");

      return chunk;
    },
    cancel() {
      stop.abort();
      pending.length = 0;
    },
  };
}

async function readWholeFile(
  read: ReadChunk,
  metadata: FileChunk,
  signal: AbortSignal,
): Promise<Buffer> {
  const content = Buffer.allocUnsafe(metadata.sizeBytes);

  const reader = createVerifiedChunkReader({
    read,
    metadata,
    start: 0,
    end: metadata.sizeBytes - 1,
    requestSignal: signal,
  });

  let offset = 0;

  while (offset < content.length) {
    const bytes = await reader.take();
    content.set(bytes, offset);
    offset += bytes.length;
  }

  return content;
}

function isThumbnailSource(metadata: FileChunk): boolean {
  return (
    losslessThumbnailMimeTypes.has(metadata.mimeType ?? "") &&
    metadata.sizeBytes > 0 &&
    metadata.sizeBytes <= THUMBNAIL_SOURCE_MAX_BYTES
  );
}

async function createThumbnailResponse({
  headers,
  key,
  logger,
  metadata,
  read,
  request,
  width,
}: ThumbnailResponseArgs): Promise<Response> {
  const entityTag = `W/"file-${metadata.revision}-w${width}-${THUMBNAIL_TAG_TOKEN}"`;
  headers.set("etag", entityTag);
  headers.set("last-modified", new Date(metadata.modifiedAtMs).toUTCString());

  if (!headers.has("cache-control"))
    headers.set("cache-control", "private, no-cache");

  if (
    requestMatchesEntityTag(
      request.headers.get("if-none-match") ?? undefined,
      entityTag,
    )
  ) {
    return new Response(null, { status: 304, headers });
  }

  const thumbnail = await prepareLosslessThumbnail(
    key,
    width,
    { read: () => readWholeFile(read, metadata, request.signal), remote: true },
    logger,
  );

  if (thumbnail === null)
    return createDaemonFileStreamResponse(
      metadata,
      read,
      request,
      headers,
      entityTag,
    );

  headers.set("content-type", thumbnail.mimeType);
  headers.set("content-length", String(thumbnail.content.length));

  return new Response(
    request.method === "HEAD" ? null : new Uint8Array(thumbnail.content),
    { status: 200, headers },
  );
}

export async function serveDaemonFileStream(
  deps: LoggedWorkSessionDeps,
  target: { hostId: string; path: string; rootPath: string },
  request: Request,
  prepareHeaders: (metadata: FileChunk) => Headers,
  thumbnailWidth: number | null,
): Promise<Response> {
  const read: ReadChunk = (offset, length, revision, signal) =>
    callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file_chunk",
        path: target.path,
        rootPath: target.rootPath,
        offset,
        length,
        revision,
      },
    });

  try {
    const firstLength =
      request.method === "GET" &&
      thumbnailWidth === null &&
      !request.headers.has("range") &&
      !request.headers.has("if-none-match") &&
      /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(target.path)
        ? HOST_FILE_CHUNK_MAX_BYTES
        : 0;

    const metadata = await read(0, firstLength, null, request.signal);
    request.signal.throwIfAborted();

    if (
      metadata.offset !== 0 ||
      metadata.content.byteLength !== Math.min(firstLength, metadata.sizeBytes)
    )
      throw new ApiError(
        409,
        "file_changed",
        "Incomplete initial file chunk",
        true,
      );
    const headers = prepareHeaders(metadata);

    if (thumbnailWidth !== null && isThumbnailSource(metadata)) {
      return await createThumbnailResponse({
        headers,
        key: `host:${target.hostId}:${target.path}:${metadata.revision}`,
        logger: deps.logger,
        metadata,
        read,
        request,
        width: thumbnailWidth,
      });
    }

    return await createDaemonFileStreamResponse(
      metadata,
      read,
      request,
      headers,
    );
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "file_changed") {
      throw new ApiError(
        409,
        "file_changed",
        "File changed during read; retry the request",
        true,
      );
    }

    return remapDaemonFileRouteError(error);
  }
}

export async function createDaemonFileStreamResponse(
  metadata: FileChunk,
  read: ReadChunk,
  request: Request,
  headers = new Headers(),
  entityTag = `W/"file-${metadata.revision}"`,
): Promise<Response> {
  headers.set("accept-ranges", "bytes");
  headers.set("etag", entityTag);
  headers.set("last-modified", new Date(metadata.modifiedAtMs).toUTCString());

  if (!headers.has("content-type"))
    headers.set(
      "content-type",
      metadata.mimeType ?? "application/octet-stream",
    );

  if (!headers.has("cache-control"))
    headers.set("cache-control", "private, no-cache");

  if (
    headers.get("cache-control") !== "no-store" &&
    requestMatchesEntityTag(
      request.headers.get("if-none-match") ?? undefined,
      entityTag,
    )
  ) {
    return new Response(null, { status: 304, headers });
  }

  let start = 0;
  let end = metadata.sizeBytes - 1;
  let status = 200;
  const rangeHeader = request.headers.get("range");

  if (
    request.method === "GET" &&
    rangeHeader &&
    !request.headers.has("if-range")
  ) {
    const range = parseSingleByteRange(rangeHeader, metadata.sizeBytes);

    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${metadata.sizeBytes}`);
      headers.set("content-length", "0");

      return new Response(null, { status: 416, headers });
    }

    if (range) {
      ({ start, end } = range);
      status = 206;
      headers.set(
        "content-range",
        `bytes ${start}-${end}/${metadata.sizeBytes}`,
      );
    }
  }

  headers.set("content-length", String(end - start + 1));

  if (request.method === "HEAD" || metadata.sizeBytes === 0) {
    return new Response(null, { status, headers });
  }

  const initial = metadata.content.subarray(start, end + 1);

  if (initial.byteLength === end - start + 1)
    return new Response(new Uint8Array(initial), { status, headers });

  const reader = createVerifiedChunkReader({
    read,
    metadata,
    start: start + initial.byteLength,
    end,
    requestSignal: request.signal,
  });

  let next = start;

  let first: Uint8Array<ArrayBuffer> | null =
    initial.byteLength > 0 ? new Uint8Array(initial) : await reader.take();

  let cancelled = false;

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          request.signal.throwIfAborted();
          const bytes = first ?? (await reader.take());
          first = null;

          if (cancelled) return;
          next += bytes.length;
          controller.enqueue(bytes);

          if (next > end) controller.close();
        } catch (error) {
          reader.cancel();

          if (!cancelled) controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
        first = null;
        reader.cancel();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, { status, headers });
}
