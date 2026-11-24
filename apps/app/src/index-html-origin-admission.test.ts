import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LocalWindow = Window & typeof globalThis;

function createLocalWindow(html: string): LocalWindow {
  const require = createRequire(import.meta.url);
  const peerRequire = createRequire(require.resolve("vitest/package.json"));
  const peer: unknown = peerRequire("jsdom");

  if (typeof peer !== "object" || peer === null)
    throw new Error("The existing Vitest DOM peer is unavailable");
  const constructor: unknown = Reflect.get(peer, "JSDOM");

  if (typeof constructor !== "function")
    throw new Error("The existing Vitest DOM constructor is unavailable");

  const instance: unknown = Reflect.construct(constructor, [
    html,
    {
      url: "http://localhost:5173/",
      runScripts: "outside-only",
    },
  ]);

  if (typeof instance !== "object" || instance === null)
    throw new Error("The local browser context was not created");
  const window: unknown = Reflect.get(instance, "window");

  if (
    typeof window !== "object" ||
    window === null ||
    typeof Reflect.get(window, "eval") !== "function" ||
    typeof Reflect.get(window, "close") !== "function" ||
    typeof Reflect.get(window, "document") !== "object"
  )
    throw new Error(
      "The local browser context does not expose the real DOM API",
    );

  return window as LocalWindow;
}

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const scriptRe = /<script(?![^>]*\btype="module")[^>]*>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(scriptRe))
    scripts.push(match[1].replaceAll("%MODE%", "test"));

  return scripts;
}

async function runInlineScripts(window: LocalWindow): Promise<void> {
  for (const script of extractInlineScripts(indexHtml)) window.eval(script);
  await Promise.resolve();
  await Promise.resolve();
}

function installLocks(
  window: LocalWindow,
  request: (name: unknown, options: unknown, work: unknown) => unknown,
): void {
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    value: { request },
  });
}

describe("index.html origin admission", () => {
  let window: LocalWindow;

  beforeEach(() => {
    window = createLocalWindow(indexHtml);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      }),
    });
    installLocks(window, async (_name, _options, work) => {
      if (typeof work !== "function")
        throw new Error("Storage lock callback is unavailable");

      return Reflect.apply(work, undefined, [{}]);
    });
  });

  afterEach(() => {
    window?.close();
  });

  it("keeps prepaint writers closed while a native target session must be restored", async () => {
    const request = vi.fn(
      async (_name: unknown, _options: unknown, work: unknown) => {
        if (typeof work !== "function")
          throw new Error("Storage lock callback is unavailable");

        return Reflect.apply(work, undefined, [{}]);
      },
    );

    installLocks(window, request);
    Reflect.set(window, "__omnyoOriginSessionRestoreV1", { required: true });
    window.localStorage.setItem("bb.theme", "dark");
    await runInlineScripts(window);
    expect(request).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("bb.theme")).toBe("dark");
    expect(window.localStorage.getItem("omnyo.theme")).toBeNull();
    expect(window.document.documentElement.classList.contains("dark")).toBe(
      false,
    );
    const begin = Reflect.get(window, "__omnyoBeginBrowserStorageAdmissionV1");

    if (typeof begin !== "function")
      throw new Error("The native restore continuation is unavailable");
    window.sessionStorage.setItem(
      "omnyo.composer-submission-tab.v1",
      "original-tab",
    );
    Reflect.apply(begin, window, []);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("omnyo.theme")).toBe("dark");
    expect(
      window.sessionStorage.getItem("omnyo.composer-submission-tab.v1"),
    ).toBe("original-tab");
  });

  it("refuses an unknown controller key before preference writes", async () => {
    window.localStorage.setItem("bb.theme", "dark");
    const selection = { adoptionId: "selected", selectedIds: ["a".repeat(64)] };
    window.localStorage.setItem(
      "omnyo.origin-transfer.v1:adoption",
      JSON.stringify({ version: 1, phase: "accepted", ...selection }),
    );
    window.sessionStorage.setItem(
      "omnyo.origin-transfer.v1:unknown",
      JSON.stringify({
        version: 1,
        phase: "accepted",
        adoptionAccepted: true,
        ticket: selection,
      }),
    );
    await runInlineScripts(window);
    expect(window.localStorage.getItem("bb.theme")).toBe("dark");
    expect(window.localStorage.getItem("omnyo.theme")).toBeNull();
    expect(
      window.document.documentElement.dataset.omnyoStorageMigrationError,
    ).toBeDefined();
  });
});
