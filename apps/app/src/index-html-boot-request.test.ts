// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readInlinePageBoot } from "./lib/app-boot";

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function bootScript(): string {
  const match = /<head>\s*<script>([\s\S]*?)<\/script>/u.exec(indexHtml);

  if (match?.[1] === undefined)
    throw new Error("index.html does not start with an inline script");

  return match[1];
}

function bootResponse() {
  return {
    version: 1,
    serverIdentity: "a".repeat(64),
    parts: { systemVersion: { status: 200, body: { currentVersion: "1" } } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__omnyoBootV1");
  Reflect.deleteProperty(window, "omnyo");
});

describe("index.html startup read", () => {
  it("starts the combined startup read before the app script and records its answer", async () => {
    const fetchSpy = vi.fn(async () => Response.json(bootResponse()));
    vi.stubGlobal("fetch", fetchSpy);

    new Function(bootScript())();

    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/boot", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-omnyo-app-surface": "web" },
    });

    const page = readInlinePageBoot(Reflect.get(window, "__omnyoBootV1"));
    expect(page?.settled).toBe(false);
    expect(await page?.outcome).toMatchObject({
      kind: "ok",
      response: bootResponse(),
    });
    expect(Reflect.get(Reflect.get(window, "__omnyoBootV1"), "settled")).toBe(
      true,
    );
  });

  it("names the phone app surface inside the native shell", () => {
    const fetchSpy = vi.fn(async (_input: string, _init: RequestInit) =>
      Response.json(bootResponse()),
    );

    vi.stubGlobal("fetch", fetchSpy);
    Reflect.set(window, "omnyo", { native: {} });

    new Function(bootScript())();

    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-omnyo-app-surface": "mobile" },
    });
  });

  it("records a failed startup read as failed so each item loads separately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );

    new Function(bootScript())();

    const page = readInlinePageBoot(Reflect.get(window, "__omnyoBootV1"));
    expect(await page?.outcome).toEqual({ kind: "failed" });
  });
});
