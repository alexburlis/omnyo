// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function browserFloorScript(): string {
  for (const match of indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/gu)) {
    const source = match[1];

    if (source?.includes('supports("importmap")')) return source;
  }

  throw new Error("index.html has no browser floor script");
}

function runWithImportMapSupport(supported: boolean | null) {
  vi.spyOn(document, "addEventListener");

  if (supported === null) {
    Reflect.deleteProperty(HTMLScriptElement, "supports");
  } else {
    Reflect.set(HTMLScriptElement, "supports", (type: string) =>
      type === "importmap" ? supported : false,
    );
  }

  new Function(browserFloorScript())();
  document.dispatchEvent(new Event("DOMContentLoaded"));
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLScriptElement, "supports");
  document.body.innerHTML = "";
});

describe("index.html browser floor", () => {
  it("leaves the app alone where import maps work", () => {
    document.body.innerHTML = '<div id="root"></div>';

    runWithImportMapSupport(true);

    expect(document.getElementById("root")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([false, null])(
    "asks for Safari 16.4 instead of a blank page when import map support is %s",
    (supported) => {
      document.body.innerHTML = '<div id="root"></div>';

      runWithImportMapSupport(supported);

      expect(document.getElementById("root")).toBeNull();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Safari 16.4 or later",
      );
    },
  );
});
