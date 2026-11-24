import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowOpenHandler,
  type DesktopWindowOpenDevToolsOptions,
  type DesktopWindowWebContents,
} from "../src/desktop-window-factory.js";
import type { DesktopContextMenuWebContents } from "../src/desktop-context-menu.js";
import { readPersistedWindowStateEntries } from "../src/window-state.js";
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type WindowBounds,
  type WindowStateKey,
} from "../src/types.js";

interface TempDir {
  path: string;
}

interface FakeDesktopWindowArgs {
  options: BrowserWindowConstructorOptions;
}

const tempDirs: TempDir[] = [];

async function createTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "omnyo-desktop-window-factory-"));
  const tempDir = { path };
  tempDirs.push(tempDir);

  return tempDir;
}

afterEach(async () => {
  vi.useRealTimers();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir !== undefined) {
      await rm(tempDir.path, { force: true, recursive: true });
    }
  }
});

class FakeDesktopWindowWebContents
  extends EventEmitter
  implements DesktopWindowWebContents
{
  public devToolsOpenCount = 0;
  public id: number;
  public readonly addedDictionaryWords: string[] = [];
  public readonly downloadedUrls: string[] = [];
  public readonly copiedImagePositions: Array<{ x: number; y: number }> = [];
  public destroyed = false;
  public currentUrl = "about:blank";
  public getURL(): string {
    return this.currentUrl;
  }
  public readonly spellCheckerEnabledValues: boolean[] = [];
  public readonly session: DesktopContextMenuWebContents["session"] = {
    addWordToSpellCheckerDictionary: (word) => {
      this.addedDictionaryWords.push(word);

      return true;
    },
    setSpellCheckerEnabled: (enabled) => {
      this.spellCheckerEnabledValues.push(enabled);
    },
  };
  public readonly replacedMisspellings: string[] = [];
  public windowOpenHandler: DesktopWindowOpenHandler | null = null;
  public readonly zoomFactors: number[] = [];
  constructor(id: number) {
    super();
    this.id = id;
  }

  openDevTools(options: DesktopWindowOpenDevToolsOptions): void {
    if (options.mode === "detach") {
      this.devToolsOpenCount += 1;
    }
  }

  replaceMisspelling(text: string): void {
    this.replacedMisspellings.push(text);
  }

  downloadURL(url: string): void {
    this.downloadedUrls.push(url);
  }

  copyImageAt(x: number, y: number): void {
    this.copiedImagePositions.push({ x, y });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setWindowOpenHandler(handler: DesktopWindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }

  setZoomFactor(factor: number): void {
    this.zoomFactors.push(factor);
  }
}

type NavigationOutcome =
  | { kind: "http"; status: number; finalUrl?: string }
  | { kind: "network"; code: number };

class FakeDesktopWindow implements DesktopBrowserWindow {
  public readonly id: number;
  public readonly loadedUrls: string[] = [];
  public readonly outcomes: NavigationOutcome[] = [];
  public draft = "";
  public readonly options: BrowserWindowConstructorOptions;
  private readonly contents: FakeDesktopWindowWebContents;
  public backgroundColor: string;
  public fullScreen = false;
  public maximized = false;
  public minimized = false;
  public shown = false;
  private destroyed = false;
  private emittingNavigation = false;
  private readonly bounds: WindowBounds;
  private readonly closedListeners: Array<() => void> = [];
  private readyToShowListener: (() => void) | null = null;

  constructor(args: FakeDesktopWindowArgs) {
    this.options = args.options;
    this.backgroundColor = args.options.backgroundColor ?? "#ffffff";
    this.id = FakeDesktopWindow.nextWindowId;
    FakeDesktopWindow.nextWindowId += 1;
    this.contents = new FakeDesktopWindowWebContents(
      FakeDesktopWindow.nextWebContentsId,
    );
    FakeDesktopWindow.nextWebContentsId += 1;
    this.bounds = {
      height: args.options.height ?? 0,
      width: args.options.width ?? 0,
      x: args.options.x ?? 0,
      y: args.options.y ?? 0,
    };
  }

  private static nextWindowId = 1;
  private static nextWebContentsId = 1;

  get webContents(): FakeDesktopWindowWebContents {
    if (this.destroyed) throw new TypeError("Object has been destroyed");

    return this.contents;
  }

  emitClosed(): void {
    this.destroyed = true;
    this.contents.destroyed = true;

    for (const listener of this.closedListeners) {
      listener();
    }
  }

  emitReadyToShow(): void {
    this.readyToShowListener?.();
  }

  focus(): void {}

  getBounds(): WindowBounds {
    return this.bounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFullScreen(): boolean {
    return this.fullScreen;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.webContents.emit(
      "did-start-navigation",
      new Event("navigation"),
      url,
      false,
      true,
    );
    const remote = /^https?:/u.test(url);
    const outcome = remote ? this.outcomes.shift() : undefined;

    if (remote) this.draft = "";

    if (outcome?.kind === "network") {
      this.webContents.emit(
        "did-fail-load",
        new Event("navigation"),
        outcome.code,
        "network failure",
        url,
        true,
      );
      throw Object.assign(new Error("network failure"), {
        errno: outcome.code,
      });
    }

    const finish = (): void => {
      this.emittingNavigation = true;
      this.webContents.emit(
        "did-navigate",
        new Event("navigation"),
        outcome?.finalUrl ?? url,
        outcome?.status ?? (remote ? 200 : -1),
        "",
      );
      this.emittingNavigation = false;
      this.webContents.emit("did-finish-load");
    };

    if (!remote && this.emittingNavigation) {
      queueMicrotask(() => {
        queueMicrotask(finish);
      });
    } else {
      finish();
    }
  }

  maximize(): void {
    this.maximized = true;
  }

  on(
    eventName: "close" | "closed" | "enter-full-screen" | "leave-full-screen",
    listener: () => void,
  ): void {
    if (eventName === "closed") {
      this.closedListeners.push(listener);
    }
  }

  once(eventName: "ready-to-show", listener: () => void): void {
    if (eventName === "ready-to-show") {
      this.readyToShowListener = listener;
    }
  }

  restore(): void {
    this.minimized = false;
  }

  setBackgroundColor(color: string): void {
    this.backgroundColor = color;
  }

  setFullScreen(isFullScreen: boolean): void {
    this.fullScreen = isFullScreen;
  }

  show(): void {
    this.shown = true;
  }
}

interface FactoryHarness {
  createdWindows: FakeDesktopWindow[];
  factory: ReturnType<typeof createDesktopWindowFactory>;
  userDataPath: string;
}

async function createFactoryHarness(
  overrides: Partial<Parameters<typeof createDesktopWindowFactory>[0]> = {},
): Promise<FactoryHarness> {
  const tempDir = await createTempDir();
  const createdWindows: FakeDesktopWindow[] = [];

  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      const browserWindow = new FakeDesktopWindow({ options });
      createdWindows.push(browserWindow);

      return browserWindow;
    },
  };

  const factory = createDesktopWindowFactory({
    browserWindowCreator,
    getServerTargetGeneration: () => 0,
    logWarning() {},
    createWindowStateKey() {
      return "window-fallback";
    },
    displayWorkAreas: [{ height: 900, width: 1440, x: 0, y: 0 }],
    icon: undefined,
    isMac: true,
    isLinuxTransparent: false,
    isLinuxFrameless: false,
    shouldUseDarkColors() {
      return true;
    },
    isQuitting() {
      return false;
    },
    openExternalUrl() {},
    preloadPath: "/tmp/preload.cjs",
    userDataPath: tempDir.path,
    ...overrides,
  });

  return { createdWindows, factory, userDataPath: tempDir.path };
}

describe("desktop window factory", () => {
  it.each([false, true])(
    "releases navigation ownership after a window is destroyed (quitting: %s)",
    async (quitting) => {
      const { createdWindows, factory, userDataPath } =
        await createFactoryHarness({
          isQuitting: () => quitting,
        });

      await factory.createWindow({ initialUrl: null, stateKey: null });
      const window = createdWindows[0];

      if (!window) throw new Error("Expected window");
      const contents = window.webContents;

      expect(() => window.emitClosed()).not.toThrow();
      expect(factory.hasOpenWindows()).toBe(false);
      expect(contents.listenerCount("did-start-navigation")).toBe(0);
      expect(contents.listenerCount("did-navigate")).toBe(0);
      expect(contents.listenerCount("did-fail-load")).toBe(0);

      if (!quitting) {
        await vi.waitFor(async () => {
          expect(
            await readFile(join(userDataPath, "window-state.json"), "utf8"),
          ).toBeTruthy();
        });
      }
    },
  );

  it.each([true, false])(
    "matches each window's page color without resetting on missing metadata (dark: %s)",
    async (dark) => {
      const { createdWindows, factory } = await createFactoryHarness({
        shouldUseDarkColors: () => dark,
      });

      await factory.createWindow({ initialUrl: null, stateKey: null });
      await factory.createWindow({ initialUrl: null, stateKey: null });
      const [first, second] = createdWindows;

      if (!first || !second) throw new Error("Expected two windows");
      expect(first.backgroundColor).toBe(dark ? "#151515" : "#ffffff");

      for (const color of ["#151515", "#ffffff", "#29344a", null]) {
        first.webContents.emit(
          "did-change-theme-color",
          new Event("theme"),
          color,
        );

        expect(first.backgroundColor).toBe(color ?? "#29344a");
        expect(second.backgroundColor).toBe(dark ? "#151515" : "#ffffff");
      }
    },
  );

  it("preserves transparent Linux backgrounds when the page supplies an opaque theme color", async () => {
    const { createdWindows, factory } = await createFactoryHarness({
      isMac: false,
      isLinuxTransparent: true,
    });

    await factory.createWindow({ initialUrl: null, stateKey: null });
    const window = createdWindows[0];

    if (!window) throw new Error("Expected a window");

    window.webContents.emit(
      "did-change-theme-color",
      new Event("theme"),
      "#29344a",
    );

    expect(window.backgroundColor).toBe("#00000000");
  });

  it("creates distinct windows that load the same URL", async () => {
    const generatedStateKeys: WindowStateKey[] = ["window-second"];

    const { createdWindows, factory, userDataPath } =
      await createFactoryHarness({
        createWindowStateKey() {
          return generatedStateKeys.shift() ?? "window-fallback";
        },
      });

    const firstWindow = await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });

    const secondWindow = await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });

    expect(firstWindow).not.toBe(secondWindow);
    expect(createdWindows).toHaveLength(2);
    expect(createdWindows[0]?.options.frame).toBe(false);
    expect(createdWindows[0]?.options.minHeight).toBe(MIN_WINDOW_HEIGHT);
    expect(createdWindows[0]?.options.minWidth).toBe(MIN_WINDOW_WIDTH);
    expect(createdWindows[0]?.options.titleBarStyle).toBe("hiddenInset");
    expect(createdWindows[0]?.options).not.toHaveProperty("autoHideMenuBar");
    expect(createdWindows[0]?.options.webPreferences?.spellcheck).toBe(true);
    expect(createdWindows[0]?.webContents.spellCheckerEnabledValues).toEqual([
      true,
    ]);
    expect(createdWindows[0]?.options.trafficLightPosition).toEqual({
      x: 18,
      y: 18,
    });
    expect(createdWindows[0]?.loadedUrls).toEqual(["http://127.0.0.1:38886"]);
    expect(createdWindows[1]?.loadedUrls).toEqual(["http://127.0.0.1:38886"]);
    expect(createdWindows[0]?.webContents.zoomFactors).toEqual([1]);
    expect(createdWindows[1]?.webContents.zoomFactors).toEqual([1]);

    await factory.persistOpenWindows();
    await expect(
      readPersistedWindowStateEntries({ userDataPath }),
    ).resolves.toEqual([
      {
        bounds: {
          height: 900,
          width: 1280,
          x: 80,
          y: 80,
        },
        isFullScreen: false,
        isMaximized: false,
        stateKey: "main",
      },
      {
        bounds: {
          height: 900,
          width: 1280,
          x: 80,
          y: 80,
        },
        isFullScreen: false,
        isMaximized: false,
        stateKey: "window-second",
      },
    ]);
  });

  it("allocates distinct state keys for concurrent implicit windows", async () => {
    const generatedStateKeys: WindowStateKey[] = ["window-concurrent"];

    const { createdWindows, factory, userDataPath } =
      await createFactoryHarness({
        createWindowStateKey() {
          return generatedStateKeys.shift() ?? "window-fallback";
        },
      });

    const [firstWindow, secondWindow] = await Promise.all([
      factory.createWindow({
        initialUrl: "http://127.0.0.1:38886",
        stateKey: null,
      }),
      factory.createWindow({
        initialUrl: "http://127.0.0.1:38886",
        stateKey: null,
      }),
    ]);

    expect(firstWindow).not.toBe(secondWindow);
    expect(createdWindows).toHaveLength(2);

    await factory.persistOpenWindows();

    const persistedEntries = await readPersistedWindowStateEntries({
      userDataPath,
    });

    const stateKeys = persistedEntries.map((entry) => entry.stateKey);

    expect(new Set(stateKeys)).toEqual(new Set(["main", "window-concurrent"]));
    expect(new Set(stateKeys).size).toBe(2);
  });

  it("opens only policy-approved blank-target links externally and denies every popup", async () => {
    const openedExternalUrls: string[] = [];

    const { createdWindows, factory } = await createFactoryHarness({
      openExternalUrl({ url }) {
        openedExternalUrls.push(url);
      },
    });

    await factory.createWindow({
      initialUrl: "http://127.0.0.1:38886",
      stateKey: null,
    });
    const browserWindow = createdWindows[0];

    if (!browserWindow) {
      throw new Error("Expected desktop window");
    }

    const handler = browserWindow.webContents.windowOpenHandler;

    if (!handler) {
      throw new Error("Expected window open handler");
    }

    const results = [
      "https://example.com/from-markdown",
      "devin://file/Users/me/.omnyo/artifacts/thr_1/review.diff",
      "javascript:alert(1)",
      "file:///System/Applications/Chess.app",
      "http://127.0.0.1:38886/threads/thr_1",
    ].map((url) => handler({ url }));

    expect(createdWindows).toHaveLength(1);
    expect(openedExternalUrls).toEqual([
      "https://example.com/from-markdown",
      "http://127.0.0.1:38886/threads/thr_1",
    ]);
    expect(new Set(results.map((result) => result.action))).toEqual(
      new Set(["deny"]),
    );
  });

  it.each([
    {
      name: "keeps the native frame",
      isLinuxFrameless: false,
      isLinuxTransparent: false,
      present: { autoHideMenuBar: true },
      absent: ["frame", "titleBarStyle", "trafficLightPosition"],
    },
    {
      name: "enables transparency when requested",
      isLinuxFrameless: false,
      isLinuxTransparent: true,
      present: {
        autoHideMenuBar: true,
        transparent: true,
        backgroundColor: "#00000000",
      },
      absent: ["frame"],
    },
    {
      name: "removes the native frame when requested",
      isLinuxFrameless: true,
      isLinuxTransparent: false,
      present: { autoHideMenuBar: true, frame: false },
      absent: ["titleBarStyle", "trafficLightPosition"],
    },
  ])(
    "$name for Linux windows",
    async ({ isLinuxFrameless, isLinuxTransparent, present, absent }) => {
      const { createdWindows, factory } = await createFactoryHarness({
        isMac: false,
        isLinuxTransparent,
        isLinuxFrameless,
      });

      await factory.createWindow({ initialUrl: null, stateKey: null });

      const options = createdWindows[0]?.options;
      expect(options).toMatchObject(present);

      for (const key of absent) {
        expect(options).not.toHaveProperty(key);
      }
    },
  );
});

describe("desktop window navigation recovery", () => {
  it.each<NavigationOutcome>([
    { kind: "http", status: 502 },
    { kind: "network", code: -102 },
  ])(
    "recovers a failed main document without reporting readiness early (%j)",
    async (failure) => {
      vi.useFakeTimers();
      const { factory, createdWindows } = await createFactoryHarness();
      await factory.createWindow({ initialUrl: null, stateKey: null });
      const window = createdWindows[0];

      if (!window) throw new Error("Expected window");
      window.outcomes.push(failure, { kind: "http", status: 200 });
      let complete = false;

      const loading = factory
        .loadUrl({ url: "https://omnyo.example.test" })
        .then(() => {
          complete = true;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toBe(false);
      expect(decodeURIComponent(window.loadedUrls.at(-1) ?? "")).toContain(
        "Reconnecting to Omnyo",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await loading;
      expect(
        window.loadedUrls.filter((url) => url.startsWith("https:")),
      ).toEqual(["https://omnyo.example.test", "https://omnyo.example.test"]);
      expect(complete).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps a successful window and its draft while another initial load retries", async () => {
    vi.useFakeTimers();
    const { factory, createdWindows } = await createFactoryHarness();
    await factory.createWindow({ initialUrl: null, stateKey: null });
    await factory.createWindow({ initialUrl: null, stateKey: null });
    const [healthy, failed] = createdWindows;

    if (!healthy || !failed) throw new Error("Expected two windows");
    failed.outcomes.push(
      { kind: "http", status: 502 },
      { kind: "http", status: 200 },
    );
    const loading = factory.loadUrl({ url: "https://omnyo.example.test" });
    await vi.advanceTimersByTimeAsync(0);
    healthy.draft = "unfinished message";
    await vi.advanceTimersByTimeAsync(2_000);
    await loading;
    expect(healthy.loadedUrls).toEqual(["https://omnyo.example.test"]);
    expect(healthy.draft).toBe("unfinished message");
    expect(
      failed.loadedUrls.filter((url) => url.startsWith("https:")),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers manual Reload in one window without replacing a healthy draft", async () => {
    vi.useFakeTimers();
    const { factory, createdWindows } = await createFactoryHarness();
    await factory.createWindow({ initialUrl: null, stateKey: null });
    await factory.createWindow({ initialUrl: null, stateKey: null });
    await factory.loadUrl({ url: "https://omnyo.example.test" });
    const [healthy, failed] = createdWindows;

    if (!healthy || !failed) throw new Error("Expected two windows");
    healthy.draft = "unfinished message";
    failed.outcomes.push(
      { kind: "http", status: 503 },
      { kind: "http", status: 200 },
    );
    await failed.loadURL("https://omnyo.example.test");
    await vi.advanceTimersByTimeAsync(0);
    expect(decodeURIComponent(failed.loadedUrls.at(-1) ?? "")).toContain(
      "Reconnecting to Omnyo",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(failed.loadedUrls.at(-1)).toBe("https://omnyo.example.test");
    expect(healthy.loadedUrls).toEqual(["https://omnyo.example.test"]);
    expect(healthy.draft).toBe("unfinished message");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows an actionable terminal manual-load error only for the current server", async () => {
    vi.useFakeTimers();

    for (const superseded of [false, true]) {
      let generation = 0;

      const { factory, createdWindows } = await createFactoryHarness({
        getServerTargetGeneration: () => generation,
      });

      await factory.createWindow({
        initialUrl: "https://omnyo.example.test",
        stateKey: null,
      });
      const window = createdWindows[0];

      if (!window) throw new Error("Expected window");
      window.outcomes.push(
        { kind: "http", status: 503 },
        { kind: "network", code: -107 },
      );

      if (superseded) {
        window.webContents.on("did-fail-load", () => {
          generation += 1;
        });
      }

      await window.loadURL("https://omnyo.example.test");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      const document = decodeURIComponent(window.loadedUrls.at(-1) ?? "");
      expect(document.includes("Could not open this Omnyo server")).toBe(
        !superseded,
      );

      if (!superseded)
        expect(document).toContain(
          "Choose a server from the Server menu to reconnect.",
        );
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each(["target", "navigation", "close", "quit"] as const)(
    "cancels failed navigation on %s",
    async (cancellation) => {
      vi.useFakeTimers();
      let generation = 0;
      let quitting = false;

      const { factory, createdWindows, userDataPath } =
        await createFactoryHarness({
          getServerTargetGeneration: () => generation,
          isQuitting: () => quitting,
        });

      await factory.createWindow({ initialUrl: null, stateKey: null });
      const window = createdWindows[0];

      if (!window) throw new Error("Expected window");
      window.outcomes.push({ kind: "http", status: 504 });
      const loading = factory.loadUrl({ url: "https://old.example.test" });
      await vi.advanceTimersByTimeAsync(0);

      if (cancellation === "target") generation += 1;

      if (cancellation === "navigation")
        await factory.loadUrl({ url: "https://new.example.test" });

      if (cancellation === "close") window.emitClosed();

      if (cancellation === "quit") quitting = true;
      await vi.advanceTimersByTimeAsync(4_000);
      await loading;

      if (cancellation === "close") {
        await vi.waitFor(async () => {
          expect(
            await readFile(join(userDataPath, "window-state.json"), "utf8"),
          ).toBeTruthy();
        });
      }

      expect(
        window.loadedUrls.filter((url) => url === "https://old.example.test"),
      ).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("checks the final redirect response and retries the intended URL", async () => {
    vi.useFakeTimers();
    const { factory, createdWindows } = await createFactoryHarness();
    await factory.createWindow({ initialUrl: null, stateKey: null });
    const window = createdWindows[0];

    if (!window) throw new Error("Expected window");
    window.outcomes.push(
      { kind: "http", status: 502, finalUrl: "https://omnyo.example.test/app" },
      { kind: "http", status: 200, finalUrl: "https://omnyo.example.test/app" },
    );
    const loading = factory.loadUrl({ url: "https://omnyo.example.test" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await loading;
    expect(window.loadedUrls.filter((url) => url.startsWith("https:"))).toEqual(
      ["https://omnyo.example.test", "https://omnyo.example.test"],
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<NavigationOutcome>([
    { kind: "http", status: 403 },
    { kind: "network", code: -202 },
  ])("leaves permanent failures terminal (%j)", async (failure) => {
    vi.useFakeTimers();
    const { factory, createdWindows } = await createFactoryHarness();
    await factory.createWindow({ initialUrl: null, stateKey: null });
    const window = createdWindows[0];

    if (!window) throw new Error("Expected window");
    window.outcomes.push(failure);
    await expect(
      factory.loadUrl({ url: "https://omnyo.example.test" }),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(window.loadedUrls).toEqual(["https://omnyo.example.test"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an aborted navigation or a failed subframe", async () => {
    vi.useFakeTimers();
    const { factory, createdWindows } = await createFactoryHarness();
    await factory.createWindow({ initialUrl: null, stateKey: null });
    const window = createdWindows[0];

    if (!window) throw new Error("Expected window");
    window.outcomes.push({ kind: "network", code: -3 });
    await factory.loadUrl({ url: "https://omnyo.example.test" });
    window.webContents.emit(
      "did-fail-load",
      new Event("navigation"),
      -102,
      "connection refused",
      "https://omnyo.example.test/frame",
      false,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(window.loadedUrls).toEqual(["https://omnyo.example.test"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
