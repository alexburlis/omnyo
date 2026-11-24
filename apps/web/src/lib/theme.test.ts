import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_COLORS,
  THEME_INIT,
  THEME_STORAGE_KEY,
  currentTheme,
  setTheme,
  subscribeTheme,
  watchTheme,
} from "./theme";

const landingCss = readFileSync(
  new URL("../landing/landing.css", import.meta.url),
  "utf8",
);

interface Meta {
  media: string;
  content: string;
  setAttribute: (name: string, value: string) => void;
}

function fakeBrowser({
  osDark,
  stored = null,
  storageThrows = false,
}: {
  osDark: boolean;
  stored?: string | null;
  storageThrows?: boolean;
}) {
  const classes = new Set<string>();
  const values = new Map<string, string>();
  const schemeListeners = new Set<() => void>();
  const windowListeners = new Set<(event: { key: string | null }) => void>();

  if (stored !== null) values.set(THEME_STORAGE_KEY, stored);

  const metas: Meta[] = ["light", "dark"].map((scheme) => {
    const meta: Meta = {
      media: `(prefers-color-scheme: ${scheme})`,
      content: scheme === "dark" ? THEME_COLORS.dark : THEME_COLORS.light,
      setAttribute: (_name, value) => {
        meta.content = value;
      },
    };

    return meta;
  });

  const media = {
    get matches() {
      return osDark;
    },
    addEventListener: (_type: string, listener: () => void) =>
      schemeListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      schemeListeners.delete(listener),
  };

  const guard = () => {
    if (storageThrows) throw new Error("SecurityError");
  };

  const browser = {
    classes,
    values,
    metas,
    document: {
      documentElement: {
        classList: {
          add: (name: string) => classes.add(name),
          contains: (name: string) => classes.has(name),
          toggle: (name: string, force: boolean) => {
            if (force) classes.add(name);
            else classes.delete(name);

            return force;
          },
        },
      },
      querySelectorAll: () => metas,
    },
    matchMedia: (query: string) =>
      query === "(prefers-color-scheme: dark)"
        ? media
        : { ...media, matches: false },
    localStorage: {
      getItem: (key: string) => {
        guard();

        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        guard();
        values.set(key, value);
      },
      removeItem: (key: string) => {
        guard();
        values.delete(key);
      },
    },
    window: {
      addEventListener: (
        _type: string,
        listener: (event: { key: string | null }) => void,
      ) => windowListeners.add(listener),
      removeEventListener: (
        _type: string,
        listener: (event: { key: string | null }) => void,
      ) => windowListeners.delete(listener),
    },
    setOsDark: (dark: boolean) => {
      osDark = dark;

      for (const listener of schemeListeners) listener();
    },
    storageEvent: (key: string | null) => {
      for (const listener of windowListeners) listener({ key });
    },
  };

  return browser;
}

function install(browser: ReturnType<typeof fakeBrowser>) {
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("matchMedia", browser.matchMedia);
  vi.stubGlobal("localStorage", browser.localStorage);
  vi.stubGlobal("window", browser.window);

  return browser;
}

function runThemeInit(browser: ReturnType<typeof fakeBrowser>) {
  new Function("document", "matchMedia", "localStorage", THEME_INIT)(
    browser.document,
    browser.matchMedia,
    browser.localStorage,
  );

  return browser;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("THEME_INIT", () => {
  it("follows the system when no theme was chosen", () => {
    expect(runThemeInit(fakeBrowser({ osDark: true })).classes).toEqual(
      new Set(["dark"]),
    );
    expect(runThemeInit(fakeBrowser({ osDark: false })).classes).toEqual(
      new Set(),
    );
    expect(landingCss).toMatch(/\n\.dark \{\n  color-scheme: dark;\n  --bg: /u);
  });

  it("applies a chosen theme over the system and tints the browser to match", () => {
    const dark = runThemeInit(fakeBrowser({ osDark: false, stored: "dark" }));

    expect(dark.classes).toEqual(new Set(["dark"]));
    expect(dark.metas.map((meta) => meta.content)).toEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);

    const light = runThemeInit(fakeBrowser({ osDark: true, stored: "light" }));

    expect(light.classes).toEqual(new Set());
    expect(light.metas.map((meta) => meta.content)).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.light,
    ]);
  });

  it("falls back to the system when storage is blocked or holds another value", () => {
    expect(
      runThemeInit(fakeBrowser({ osDark: true, storageThrows: true })).classes,
    ).toEqual(new Set(["dark"]));
    expect(
      runThemeInit(fakeBrowser({ osDark: false, stored: "sepia" })).classes,
    ).toEqual(new Set());
  });
});

describe("setTheme", () => {
  it("stores only a choice that differs from the system", () => {
    const browser = install(fakeBrowser({ osDark: false }));
    const notified = vi.fn();
    const stop = subscribeTheme(notified);

    setTheme("dark");

    expect(currentTheme()).toBe("dark");
    expect(browser.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(browser.metas.map((meta) => meta.content)).toEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);

    setTheme("light");

    expect(currentTheme()).toBe("light");
    expect(browser.values.has(THEME_STORAGE_KEY)).toBe(false);
    expect(browser.metas.map((meta) => meta.content)).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
    expect(notified).toHaveBeenCalledTimes(2);

    setTheme("light");

    expect(notified).toHaveBeenCalledTimes(2);
    stop();
  });

  it("still switches the page when storage is blocked", () => {
    const browser = install(
      fakeBrowser({ osDark: false, storageThrows: true }),
    );

    setTheme("dark");

    expect(browser.classes).toEqual(new Set(["dark"]));
  });
});

describe("watchTheme", () => {
  it("follows system changes until a theme is chosen", () => {
    const browser = install(fakeBrowser({ osDark: false }));
    const stop = watchTheme();

    browser.setOsDark(true);
    expect(currentTheme()).toBe("dark");

    setTheme("light");
    browser.setOsDark(false);
    browser.setOsDark(true);
    expect(currentTheme()).toBe("light");

    stop();
    browser.values.delete(THEME_STORAGE_KEY);
    browser.setOsDark(false);
    browser.setOsDark(true);
    expect(currentTheme()).toBe("light");
  });

  it("picks up a choice made in another tab", () => {
    const browser = install(fakeBrowser({ osDark: false }));
    const stop = watchTheme();

    browser.values.set(THEME_STORAGE_KEY, "dark");
    browser.storageEvent("unrelated");
    expect(currentTheme()).toBe("light");

    browser.storageEvent(THEME_STORAGE_KEY);
    expect(currentTheme()).toBe("dark");

    browser.values.clear();
    browser.storageEvent(null);
    expect(currentTheme()).toBe("light");
    stop();
  });
});
