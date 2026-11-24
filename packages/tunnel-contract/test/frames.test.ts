import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  ControlFrameTooLargeError,
  InvalidFrameError,
  MAX_CHUNK_BYTES,
  MAX_CONTROL_FRAME_PAYLOAD_BYTES,
  chunkBody,
  decodeFrame,
  encodeFrame,
  peekFrame,
  setFrameStreamId,
  type Frame,
} from "../src/index.js";

const FRAME_TYPE_CODE = {
  "open-http": 1,
  "resp-head": 4,
  "open-ws": 5,
  "ws-open-ack": 6,
  "close-stream": 8,
} as const;

function roundTrip(frame: Frame): Frame {
  return decodeFrame(encodeFrame(frame));
}

function rawFrame(
  type: keyof typeof FRAME_TYPE_CODE,
  streamId: number,
  payload: string,
): Uint8Array {
  const bytes = Buffer.from(payload, "utf8");
  const out = Buffer.alloc(5 + bytes.length);
  out[0] = FRAME_TYPE_CODE[type];
  out.writeUInt32BE(streamId, 1);
  bytes.copy(out, 5);

  return new Uint8Array(out);
}

function refusal(frame: Uint8Array): InvalidFrameError {
  try {
    decodeFrame(frame);
  } catch (error) {
    if (error instanceof InvalidFrameError) return error;
    throw error;
  }

  throw new Error("expected decodeFrame to refuse the frame");
}

describe("frame round-trips", () => {
  it("open-http without target", () => {
    const frame: Frame = {
      type: "open-http",
      streamId: 7,
      method: "POST",
      path: "/api/v1/threads?limit=5",
      headers: [
        ["content-type", "application/json"],
        ["accept", "*/*"],
      ],
      hasBody: true,
    };

    const out = roundTrip(frame);
    expect(out).toEqual(frame);
    expect(out.type).toBe("open-http");

    if (out.type !== "open-http") throw new Error("unreachable");
    expect(out.target).toBeUndefined();
  });

  it("open-http with target", () => {
    const frame: Frame = {
      type: "open-http",
      streamId: 7,
      method: "GET",
      path: "/",
      headers: [],
      hasBody: false,
      target: "8000",
    };

    expect(roundTrip(frame)).toEqual(frame);
  });

  it("open-http encoded without target decodes with target undefined", () => {
    const encoded = encodeFrame({
      type: "open-http",
      streamId: 1,
      method: "GET",
      path: "/",
      headers: [],
      hasBody: false,
    });

    const payload = new TextDecoder().decode(encoded.subarray(5));
    expect(payload).not.toContain("target");
    const out = decodeFrame(encoded);

    if (out.type !== "open-http") throw new Error("unreachable");
    expect(out.target).toBeUndefined();
  });

  it("body-chunk preserves bytes exactly", () => {
    const data = new Uint8Array(1000);

    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const out = roundTrip({ type: "body-chunk", streamId: 0xffffffff, data });
    expect(out.type).toBe("body-chunk");

    if (out.type !== "body-chunk") throw new Error("unreachable");
    expect(out.streamId).toBe(0xffffffff);
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });

  it("resp-head", () => {
    const frame: Frame = {
      type: "resp-head",
      streamId: 12,
      status: 204,
      headers: [
        ["x-thing", "value with spaces / latin-1 é\tand a tab"],
        ["x-empty", ""],
        ["!#$%&'*+-.^_`|~09AZaz", "every token character"],
      ],
    };

    expect(roundTrip(frame)).toEqual(frame);
  });

  it("open-ws without target", () => {
    const open: Frame = {
      type: "open-ws",
      streamId: 20,
      path: "/ws",
      headers: [["cookie", "a=b"]],
      protocols: ["omnyo.v1"],
    };

    const out = roundTrip(open);
    expect(out).toEqual(open);

    if (out.type !== "open-ws") throw new Error("unreachable");
    expect(out.target).toBeUndefined();
  });

  it("open-ws with target", () => {
    const open: Frame = {
      type: "open-ws",
      streamId: 21,
      path: "/ws",
      headers: [],
      protocols: [],
      target: "5173",
    };

    expect(roundTrip(open)).toEqual(open);
  });

  it("open-ws encoded without target decodes with target undefined", () => {
    const encoded = encodeFrame({
      type: "open-ws",
      streamId: 2,
      path: "/ws",
      headers: [],
      protocols: [],
    });

    const payload = new TextDecoder().decode(encoded.subarray(5));
    expect(payload).not.toContain("target");
    const out = decodeFrame(encoded);

    if (out.type !== "open-ws") throw new Error("unreachable");
    expect(out.target).toBeUndefined();
  });

  it("ws-open-ack / ws-data / close-stream", () => {
    expect(
      roundTrip({ type: "ws-open-ack", streamId: 20, protocol: null }),
    ).toEqual({
      type: "ws-open-ack",
      streamId: 20,
      protocol: null,
    });
    expect(
      roundTrip({ type: "ws-open-ack", streamId: 20, protocol: "omnyo.v1" }),
    ).toEqual({
      type: "ws-open-ack",
      streamId: 20,
      protocol: "omnyo.v1",
    });

    const text = roundTrip({
      type: "ws-data",
      streamId: 20,
      isBinary: false,
      data: new TextEncoder().encode("hello"),
    });

    if (text.type !== "ws-data") throw new Error("unreachable");
    expect(text.isBinary).toBe(false);
    expect(new TextDecoder().decode(text.data)).toBe("hello");

    const binary = roundTrip({
      type: "ws-data",
      streamId: 20,
      isBinary: true,
      data: new Uint8Array([0, 1, 2, 255]),
    });

    if (binary.type !== "ws-data") throw new Error("unreachable");
    expect(binary.isBinary).toBe(true);

    expect(
      roundTrip({
        type: "close-stream",
        streamId: 20,
        code: 1000,
        reason: "done",
      }),
    ).toEqual({
      type: "close-stream",
      streamId: 20,
      code: 1000,
      reason: "done",
    });
  });

  it("decodes from an ArrayBuffer (worker message shape)", () => {
    const encoded = encodeFrame({ type: "body-end", streamId: 9 });
    const copy = new ArrayBuffer(encoded.length);
    new Uint8Array(copy).set(encoded);
    expect(decodeFrame(copy)).toEqual({ type: "body-end", streamId: 9 });
  });
});

describe("validation", () => {
  it("rejects out-of-range stream ids", () => {
    expect(() => encodeFrame({ type: "body-end", streamId: -1 })).toThrow(
      /out of range/,
    );
    expect(() => encodeFrame({ type: "body-end", streamId: 2 ** 32 })).toThrow(
      /out of range/,
    );
  });

  it("rejects oversized chunks and truncated/unknown frames", () => {
    expect(() =>
      encodeFrame({
        type: "body-chunk",
        streamId: 1,
        data: new Uint8Array(MAX_CHUNK_BYTES + 1),
      }),
    ).toThrow(/exceeds MAX_CHUNK_BYTES/);
    expect(() => decodeFrame(new Uint8Array([1, 0, 0]))).toThrow(/too short/);
    expect(() => decodeFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(
      /unknown frame type/,
    );
  });

  it("refuses a decoded body-chunk above MAX_CHUNK_BYTES and names its stream", () => {
    const atLimit = new Uint8Array(5 + MAX_CHUNK_BYTES);
    atLimit[0] = 2;
    atLimit[4] = 7;
    expect(decodeFrame(atLimit).type).toBe("body-chunk");

    const over = new Uint8Array(6 + MAX_CHUNK_BYTES);
    over[0] = 2;
    over[4] = 7;
    const error = refusal(over);

    expect(error.message).toMatch(/exceeds MAX_CHUNK_BYTES/);
    expect(error.streamId).toBe(7);
  });

  it("rejects malformed JSON metadata", () => {
    const bad = new Uint8Array(5 + 3);
    bad[0] = 1;
    bad.set(new TextEncoder().encode("{no"), 5);
    expect(() => decodeFrame(bad)).toThrow(/malformed open-http/);
  });

  it("names no stream when the frame header itself is unusable", () => {
    expect(refusal(new Uint8Array([4, 0, 0])).streamId).toBeNull();
    expect(refusal(new Uint8Array([99, 0, 0, 0, 1])).streamId).toBeNull();
  });
});

describe("control frame validation", () => {
  it("builds resp-head and close-stream from picked fields, so payload keys cannot rewrite type or stream", () => {
    expect(
      decodeFrame(
        rawFrame(
          "resp-head",
          3,
          JSON.stringify({
            type: "body-chunk",
            streamId: 9,
            data: [1, 2, 3],
            status: 200,
            headers: [],
          }),
        ),
      ),
    ).toEqual({ type: "resp-head", streamId: 3, status: 200, headers: [] });

    expect(
      decodeFrame(
        rawFrame(
          "close-stream",
          3,
          JSON.stringify({
            type: "ws-data",
            streamId: 9,
            isBinary: true,
            code: 1000,
            reason: "done",
          }),
        ),
      ),
    ).toEqual({
      type: "close-stream",
      streamId: 3,
      code: 1000,
      reason: "done",
    });
  });

  it.each([
    ["a status below 200", { status: 199, headers: [] }],
    ["a status above 599", { status: 600, headers: [] }],
    ["a fractional status", { status: 200.5, headers: [] }],
    ["a string status", { status: "200", headers: [] }],
    ["no status", { headers: [] }],
    ["null headers", { status: 200, headers: null }],
    ["numeric headers", { status: 200, headers: 42 }],
    ["object headers", { status: 200, headers: { a: "b" } }],
    ["a one-element pair", { status: 304, headers: [["only-one"]] }],
    ["a three-element pair", { status: 200, headers: [["a", "b", "c"]] }],
    ["a numeric name", { status: 200, headers: [[7, "x"]] }],
    ["a numeric value", { status: 200, headers: [["x", 7]] }],
    ["a name with a space", { status: 204, headers: [["bad name", "x"]] }],
    ["an empty name", { status: 200, headers: [["", "x"]] }],
    ["a CRLF value", { status: 304, headers: [["x-a", "a\r\nb"]] }],
    ["an LF value", { status: 200, headers: [["x-a", "a\nb"]] }],
    ["a NUL value", { status: 200, headers: [["x-a", "a\u0000b"]] }],
    ["a control character", { status: 200, headers: [["x-a", "a\u0001b"]] }],
    ["a DEL character", { status: 200, headers: [["x-a", "a\u007fb"]] }],
    ["a character above U+00FF", { status: 200, headers: [["x-a", "✓"]] }],
  ])("refuses a resp-head with %s and names its stream", (_case, meta) => {
    const error = refusal(rawFrame("resp-head", 11, JSON.stringify(meta)));

    expect(error.streamId).toBe(11);
    expect(error.message).toMatch(/resp-head/u);
  });

  it.each([
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a JSON string", '"resp"'],
    ["a JSON number", "5"],
  ])("refuses a control payload that is %s", (_case, payload) => {
    expect(refusal(rawFrame("resp-head", 2, payload)).streamId).toBe(2);
    expect(refusal(rawFrame("close-stream", 2, payload)).streamId).toBe(2);
  });

  it.each([
    ["a string code", { code: "1000", reason: "x" }],
    ["a fractional code", { code: 1000.5, reason: "x" }],
    ["a code below 1000", { code: 999, reason: "x" }],
    ["a code above 4999", { code: 5000, reason: "x" }],
    ["no code", { reason: "x" }],
    ["a numeric reason", { code: 1000, reason: 7 }],
    ["a null reason", { code: 1000, reason: null }],
    ["no reason", { code: 1000 }],
  ])("refuses a close-stream with %s", (_case, meta) => {
    expect(
      refusal(rawFrame("close-stream", 5, JSON.stringify(meta))).streamId,
    ).toBe(5);
  });

  it("accepts a ws-open-ack protocol only when it is null or a subprotocol token", () => {
    for (const protocol of [5, "", "a b", "omnyo.v1\r\nset-cookie: a=b"]) {
      expect(
        refusal(rawFrame("ws-open-ack", 6, JSON.stringify({ protocol })))
          .streamId,
      ).toBe(6);
    }

    expect(refusal(rawFrame("ws-open-ack", 6, "{}")).streamId).toBe(6);
    expect(
      decodeFrame(
        rawFrame("ws-open-ack", 6, JSON.stringify({ protocol: null })),
      ),
    ).toEqual({ type: "ws-open-ack", streamId: 6, protocol: null });
  });

  it("checks the open-http and open-ws frames a tunnel client decodes", () => {
    const http = {
      method: "GET",
      path: "/",
      headers: [["accept", "text/html"]],
      hasBody: false,
    };

    for (const meta of [
      { ...http, method: 7 },
      { ...http, method: "GE T" },
      { ...http, path: 7 },
      { ...http, path: "@evil.test/" },
      { ...http, headers: [["accept"]] },
      { ...http, headers: [["accept", "a\r\nb"]] },
      { ...http, hasBody: "yes" },
      { ...http, target: 8000 },
      { ...http, target: null },
    ]) {
      expect(
        refusal(rawFrame("open-http", 8, JSON.stringify(meta))).streamId,
      ).toBe(8);
    }

    const ws = { path: "/ws", headers: [], protocols: ["omnyo.v1"] };

    for (const meta of [
      { ...ws, protocols: "omnyo.v1" },
      { ...ws, protocols: [7] },
      { ...ws, headers: null },
      { ...ws, path: "ws" },
      { ...ws, target: 5173 },
    ]) {
      expect(
        refusal(rawFrame("open-ws", 9, JSON.stringify(meta))).streamId,
      ).toBe(9);
    }

    expect(
      decodeFrame(
        rawFrame("open-ws", 9, JSON.stringify({ ...ws, protocols: ["a b"] })),
      ),
    ).toMatchObject({ type: "open-ws", protocols: ["a b"] });
  });

  it("refuses a control frame above the size limit before parsing its JSON", () => {
    const parse = vi.spyOn(JSON, "parse");

    try {
      const padding = "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES);

      const oversized = rawFrame(
        "resp-head",
        4,
        JSON.stringify({ status: 200, headers: [["x-pad", padding]] }),
      );

      const error = refusal(oversized);
      expect(error.streamId).toBe(4);
      expect(error.message).toMatch(/exceeds/u);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("accepts a control frame exactly at the size limit and leaves data frames unlimited", () => {
    const empty = JSON.stringify({ status: 200, headers: [["x-pad", ""]] });

    const atLimit = JSON.stringify({
      status: 200,
      headers: [
        ["x-pad", "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES - empty.length)],
      ],
    });

    expect(Buffer.byteLength(atLimit)).toBe(MAX_CONTROL_FRAME_PAYLOAD_BYTES);
    expect(decodeFrame(rawFrame("resp-head", 1, atLimit)).type).toBe(
      "resp-head",
    );

    const data = new Uint8Array(4 * MAX_CHUNK_BYTES);

    const decoded = roundTrip({
      type: "ws-data",
      streamId: 1,
      isBinary: true,
      data,
    });

    if (decoded.type !== "ws-data") throw new Error("unreachable");
    expect(decoded.data.byteLength).toBe(data.byteLength);
  });
});

describe("chunkBody", () => {
  it("splits at MAX_CHUNK_BYTES and reassembles losslessly", () => {
    const data = new Uint8Array(MAX_CHUNK_BYTES * 2 + 123);

    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 256;
    const chunks = [...chunkBody(5, data)];
    expect(chunks.length).toBe(3);
    expect(chunks[0].data.length).toBe(MAX_CHUNK_BYTES);
    expect(chunks[2].data.length).toBe(123);
    const total = new Uint8Array(data.length);
    let offset = 0;

    for (const chunk of chunks) {
      total.set(chunk.data, offset);
      offset += chunk.data.length;
    }

    expect(Buffer.compare(Buffer.from(total), Buffer.from(data))).toBe(0);
  });

  it("yields nothing for an empty body", () => {
    expect([...chunkBody(5, new Uint8Array(0))]).toEqual([]);
  });
});

describe("frame header access", () => {
  it("reads the type and stream id without decoding the payload", () => {
    const head = encodeFrame({
      type: "resp-head",
      streamId: 4_000_000_000,
      status: 200,
      headers: [["content-type", "text/plain"]],
    });

    expect(peekFrame(head)).toEqual({
      type: "resp-head",
      streamId: 4_000_000_000,
    });
    const malformedPayload = new Uint8Array(5 + 3);
    malformedPayload[0] = 4;
    malformedPayload.set(new TextEncoder().encode("{no"), 5);
    expect(peekFrame(malformedPayload).type).toBe("resp-head");
  });

  it("re-addresses a frame in place, including through an ArrayBuffer and a subarray view", () => {
    const chunk = encodeFrame({
      type: "body-chunk",
      streamId: 0,
      data: new Uint8Array([1, 2, 3]),
    });

    const buffer = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;

    expect(decodeFrame(setFrameStreamId(buffer, 42))).toEqual({
      type: "body-chunk",
      streamId: 42,
      data: new Uint8Array([1, 2, 3]),
    });

    const padded = new Uint8Array(chunk.length + 4);
    padded.set(chunk, 4);
    const view = padded.subarray(4);
    setFrameStreamId(view, 7);
    expect(peekFrame(view).streamId).toBe(7);
    expect([...padded.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("rejects short frames, unknown types, and out-of-range stream ids", () => {
    expect(() => peekFrame(new Uint8Array(4))).toThrow(/too short/u);
    expect(() => peekFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow(
      /unknown frame type/u,
    );
    const frame = encodeFrame({ type: "body-end", streamId: 1 });
    expect(() => setFrameStreamId(frame, -1)).toThrow(/out of range/u);
    expect(() => setFrameStreamId(new Uint8Array(2), 1)).toThrow(/too short/u);
  });
});

describe("control frame encoding limit", () => {
  const oversized = "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES);

  const frames: [string, Frame][] = [
    [
      "open-http",
      {
        type: "open-http",
        streamId: 1,
        method: "GET",
        path: "/",
        headers: [["x-pad", oversized]],
        hasBody: false,
      },
    ],
    [
      "open-ws",
      {
        type: "open-ws",
        streamId: 2,
        path: "/",
        headers: [["x-pad", oversized]],
        protocols: [],
      },
    ],
    [
      "resp-head",
      {
        type: "resp-head",
        streamId: 3,
        status: 200,
        headers: [["x-pad", oversized]],
      },
    ],
    [
      "close-stream",
      { type: "close-stream", streamId: 4, code: 1000, reason: oversized },
    ],
  ];

  it.each(frames)(
    "refuses to encode a %s frame above the control frame limit",
    (type, frame) => {
      let caught: unknown;

      try {
        encodeFrame(frame);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ControlFrameTooLargeError);
      expect(caught).toMatchObject({ frameType: type });
      expect(
        (caught as ControlFrameTooLargeError).payloadBytes,
      ).toBeGreaterThan(MAX_CONTROL_FRAME_PAYLOAD_BYTES);
    },
  );

  it("encodes a control frame exactly at the limit and decodes it back", () => {
    const empty = JSON.stringify({
      method: "GET",
      path: "/",
      headers: [["x-pad", ""]],
      hasBody: false,
    });

    const frame: Frame = {
      type: "open-http",
      streamId: 5,
      method: "GET",
      path: "/",
      headers: [
        ["x-pad", "a".repeat(MAX_CONTROL_FRAME_PAYLOAD_BYTES - empty.length)],
      ],
      hasBody: false,
    };

    const encoded = encodeFrame(frame);
    expect(encoded.length - 5).toBe(MAX_CONTROL_FRAME_PAYLOAD_BYTES);
    expect(decodeFrame(encoded)).toEqual(frame);
  });
});
