import { Buffer } from "node:buffer";
import type {
  HostDaemonOnlineRpcResultByType,
  HostReadFileIfNoneMatch,
} from "@omnyo/host-daemon-contract";
import { ApiError } from "../../errors.js";

const OCTET_STREAM_MIME_TYPE = "application/octet-stream";

const SHA256_ENTITY_TAG_PATTERN = /^"([a-f0-9]{64})"$/u;

const REVALIDATE_CACHE_CONTROL = "private, no-cache";

type HostReadFileResult = HostDaemonOnlineRpcResultByType["host.read_file"];

export type DaemonFileReadResult =
  | HostReadFileResult
  | HostDaemonOnlineRpcResultByType["host.read_file_relative"];

interface CreateDaemonFileContentResponseOptions {
  headers?: HeadersInit;
  ifNoneMatch?: string | undefined;
}

function daemonFileEntityTag(result: DaemonFileReadResult): string {
  return `"${result.sha256}"`;
}

function entityTagOpaque(tag: string): string {
  return tag.trim().replace(/^W\//u, "");
}

export function requestMatchesEntityTag(
  ifNoneMatch: string | undefined,
  entityTag: string,
): boolean {
  if (ifNoneMatch === undefined) {
    return false;
  }

  const trimmed = ifNoneMatch.trim();

  if (trimmed === "*") {
    return true;
  }

  return trimmed
    .split(",")
    .map(entityTagOpaque)
    .includes(entityTagOpaque(entityTag));
}

export function parseDaemonIfNoneMatch(
  ifNoneMatch: string | undefined,
): HostReadFileIfNoneMatch | undefined {
  if (ifNoneMatch === undefined) {
    return undefined;
  }

  if (ifNoneMatch.trim() === "*") {
    return { kind: "any" };
  }

  const values = ifNoneMatch
    .split(",")
    .map((tag) => SHA256_ENTITY_TAG_PATTERN.exec(entityTagOpaque(tag))?.[1])
    .filter((value): value is string => value !== undefined);

  return values.length > 0 ? { kind: "sha256", values } : undefined;
}

export function requireDaemonFileContentResult(
  result: HostReadFileResult,
): Exclude<HostReadFileResult, { notModified: true }> {
  if ("notModified" in result) {
    throw new Error("Unconditional daemon file read returned not modified");
  }

  return result;
}

function buildFileContentHeaders(
  result: DaemonFileReadResult,
  options: CreateDaemonFileContentResponseOptions,
): Headers {
  const headers = new Headers(options.headers);

  if (!headers.has("content-type")) {
    headers.set("content-type", result.mimeType ?? OCTET_STREAM_MIME_TYPE);
  }

  if (!headers.has("cache-control")) {
    headers.set("cache-control", REVALIDATE_CACHE_CONTROL);
  }

  headers.set("etag", daemonFileEntityTag(result));

  if (result.modifiedAtMs !== undefined) {
    headers.set("last-modified", new Date(result.modifiedAtMs).toUTCString());
  }

  return headers;
}

function decodeDaemonFileContent(
  result: DaemonFileReadResult,
): Buffer<ArrayBuffer> {
  if ("notModified" in result) {
    throw new Error("Cannot decode a not-modified daemon file result");
  }

  return Buffer.from(result.content, result.contentEncoding);
}

export function createDaemonFileContentResponse(
  result: DaemonFileReadResult,
  options: CreateDaemonFileContentResponseOptions = {},
): Response {
  const headers = buildFileContentHeaders(result, options);

  if (
    "notModified" in result ||
    requestMatchesEntityTag(options.ifNoneMatch, daemonFileEntityTag(result))
  ) {
    return new Response(null, { status: 304, headers });
  }

  const content = decodeDaemonFileContent(result);
  headers.set("content-length", String(content.byteLength));

  return new Response(content, {
    status: 200,
    headers,
  });
}

export function remapDaemonFileRouteError(error: unknown): never {
  if (!(error instanceof ApiError)) {
    throw error;
  }

  if (error.body.code === "ENOENT") {
    throw new ApiError(
      404,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }

  if (error.body.code === "invalid_path") {
    throw new ApiError(
      400,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }

  if (error.body.code === "file_too_large") {
    throw new ApiError(
      413,
      error.body.code,
      error.body.message,
      error.body.retryable,
    );
  }

  throw error;
}
