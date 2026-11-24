import { z } from "zod";

export const PREVIEW_HTTP_MAX_BYTES = 16 * 1024 * 1024;

export const PREVIEW_SOCKET_MAX_BYTES = 1024 * 1024;

export const PREVIEW_REQUEST_HEADER_NAMES = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
  "if-range",
  "cache-control",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
  "rsc",
  "next-action",
  "x-nextjs-data",
  "x-requested-with",
] as const;

const id = z.string().min(1).max(256);

const target = { previewId: id, runId: id, accessId: id };

const socketTarget = { ...target, connectionId: id };

export const previewTransportPathSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\\\u0000-\u001f\u007f]/u.test(value),
    "Expected a local preview path",
  );

const headers = z
  .array(z.tuple([z.string().max(256), z.string().max(32768)]))
  .max(128);

const payload = z.string().max(Math.ceil((PREVIEW_HTTP_MAX_BYTES * 4) / 3) + 4);

const socketData = z
  .object({
    dataBase64: z
      .string()
      .max(Math.ceil((PREVIEW_SOCKET_MAX_BYTES * 4) / 3) + 4),
    binary: z.boolean(),
  })
  .strict();

export const previewTransportCommandSchemas = {
  "preview.http": z
    .object({
      type: z.literal("preview.http"),
      ...target,
      path: previewTransportPathSchema,
      method: z.enum([
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ]),
      headers,
      bodyBase64: payload,
    })
    .strict(),
  "preview.socket.open": z
    .object({
      type: z.literal("preview.socket.open"),
      ...socketTarget,
      path: previewTransportPathSchema,
      protocols: z.array(z.string().min(1).max(256)).max(16),
    })
    .strict(),
  "preview.socket.read": z
    .object({ type: z.literal("preview.socket.read"), ...socketTarget })
    .strict(),
  "preview.socket.write": z
    .object({
      type: z.literal("preview.socket.write"),
      ...socketTarget,
      ...socketData.shape,
    })
    .strict(),
  "preview.socket.close": z
    .object({ type: z.literal("preview.socket.close"), ...socketTarget })
    .strict(),
};

export const previewTransportResultSchemas = {
  "preview.http": z
    .object({
      status: z.number().int().min(100).max(599),
      headers,
      bodyBase64: payload,
    })
    .strict(),
  "preview.socket.open": z.object({ protocol: z.string().max(256) }).strict(),
  "preview.socket.read": z
    .object({ messages: z.array(socketData).max(64), closed: z.boolean() })
    .strict(),
  "preview.socket.write": z.object({}).strict(),
  "preview.socket.close": z.object({}).strict(),
};

export type PreviewTransportCommandByType = {
  [K in keyof typeof previewTransportCommandSchemas]: z.infer<
    (typeof previewTransportCommandSchemas)[K]
  >;
};

export type PreviewTransportResultByType = {
  [K in keyof typeof previewTransportResultSchemas]: z.infer<
    (typeof previewTransportResultSchemas)[K]
  >;
};

export type PreviewTransportCommand =
  PreviewTransportCommandByType[keyof PreviewTransportCommandByType];
