import { z } from "zod";
import { HOST_FILE_CHUNK_MAX_BYTES } from "./commands.js";
import {
  hostDaemonDaemonWsMessageSchema,
  type HostDaemonDaemonWsMessage,
} from "./session.js";

const HEADER_LENGTH_BYTES = 4;

const BULK_MIN_BYTES = 4 * 1024;

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type DaemonWirePayload = string | Uint8Array;

export function isDaemonBulkPayload(
  message: HostDaemonDaemonWsMessage,
  wireBytes: number,
): boolean {
  return (
    wireBytes >= BULK_MIN_BYTES &&
    (message.type === "terminal.output" ||
      message.type === "terminal.replay" ||
      (message.type === "host-rpc.response" &&
        message.ok &&
        message.commandType === "host.read_file_chunk"))
  );
}

export function encodeDaemonWirePayload(
  message: HostDaemonDaemonWsMessage,
): DaemonWirePayload {
  if (
    message.type !== "host-rpc.response" ||
    !message.ok ||
    message.commandType !== "host.read_file_chunk"
  ) {
    return JSON.stringify(message);
  }

  const { content, ...result } = message.result;
  const header = textEncoder.encode(JSON.stringify({ ...message, result }));

  const frame = new Uint8Array(
    HEADER_LENGTH_BYTES + header.byteLength + content.byteLength,
  );

  new DataView(frame.buffer).setUint32(0, header.byteLength);
  frame.set(header, HEADER_LENGTH_BYTES);
  frame.set(content, HEADER_LENGTH_BYTES + header.byteLength);

  return frame;
}

const binaryFileCarrierSchema = z
  .object({
    type: z.literal("host-rpc.response"),
    ok: z.literal(true),
    commandType: z.literal("host.read_file_chunk"),
    result: z.object({ content: z.never().optional() }).passthrough(),
  })
  .passthrough();

function decodeBinaryFileFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < HEADER_LENGTH_BYTES) return null;

  const headerEnd =
    HEADER_LENGTH_BYTES +
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);

  if (
    headerEnd > frame.byteLength ||
    frame.byteLength - headerEnd > HOST_FILE_CHUNK_MAX_BYTES
  )
    return null;

  const json: unknown = JSON.parse(
    textDecoder.decode(frame.subarray(HEADER_LENGTH_BYTES, headerEnd)),
  );

  const carrier = binaryFileCarrierSchema.safeParse(json);

  if (!carrier.success) return null;

  return {
    ...carrier.data,
    result: { ...carrier.data.result, content: frame.subarray(headerEnd) },
  };
}

export function decodeDaemonWirePayload(
  raw: unknown,
): { message: HostDaemonDaemonWsMessage; wireBytes: number } | null {
  try {
    const frame =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : raw instanceof Uint8Array
          ? raw
          : null;

    const decoded: unknown =
      typeof raw === "string"
        ? JSON.parse(raw)
        : frame === null
          ? null
          : decodeBinaryFileFrame(frame);

    const parsed = hostDaemonDaemonWsMessageSchema.safeParse(decoded);

    if (!parsed.success) return null;

    return {
      message: parsed.data,
      wireBytes: frame?.byteLength ?? 0,
    };
  } catch {
    return null;
  }
}
