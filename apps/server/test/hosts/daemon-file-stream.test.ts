import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_FILE_CHUNK_MAX_BYTES,
  type HostDaemonOnlineRpcResult,
} from "@omnyo/host-daemon-contract";
import { createDaemonFileStreamResponse } from "../../src/services/hosts/daemon-file-stream.js";

const metadata: HostDaemonOnlineRpcResult<"host.read_file_chunk"> = {
  path: "/tmp/clip.mp4",
  content: new Uint8Array(),
  offset: 0,
  mimeType: "video/mp4",
  sizeBytes: 6,
  modifiedAtMs: 1234,
  revision: "a".repeat(64),
};

const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);

const entityTag = `W/"file-${metadata.revision}"`;

function reader() {
  return vi.fn(
    async (offset: number, length: number, revision: string | null) => {
      expect(revision).toBe(metadata.revision);

      return {
        ...metadata,
        offset,
        content: bytes.subarray(offset, offset + length),
      };
    },
  );
}

function request(headers: HeadersInit = {}, method = "GET") {
  return new Request("http://omnyo.test/clip.mp4", { headers, method });
}

describe("daemon file streaming", () => {
  it.each([
    ["bytes=0-1", 0, 1],
    ["bytes=2-", 2, 5],
    ["bytes=-2", 4, 5],
    ["bytes=-999999999999999999999999999", 0, 5],
    ["bytes=1-999999999999999999999999999", 1, 5],
    ["BYTES=0-0", 0, 0],
  ])("reads only the selected bytes for %s", async (range, start, end) => {
    const read = reader();

    const response = await createDaemonFileStreamResponse(
      metadata,
      read,
      request({ range }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes ${start}-${end}/6`,
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(
      String(end - start + 1),
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      bytes.subarray(start, end + 1),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(
      start,
      end - start + 1,
      metadata.revision,
      expect.any(AbortSignal),
    );
  });

  it.each(["bytes=6-", "bytes=-0", "bytes=999999999999999999999999999-"])(
    "rejects %s without reading content",
    async (range) => {
      const read = reader();

      const response = await createDaemonFileStreamResponse(
        metadata,
        read,
        request({ range }),
      );

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */6");
      expect(await response.text()).toBe("");
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    "bytes=0-1,4-5",
    "items=0-1",
    "bytes=wat",
    "bytes=-",
    "bytes=3-1",
    "bytes=1.5-2",
  ])("streams the full response for %s", async (range) => {
    const response = await createDaemonFileStreamResponse(
      metadata,
      reader(),
      request({ range }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    entityTag,
    '"stale"',
    '"' + metadata.revision + '"',
    "Fri, 02 Jan 2026 03:04:05 GMT",
    "",
  ])(
    "does not use weak metadata validators for If-Range: %s",
    async (ifRange) => {
      const response = await createDaemonFileStreamResponse(
        metadata,
        reader(),
        request({ range: "bytes=0-1", "if-range": ifRange }),
      );

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  it.each([entityTag, "*", '"other", ' + entityTag])(
    "revalidates %s before evaluating Range without reading content",
    async (tag) => {
      const read = reader();

      const response = await createDaemonFileStreamResponse(
        metadata,
        read,
        request({ "if-none-match": tag, range: "bytes=999-" }),
      );

      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(entityTag);
      expect(response.headers.has("content-range")).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("answers HEAD without reading bytes or applying Range", async () => {
    const read = reader();

    const response = await createDaemonFileStreamResponse(
      metadata,
      read,
      request({ range: "bytes=0-1" }, "HEAD"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("6");
    expect(await response.text()).toBe("");
    expect(read).not.toHaveBeenCalled();
  });

  it("handles empty files and unsatisfiable empty ranges without reading bytes", async () => {
    const read = reader();
    const empty = { ...metadata, sizeBytes: 0 };
    expect(
      (await createDaemonFileStreamResponse(empty, read, request())).status,
    ).toBe(200);

    const response = await createDaemonFileStreamResponse(
      empty,
      read,
      request({ range: "bytes=0-" }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */0");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps large downloads bounded, orders concurrent results, and cancels pending reads", async () => {
    const large = { ...metadata, sizeBytes: 40 * 1024 * 1024 };

    const read = vi.fn(
      (
        offset: number,
        length: number,
        _revision: string | null,
        signal: AbortSignal,
      ) => {
        if (offset === 0)
          return new Promise<typeof large>((resolve) => {
            queueMicrotask(() =>
              resolve({ ...large, offset, content: Buffer.alloc(length, 1) }),
            );
          });

        if (offset === HOST_FILE_CHUNK_MAX_BYTES)
          return Promise.resolve({
            ...large,
            offset,
            content: Buffer.alloc(length, 2),
          });

        return new Promise<typeof large>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );

    const response = await createDaemonFileStreamResponse(
      large,
      read,
      request(),
    );

    expect(response.headers.get("content-length")).toBe(
      String(large.sizeBytes),
    );
    expect(read).toHaveBeenCalledTimes(16);

    const stream = response.body!.getReader();
    expect((await stream.read()).value?.[0]).toBe(1);
    expect((await stream.read()).value?.[0]).toBe(2);
    expect(read).toHaveBeenCalledTimes(17);
    await stream.cancel();
    expect(read.mock.calls.every((args) => args[3].aborted)).toBe(true);
  });

  it("finishes with a short final chunk", async () => {
    const large = { ...metadata, sizeBytes: HOST_FILE_CHUNK_MAX_BYTES + 3 };

    const read = vi.fn(async (offset: number, length: number) => ({
      ...large,
      offset,
      content: Buffer.alloc(length, 1),
    }));

    const response = await createDaemonFileStreamResponse(
      large,
      read,
      request(),
    );

    expect((await response.arrayBuffer()).byteLength).toBe(large.sizeBytes);
    expect(read).toHaveBeenLastCalledWith(
      HOST_FILE_CHUNK_MAX_BYTES,
      3,
      metadata.revision,
      expect.any(AbortSignal),
    );
  });

  it.each(["revision", "offset", "size", "short"])(
    "rejects a mismatched %s chunk",
    async (kind) => {
      const read = reader();
      const wrong = { ...metadata, content: bytes };

      if (kind === "revision") wrong.revision = "b".repeat(64);

      if (kind === "offset") wrong.offset = 1;

      if (kind === "size") wrong.sizeBytes = 7;

      if (kind === "short") wrong.content = bytes.subarray(0, 1);
      read.mockResolvedValueOnce(wrong);
      await expect(
        createDaemonFileStreamResponse(metadata, read, request()),
      ).rejects.toThrow("File changed");
    },
  );

  it("terminates a started stream when a later prefetched chunk fails", async () => {
    const large = { ...metadata, sizeBytes: HOST_FILE_CHUNK_MAX_BYTES + 1 };
    let failChunk: (error: Error) => void = () => {};

    const read = vi.fn((offset: number, length: number) =>
      offset === 0
        ? Promise.resolve({ ...large, offset, content: Buffer.alloc(length) })
        : new Promise<typeof large>((_resolve, reject) => {
            failChunk = reject;
          }),
    );

    const response = await createDaemonFileStreamResponse(
      large,
      read,
      request(),
    );

    failChunk(new Error("file_changed"));
    await expect(response.arrayBuffer()).rejects.toThrow("file_changed");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops requesting chunks when the HTTP request is aborted", async () => {
    const large = { ...metadata, sizeBytes: 40 * 1024 * 1024 };

    const read = vi.fn(async (offset: number, length: number) => ({
      ...large,
      offset,
      content: Buffer.alloc(length),
    }));

    const abort = new AbortController();

    const response = await createDaemonFileStreamResponse(
      large,
      read,
      new Request("http://omnyo.test", { signal: abort.signal }),
    );

    const stream = response.body!.getReader();
    await stream.read();
    abort.abort();
    await expect(stream.read()).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(16);
  });
});
