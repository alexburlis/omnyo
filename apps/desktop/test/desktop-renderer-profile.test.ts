import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileDesktopRenderer } from "../src/desktop-renderer-profile.js";

function node(
  id: number,
  url: string,
  functionName = "PRIVATE_FUNCTION_CANARY",
  lineNumber = 4,
) {
  return {
    id,
    callFrame: {
      scriptId: String(id),
      url,
      functionName,
      lineNumber,
      columnNumber: 2,
    },
  };
}

function profile(
  nodes = [
    node(
      1,
      "https://app.test/assets/app.js?PRIVATE_URL_CANARY#PRIVATE_FRAGMENT_CANARY",
    ),
  ],
  samples: unknown[] = [1, 1, 1],
) {
  return { profile: { startTime: 1000, endTime: 201000, nodes, samples } };
}

function fixture(
  result: unknown = profile(),
  scripts = [
    {
      scriptId: "1",
      url: "https://app.test/assets/app.js",
      hasSourceURL: false,
    },
  ],
) {
  const debuggerEvents = new EventEmitter();
  const contentsEvents = new EventEmitter();
  let attached = false;
  let destroyed = false;

  const debuggerApi = {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
      debuggerEvents.emit("detach");
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (method: string): Promise<unknown> => {
      if (method === "Debugger.enable") {
        for (const script of scripts)
          debuggerEvents.emit("message", {}, "Debugger.scriptParsed", script);
      }

      return method === "Profiler.stop" ? result : {};
    }),
    on: debuggerEvents.on.bind(debuggerEvents),
    off: debuggerEvents.off.bind(debuggerEvents),
  };

  const contents = {
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    getURL: () => "https://app.test/chat/PRIVATE_ROUTE_CANARY",
    on: (event: "did-start-navigation" | "destroyed", listener: () => void) => {
      contentsEvents.on(event, listener);
    },
    off: (
      event: "did-start-navigation" | "destroyed",
      listener: () => void,
    ) => {
      contentsEvents.off(event, listener);
    },
  };

  return {
    contents,
    debuggerApi,
    debuggerEvents,
    contentsEvents,
    setAttached: (value: boolean) => {
      attached = value;
    },
    destroy: () => {
      destroyed = true;
      contentsEvents.emit("destroyed");
    },
  };
}

async function capture(value: ReturnType<typeof fixture>) {
  const pending = profileDesktopRenderer({
    webContents: value.contents,
    durationMs: 200,
  });

  void pending.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(200);

  return pending;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("renderer profile privacy and ownership", () => {
  it("returns only same-origin asset coordinates and fixed buckets with conserved samples", async () => {
    vi.useFakeTimers();

    const value = fixture(
      profile(
        [
          node(
            1,
            "https://app.test/assets/app.js?PRIVATE_URL_CANARY#PRIVATE_FRAGMENT_CANARY",
          ),
          node(2, "https://foreign.test/assets/PRIVATE_FOREIGN_CANARY.js"),
          node(3, "file:///PRIVATE_LOCAL_CANARY.js"),
          node(4, "https://app.test/private/PRIVATE_PATH_CANARY.js"),
          node(5, "", "(idle)"),
          node(6, "", "(program)"),
          node(7, "", "(garbage collector)"),
          node(8, "https://app.test/assets/subdir/PRIVATE_NESTED_CANARY.js"),
          node(
            9,
            "https://app.test/assets/app.js",
            "PRIVATE_FUNCTION_CANARY",
            -1,
          ),
        ],
        [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 999, "PRIVATE_SAMPLE_CANARY"],
      ),
    );

    const result = await capture(value);
    expect(result).toEqual({
      requestedDurationMs: 200,
      actualDurationMs: 200,
      sampleIntervalUs: 1000,
      totalSamples: 12,
      omittedSamples: 7,
      hotspots: [{ assetPath: "/assets/app.js", line: 5, column: 3, hits: 2 }],
      builtinSamples: { idle: 1, program: 1, garbageCollection: 1 },
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(
      value.debuggerApi.sendCommand.mock.calls.map(([method]) => method),
    ).toEqual([
      "Debugger.setSkipAllPauses",
      "Debugger.enable",
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
    ]);
    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(value.contentsEvents.eventNames()).toEqual([]);
    expect(value.debuggerEvents.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds raw processing and accounts for every truncated sample", async () => {
    vi.useFakeTimers();

    const nodes = Array.from({ length: 20101 }, (_, index) =>
      node(index, `https://app.test/assets/app-${index}.js`),
    );

    const value = fixture(
      profile(
        nodes,
        Array.from({ length: 20101 }, (_, index) => index),
      ),
      nodes.map((entry) => ({
        scriptId: entry.callFrame.scriptId,
        url: entry.callFrame.url,
        hasSourceURL: false,
      })),
    );

    const result = await capture(value);
    expect(result.hotspots).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.omittedSamples).toBe(20001);
    expect(
      result.hotspots.reduce((sum, item) => sum + item.hits, 0) +
        result.omittedSamples,
    ).toBe(result.totalSamples);
  });

  it("omits evaluated code that forges a same-origin asset sourceURL", async () => {
    vi.useFakeTimers();

    const value = fixture(
      profile(
        [
          node(1, "https://app.test/assets/app.js"),
          node(2, "https://app.test/assets/PRIVATE_FORGED_CANARY.js"),
        ],
        [1, 2, 2],
      ),
      [
        {
          scriptId: "1",
          url: "https://app.test/assets/app.js",
          hasSourceURL: false,
        },
        {
          scriptId: "2",
          url: "https://app.test/assets/PRIVATE_FORGED_CANARY.js",
          hasSourceURL: true,
        },
      ],
    );

    const result = await capture(value);
    expect(result.hotspots).toEqual([
      { assetPath: "/assets/app.js", line: 5, column: 3, hits: 1 },
    ]);
    expect(result.omittedSamples).toBe(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FORGED_CANARY");
  });

  it("rejects foreign debugger ownership and overlaps without touching the debugger", async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.setAttached(true);
    await expect(
      profileDesktopRenderer({ webContents: value.contents, durationMs: 200 }),
    ).rejects.toThrow("already attached");
    expect(value.debuggerApi.attach).not.toHaveBeenCalled();
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
    value.setAttached(false);

    const pending = profileDesktopRenderer({
      webContents: value.contents,
      durationMs: 200,
    });

    await expect(
      profileDesktopRenderer({ webContents: value.contents, durationMs: 200 }),
    ).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("never stops or detaches a debugger that replaces its attachment", async () => {
    vi.useFakeTimers();
    const value = fixture();

    const pending = profileDesktopRenderer({
      webContents: value.contents,
      durationMs: 200,
    });

    const rejected = expect(pending).rejects.toThrow("changed");
    await vi.advanceTimersByTimeAsync(0);
    value.setAttached(false);
    value.debuggerEvents.emit("detach");
    value.setAttached(true);
    await rejected;
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
    expect(value.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Profiler.stop",
      undefined,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue a queued command after another debugger takes ownership", async () => {
    const value = fixture();
    value.debuggerApi.attach.mockImplementationOnce(() => {
      value.setAttached(true);
      queueMicrotask(() => {
        value.setAttached(false);
        value.debuggerEvents.emit("detach");
        value.setAttached(true);
      });
    });

    await expect(
      profileDesktopRenderer({ webContents: value.contents, durationMs: 200 }),
    ).rejects.toThrow();
    expect(value.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(value.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it.each(["did-start-navigation", "destroyed"] as const)(
    "invalidates %s and cleans up its own attachment",
    async (event) => {
      vi.useFakeTimers();
      const value = fixture();

      const pending = profileDesktopRenderer({
        webContents: value.contents,
        durationMs: 200,
      });

      const rejected = expect(pending).rejects.toThrow("changed");
      await vi.advanceTimersByTimeAsync(0);
      value.contentsEvents.emit(event);
      await rejected;
      expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    "Debugger.setSkipAllPauses",
    "Debugger.enable",
    "Profiler.enable",
    "Profiler.setSamplingInterval",
    "Profiler.start",
    "Profiler.stop",
  ])("bounds a stalled %s and releases the capture", async (stalled) => {
    vi.useFakeTimers();
    const value = fixture();
    const normal = value.debuggerApi.sendCommand.getMockImplementation()!;
    value.debuggerApi.sendCommand.mockImplementation((method) =>
      method === stalled ? new Promise(() => {}) : normal(method),
    );

    const pending = profileDesktopRenderer({
      webContents: value.contents,
      durationMs: 200,
    });

    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2200);
    await rejected;
    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    value.debuggerApi.sendCommand.mockImplementation(normal);
    expect((await capture(value)).hotspots[0]?.hits).toBe(3);
  });

  it.each([
    null,
    profile([], []),
    profile([
      node(1, "https://app.test/assets/app.js"),
      node(1, "https://app.test/assets/other.js"),
    ]),
  ])("never propagates raw invalid profile values", async (raw) => {
    vi.useFakeTimers();
    const value = fixture(raw);

    if (raw && raw.profile.nodes.length === 0) {
      expect((await capture(value)).totalSamples).toBe(0);
    } else {
      await expect(capture(value)).rejects.toThrow("profile data is invalid");
    }

    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces raw CDP errors with a content-free failure", async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.debuggerApi.sendCommand.mockRejectedValue(
      new Error("PRIVATE_RAW_ERROR_CANARY"),
    );

    const pending = profileDesktopRenderer({
      webContents: value.contents,
      durationMs: 200,
    });

    await expect(pending).rejects.toThrow("Renderer profiler command failed");
    expect(value.debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("rejects destroyed and non-app origins before attachment", async () => {
    const value = fixture();
    value.destroy();
    await expect(
      profileDesktopRenderer({ webContents: value.contents, durationMs: 200 }),
    ).rejects.toThrow("unavailable");
    const other = fixture();
    other.contents.getURL = () => "data:text/html,PRIVATE_CANARY";
    await expect(
      profileDesktopRenderer({ webContents: other.contents, durationMs: 200 }),
    ).rejects.toThrow("origin is unavailable");
    expect(value.debuggerApi.attach).not.toHaveBeenCalled();
    expect(other.debuggerApi.attach).not.toHaveBeenCalled();
  });
});
