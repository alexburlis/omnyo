// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./hooks/useTheme";
import {
  APP_THEME_CSS_STORAGE_KEY,
  applyAppThemeCss,
  applyCachedAppThemeCss,
} from "./lib/themes";

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../index.html"),
  "utf8",
);

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const scriptRe = /<script(?![^>]*\btype="module")[^>]*>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(scriptRe)) {
    scripts.push(match[1].replaceAll("%MODE%", "test"));
  }

  return scripts;
}

function installDocument(html: string): void {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");

  const inner = withoutScripts
    .replace(/^[\s\S]*?<html[^>]*>/, "")
    .replace(/<\/html>[\s\S]*$/, "");

  document.documentElement.innerHTML = inner;
  document.documentElement.className = "omnyo-app-shell-root";
}

async function runInlineScripts(): Promise<void> {
  for (const script of extractInlineScripts(indexHtml)) {
    new Function(script)();
  }

  await Promise.resolve();
  await Promise.resolve();
}

function stubPrefersDark(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(prefers-color-scheme: dark)" ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("index.html pre-paint script", async () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          work: (lock: object) => unknown,
        ) => work({}),
      },
    });
    installDocument(indexHtml);
    stubPrefersDark(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "__omnyoOriginSessionRestoreV1");
    Reflect.deleteProperty(window, "__omnyoBeginBrowserStorageAdmissionV1");
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = "";
    delete document.documentElement.dataset.omnyoStorageMigrationError;
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("extracts the startup read, browser floor, admission and both palette scripts from index.html", async () => {
    expect(extractInlineScripts(indexHtml)).toHaveLength(5);
  });

  it("adopts legacy theme, color and palette before their first canonical reads", async () => {
    const css = ":root { --canvas: oklch(0.3 0.02 250); }";
    localStorage.setItem("bb.theme", "dark");
    localStorage.setItem("bb.faviconColor", "purple");
    localStorage.setItem("bb.appThemeCss", css);
    await runInlineScripts();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("omnyo.theme")).toBe("dark");
    expect(localStorage.getItem("omnyo.faviconColor")).toBe("purple");
    expect(localStorage.getItem("omnyo.appThemeCss")).toBe(css);
    expect(localStorage.getItem("bb.theme")).toBeNull();
    expect(document.getElementById("app-manifest")?.getAttribute("href")).toBe(
      "/manifest-purple.webmanifest",
    );
    expect(document.getElementById("omnyo-app-theme")?.textContent).toBe(css);
  });

  it("blocks conflicting preferences without replacing either saved copy", async () => {
    localStorage.setItem("bb.theme", "dark");
    localStorage.setItem("omnyo.theme", "light");
    await runInlineScripts();
    expect(document.documentElement.dataset.omnyoStorageMigrationError).toBe(
      "preferences",
    );
    expect(localStorage.getItem("bb.theme")).toBe("dark");
    expect(localStorage.getItem("omnyo.theme")).toBe("light");
  });

  it("retains source preferences when destination writes fail", async () => {
    localStorage.setItem("bb.theme", "dark");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await runInlineScripts();
    expect(document.documentElement.dataset.omnyoStorageMigrationError).toBe(
      "preferences",
    );
    expect(localStorage.getItem("bb.theme")).toBe("dark");
    expect(localStorage.getItem("omnyo.theme")).toBeNull();
  });

  it("adds the dark class before paint when the stored preference is dark", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    await runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe("#0f1116");
  });

  it("follows the system scheme when no preference is stored", async () => {
    stubPrefersDark(true);

    await runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps the light palette when the stored preference is light on a dark system", async () => {
    stubPrefersDark(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    await runInlineScripts();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe("#ffffff");
  });

  it("injects the palette CSS cached by applyAppThemeCss as the last head style", async () => {
    const css = ":root { --canvas: oklch(0.3 0.02 250); }";
    applyAppThemeCss(css);
    document.getElementById("omnyo-app-theme")?.remove();
    expect(localStorage.getItem(APP_THEME_CSS_STORAGE_KEY)).toBe(css);

    await runInlineScripts();

    const style = document.getElementById("omnyo-app-theme");
    expect(style).toBeInstanceOf(HTMLStyleElement);
    expect(style?.textContent).toBe(css);
    expect(document.head.lastElementChild).toBe(style);
  });

  it("does not inject a palette element when no palette is cached", async () => {
    await runInlineScripts();

    expect(document.getElementById("omnyo-app-theme")).toBeNull();
  });

  it("lets applyCachedAppThemeCss adopt the pre-paint element and keep it last", async () => {
    const css = ".dark { --canvas: oklch(0.2 0.02 250); }";
    localStorage.setItem(APP_THEME_CSS_STORAGE_KEY, css);
    await runInlineScripts();
    const devStyle = document.createElement("style");
    devStyle.setAttribute("data-vite-dev-id", "app.css");
    document.head.appendChild(devStyle);

    applyCachedAppThemeCss();

    const styles = document.querySelectorAll("#omnyo-app-theme");
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(css);
    expect(document.head.lastElementChild).toBe(styles[0]);
  });
});
