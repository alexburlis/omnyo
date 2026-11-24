export const PROTOCOL_VERSION = 1;

export const TUNNEL_PROTOCOL_QUERY_PARAM = "v";

export const HEARTBEAT_REQUEST = "bbt:hb";

export const HEARTBEAT_RESPONSE = "bbt:hb-ack";

export const TUNNEL_REPLACED_CLOSE_REASON =
  "replaced by a new tunnel connection";

export const MAX_CHUNK_BYTES = 1024 * 1024;

export const MAX_CONTROL_FRAME_PAYLOAD_BYTES = 64 * 1024;

export class InvalidFrameError extends Error {
  readonly streamId: number | null;

  constructor(message: string, streamId: number | null) {
    super(`tunnel-contract: ${message}`);
    this.name = "InvalidFrameError";
    this.streamId = streamId;
  }
}

export class ControlFrameTooLargeError extends Error {
  readonly frameType: Frame["type"];
  readonly payloadBytes: number;

  constructor(frameType: Frame["type"], payloadBytes: number) {
    super(
      `tunnel-contract: ${frameType} frame payload of ${payloadBytes} bytes exceeds the ${MAX_CONTROL_FRAME_PAYLOAD_BYTES}-byte control frame limit`,
    );
    this.name = "ControlFrameTooLargeError";
    this.frameType = frameType;
    this.payloadBytes = payloadBytes;
  }
}

const FRAME_TYPE = {
  openHttp: 1,
  bodyChunk: 2,
  bodyEnd: 3,
  respHead: 4,
  openWs: 5,
  wsOpenAck: 6,
  wsData: 7,
  closeStream: 8,
} as const;

export type HeaderPair = [name: string, value: string];

export interface OpenHttpFrame {
  type: "open-http";
  streamId: number;
  method: string;
  path: string;
  headers: HeaderPair[];
  hasBody: boolean;
  target?: string;
}

interface BodyChunkFrame {
  type: "body-chunk";
  streamId: number;
  data: Uint8Array;
}

interface BodyEndFrame {
  type: "body-end";
  streamId: number;
}

interface RespHeadFrame {
  type: "resp-head";
  streamId: number;
  status: number;
  headers: HeaderPair[];
}

export interface OpenWsFrame {
  type: "open-ws";
  streamId: number;
  path: string;
  headers: HeaderPair[];
  protocols: string[];
  target?: string;
}

interface WsOpenAckFrame {
  type: "ws-open-ack";
  streamId: number;
  protocol: string | null;
}

interface WsDataFrame {
  type: "ws-data";
  streamId: number;
  isBinary: boolean;
  data: Uint8Array;
}

interface CloseStreamFrame {
  type: "close-stream";
  streamId: number;
  code: number;
  reason: string;
}

export type Frame =
  | OpenHttpFrame
  | BodyChunkFrame
  | BodyEndFrame
  | RespHeadFrame
  | OpenWsFrame
  | WsOpenAckFrame
  | WsDataFrame
  | CloseStreamFrame;

const FRAME_TYPE_NAMES = new Map<number, Frame["type"]>([
  [FRAME_TYPE.openHttp, "open-http"],
  [FRAME_TYPE.bodyChunk, "body-chunk"],
  [FRAME_TYPE.bodyEnd, "body-end"],
  [FRAME_TYPE.respHead, "resp-head"],
  [FRAME_TYPE.openWs, "open-ws"],
  [FRAME_TYPE.wsOpenAck, "ws-open-ack"],
  [FRAME_TYPE.wsData, "ws-data"],
  [FRAME_TYPE.closeStream, "close-stream"],
]);

const FRAME_HEADER_BYTES = 5;

function frameBytes(message: ArrayBuffer | Uint8Array): Uint8Array {
  const buf = message instanceof Uint8Array ? message : new Uint8Array(message);

  if (buf.length < FRAME_HEADER_BYTES) {
    throw new InvalidFrameError(`frame too short (${buf.length} bytes)`, null);
  }

  return buf;
}

export function peekFrame(message: ArrayBuffer | Uint8Array): {
  type: Frame["type"];
  streamId: number;
} {
  const buf = frameBytes(message);
  const type = FRAME_TYPE_NAMES.get(buf[0]);

  if (type === undefined) {
    throw new InvalidFrameError(`unknown frame type ${buf[0]}`, null);
  }

  return {
    type,
    streamId: new DataView(buf.buffer, buf.byteOffset).getUint32(1),
  };
}

export function setFrameStreamId(
  message: ArrayBuffer | Uint8Array,
  streamId: number,
): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new Error(`tunnel-contract: stream id out of range: ${streamId}`);
  }

  const buf = frameBytes(message);
  new DataView(buf.buffer, buf.byteOffset).setUint32(1, streamId);

  return buf;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

function withHeader(
  type: number,
  streamId: number,
  payload: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new Error(`tunnel-contract: stream id out of range: ${streamId}`);
  }

  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId);
  out.set(payload, 5);

  return out;
}

function jsonPayload(type: Frame["type"], value: unknown): Uint8Array {
  const payload = encoder.encode(JSON.stringify(value));

  if (payload.length > MAX_CONTROL_FRAME_PAYLOAD_BYTES) {
    throw new ControlFrameTooLargeError(type, payload.length);
  }

  return payload;
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case "open-http":
      return withHeader(
        FRAME_TYPE.openHttp,
        frame.streamId,
        jsonPayload("open-http", {
          method: frame.method,
          path: frame.path,
          headers: frame.headers,
          hasBody: frame.hasBody,
          ...(frame.target !== undefined ? { target: frame.target } : {}),
        }),
      );
    case "body-chunk": {
      if (frame.data.length > MAX_CHUNK_BYTES) {
        throw new Error(
          `tunnel-contract: body chunk of ${frame.data.length} bytes exceeds MAX_CHUNK_BYTES`,
        );
      }

      return withHeader(FRAME_TYPE.bodyChunk, frame.streamId, frame.data);
    }

    case "body-end":
      return withHeader(FRAME_TYPE.bodyEnd, frame.streamId, new Uint8Array(0));
    case "resp-head":
      return withHeader(
        FRAME_TYPE.respHead,
        frame.streamId,
        jsonPayload("resp-head", {
          status: frame.status,
          headers: frame.headers,
        }),
      );
    case "open-ws":
      return withHeader(
        FRAME_TYPE.openWs,
        frame.streamId,
        jsonPayload("open-ws", {
          path: frame.path,
          headers: frame.headers,
          protocols: frame.protocols,
          ...(frame.target !== undefined ? { target: frame.target } : {}),
        }),
      );
    case "ws-open-ack":
      return withHeader(
        FRAME_TYPE.wsOpenAck,
        frame.streamId,
        jsonPayload("ws-open-ack", { protocol: frame.protocol }),
      );
    case "ws-data": {
      const payload = new Uint8Array(1 + frame.data.length);
      payload[0] = frame.isBinary ? 1 : 0;
      payload.set(frame.data, 1);

      return withHeader(FRAME_TYPE.wsData, frame.streamId, payload);
    }

    case "close-stream":
      return withHeader(
        FRAME_TYPE.closeStream,
        frame.streamId,
        jsonPayload("close-stream", { code: frame.code, reason: frame.reason }),
      );
  }
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/u;

const MIN_RESPONSE_STATUS = 200;

const MAX_RESPONSE_STATUS = 599;

const MIN_CLOSE_CODE = 1000;

const MAX_CLOSE_CODE = 4999;

type FrameName = Frame["type"];

interface ControlPayload {
  what: FrameName;
  streamId: number;
  meta: object;
}

function invalid(payload: ControlPayload, detail: string): InvalidFrameError {
  return new InvalidFrameError(
    `invalid ${payload.what} frame: ${detail}`,
    payload.streamId,
  );
}

function controlPayload(
  bytes: Uint8Array,
  what: FrameName,
  streamId: number,
): ControlPayload {
  if (bytes.byteLength > MAX_CONTROL_FRAME_PAYLOAD_BYTES) {
    throw new InvalidFrameError(
      `${what} frame payload of ${bytes.byteLength} bytes exceeds the ${MAX_CONTROL_FRAME_PAYLOAD_BYTES}-byte control frame limit`,
      streamId,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InvalidFrameError(`malformed ${what} frame payload`, streamId);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidFrameError(
      `invalid ${what} frame: payload is not an object`,
      streamId,
    );
  }

  return { what, streamId, meta: parsed };
}

function field(payload: ControlPayload, key: string): unknown {
  return Object.hasOwn(payload.meta, key)
    ? Reflect.get(payload.meta, key)
    : undefined;
}

function stringField(payload: ControlPayload, key: string): string {
  const value = field(payload, key);

  if (typeof value !== "string")
    throw invalid(payload, `${key} is not a string`);

  return value;
}

function tokenField(payload: ControlPayload, key: string): string {
  const value = stringField(payload, key);

  if (!HTTP_TOKEN.test(value)) {
    throw invalid(payload, `${key} is not an HTTP token`);
  }

  return value;
}

function pathField(payload: ControlPayload): string {
  const value = stringField(payload, "path");

  if (!value.startsWith("/"))
    throw invalid(payload, "path does not start with /");

  return value;
}

function booleanField(payload: ControlPayload, key: string): boolean {
  const value = field(payload, key);

  if (typeof value !== "boolean") {
    throw invalid(payload, `${key} is not a boolean`);
  }

  return value;
}

function integerField(
  payload: ControlPayload,
  key: string,
  min: number,
  max: number,
): number {
  const value = field(payload, key);

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw invalid(payload, `${key} is not an integer from ${min} to ${max}`);
  }

  return value;
}

function targetField(payload: ControlPayload): { target?: string } {
  const value = field(payload, "target");

  if (value === undefined) return {};

  if (typeof value !== "string")
    throw invalid(payload, "target is not a string");

  return { target: value };
}

function stringListField(payload: ControlPayload, key: string): string[] {
  const value = field(payload, key);

  if (!Array.isArray(value)) throw invalid(payload, `${key} is not an array`);
  const items: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      throw invalid(payload, `${key} holds a value that is not a string`);
    }

    items.push(item);
  }

  return items;
}

function headersField(payload: ControlPayload): HeaderPair[] {
  const value = field(payload, "headers");

  if (!Array.isArray(value)) throw invalid(payload, "headers is not an array");
  const headers: HeaderPair[] = [];

  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw invalid(payload, "a header is not a [name, value] pair");
    }

    const [name, headerValue]: unknown[] = pair;

    if (typeof name !== "string" || !HTTP_TOKEN.test(name)) {
      throw invalid(payload, "a header name is not an HTTP token");
    }

    if (typeof headerValue !== "string" || !HEADER_VALUE.test(headerValue)) {
      throw invalid(payload, `the value of header ${name} is not writable`);
    }

    headers.push([name, headerValue]);
  }

  return headers;
}

function protocolField(payload: ControlPayload): string | null {
  const value = field(payload, "protocol");

  if (value === null) return null;

  if (typeof value !== "string" || !HTTP_TOKEN.test(value)) {
    throw invalid(payload, "protocol is neither null nor a subprotocol token");
  }

  return value;
}

export function decodeFrame(message: ArrayBuffer | Uint8Array): Frame {
  const buf = frameBytes(message);
  const type = buf[0];
  const streamId = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
  const payload = buf.subarray(FRAME_HEADER_BYTES);

  switch (type) {
    case FRAME_TYPE.openHttp: {
      const meta = controlPayload(payload, "open-http", streamId);

      return {
        type: "open-http",
        streamId,
        method: tokenField(meta, "method"),
        path: pathField(meta),
        headers: headersField(meta),
        hasBody: booleanField(meta, "hasBody"),
        ...targetField(meta),
      };
    }

    case FRAME_TYPE.bodyChunk:
      if (payload.length > MAX_CHUNK_BYTES) {
        throw new InvalidFrameError(
          `body-chunk of ${payload.length} bytes exceeds MAX_CHUNK_BYTES`,
          streamId,
        );
      }

      return { type: "body-chunk", streamId, data: payload };
    case FRAME_TYPE.bodyEnd:
      return { type: "body-end", streamId };
    case FRAME_TYPE.respHead: {
      const meta = controlPayload(payload, "resp-head", streamId);

      return {
        type: "resp-head",
        streamId,
        status: integerField(
          meta,
          "status",
          MIN_RESPONSE_STATUS,
          MAX_RESPONSE_STATUS,
        ),
        headers: headersField(meta),
      };
    }

    case FRAME_TYPE.openWs: {
      const meta = controlPayload(payload, "open-ws", streamId);

      return {
        type: "open-ws",
        streamId,
        path: pathField(meta),
        headers: headersField(meta),
        protocols: stringListField(meta, "protocols"),
        ...targetField(meta),
      };
    }

    case FRAME_TYPE.wsOpenAck: {
      const meta = controlPayload(payload, "ws-open-ack", streamId);

      return { type: "ws-open-ack", streamId, protocol: protocolField(meta) };
    }

    case FRAME_TYPE.wsData: {
      if (payload.length < 1) {
        throw new InvalidFrameError(
          "ws-data frame missing binary flag",
          streamId,
        );
      }

      return {
        type: "ws-data",
        streamId,
        isBinary: payload[0] === 1,
        data: payload.subarray(1),
      };
    }

    case FRAME_TYPE.closeStream: {
      const meta = controlPayload(payload, "close-stream", streamId);

      return {
        type: "close-stream",
        streamId,
        code: integerField(meta, "code", MIN_CLOSE_CODE, MAX_CLOSE_CODE),
        reason: stringField(meta, "reason"),
      };
    }

    default:
      throw new InvalidFrameError(`unknown frame type ${type}`, null);
  }
}

export function* chunkBody(
  streamId: number,
  data: Uint8Array,
): Generator<BodyChunkFrame> {
  for (let offset = 0; offset < data.length; offset += MAX_CHUNK_BYTES) {
    yield {
      type: "body-chunk",
      streamId,
      data: data.subarray(
        offset,
        Math.min(offset + MAX_CHUNK_BYTES, data.length),
      ),
    };
  }
}
