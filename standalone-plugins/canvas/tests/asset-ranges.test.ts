import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "../server";
import { z } from "zod";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function fixture(size = 20 * 1024 * 1024) {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  plugin(host.api);

  const content = Buffer.alloc(size, 0x7d);
  content.write("ftypisom", 4, "ascii");
  content.write("selected bytes", 4096, "ascii");
  content.write("last sixteen!!!!", content.length - 16, "ascii");

  const id = createHash("sha256").update(content).digest("hex");
  const database = host.api.storage.database();

  database
    .prepare("INSERT INTO assets(id, mime, content) VALUES (?, ?, ?)")
    .run(id, "video/mp4", content);

  const materialized: number[] = [];
  const prepare = database.prepare.bind(database);

  vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const get = statement.get.bind(statement);

    vi.spyOn(statement, "get").mockImplementation((...parameters) => {
      const row = get(...parameters);

      const fields = z.record(z.string(), z.unknown()).optional().parse(row);

      if (fields !== undefined)
        for (const value of Object.values(fields))
          if (Buffer.isBuffer(value)) materialized.push(value.length);

      return row;
    });

    return statement;
  });

  return { host, database, content, id, materialized };
}

describe("asset byte ranges", () => {
  it("materializes only requested bytes and none for unsatisfiable ranges", async () => {
    const { host, content, id, materialized } = fixture();
    const last = content.length - 1;

    const requests = [
      { header: "bytes=4096-69631", start: 4096, end: 69631 },
      { header: "bytes=-16", start: content.length - 16, end: last },
      { header: `bytes=${last - 3}-999999999`, start: last - 3, end: last },
      { header: `bytes=${last - 7}-`, start: last - 7, end: last },
    ];

    for (const request of requests) {
      materialized.length = 0;

      const response = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}`, {
        headers: { Range: request.header },
      });

      const expected = content.subarray(request.start, request.end + 1);

      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(
        `bytes ${request.start}-${request.end}/${content.length}`,
      );
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
      expect(materialized.reduce((total, bytes) => total + bytes, 0)).toBe(expected.length);
    }

    for (const header of [`bytes=${content.length}-`, "bytes=10-4", "bytes=-0"]) {
      materialized.length = 0;

      const response = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}`, {
        headers: { Range: header },
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${content.length}`);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(materialized).toEqual([]);
    }
  });

  it("preserves whole responses for missing or unsupported range syntax", async () => {
    const { host, content, id } = fixture(8192);

    for (const header of [undefined, "bytes=0-2,5-8", "garbage"]) {
      const response = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}`, {
        headers: header === undefined ? {} : { Range: header },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    }
  });

  it("uses the same bounded read for prepared image variants and keeps missing assets distinct", async () => {
    const { host, database, id, materialized } = fixture(8192);
    const variant = Buffer.alloc(2 * 1024 * 1024, 0x39);

    database
      .prepare("INSERT INTO canvas_media_variants(asset_id, width, content) VALUES (?, ?, ?)")
      .run(id, 640, variant);
    materialized.length = 0;

    const response = await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}&width=640`, {
      headers: { Range: "bytes=4-11" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(variant.subarray(4, 12));
    expect(materialized.reduce((total, bytes) => total + bytes, 0)).toBe(8);
    expect((await host.harness.behavior.fetchHttp("GET", `/asset?id=${id}&width=999`)).status).toBe(
      404,
    );
    expect(
      (await host.harness.behavior.fetchHttp("GET", `/asset?id=${"f".repeat(64)}`)).status,
    ).toBe(404);
    expect((await host.harness.behavior.fetchHttp("GET", "/asset?id=../x")).status).toBe(400);
  });
});
