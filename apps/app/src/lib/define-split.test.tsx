// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { downloadSplit, readSplitFailureDiagnostic } from "./split-load";
import { defineSplit } from "./define-split";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installSplitManifest(splits: Record<string, string[]>) {
  const files = [...new Set(Object.values(splits).flat())];
  const manifest = document.createElement("script");
  manifest.id = "omnyo-prefetch-manifest";
  manifest.type = "application/json";
  manifest.textContent = JSON.stringify({
    files,
    splits: Object.fromEntries(
      Object.entries(splits).map(([id, urls]) => [
        id,
        urls.map((url) => files.indexOf(url)),
      ]),
    ),
  });
  document.head.append(manifest);

  return manifest;
}

function stubRelay(isUp: () => boolean) {
  const fetch = vi.fn(async () =>
    isUp()
      ? { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }
      : { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) },
  );

  vi.stubGlobal("fetch", fetch);

  return fetch;
}

function moduleThatStaysBrokenIfImportedOffline(
  isUp: () => boolean,
  View: React.ComponentType,
) {
  let failedOnce = false;

  return vi.fn(async () => {
    if (!isUp()) failedOnce = true;

    if (failedOnce) throw new TypeError("Importing a module script failed.");

    return View;
  });
}

it("keeps a feature loadable after its explicit preload met a failing relay", async () => {
  vi.useFakeTimers();
  let relayUp = false;

  const manifest = installSplitManifest({
    "relay-thread": ["/assets/relay-thread.js"],
  });

  stubRelay(() => relayUp);

  const load = moduleThatStaysBrokenIfImportedOffline(
    () => relayUp,
    () => <p>Thread opened</p>,
  );

  const Split = defineSplit({
    id: "relay-thread",
    load,
    loading: () => <p>Loading thread</p>,
  });

  try {
    const warm = Split.preload();
    await act(async () => vi.runAllTimersAsync());
    await warm;
    expect(load).not.toHaveBeenCalled();
    relayUp = true;
    render(<Split />);
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText("Thread opened")).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
  } finally {
    manifest.remove();
  }
});

it("joins an in-flight download when the feature is opened and fetches each file once", async () => {
  const manifest = installSplitManifest({
    "download-only": ["/assets/download-only.js"],
  });

  let finish!: () => void;

  const body = new Promise<ArrayBuffer>((resolve) => {
    finish = () => resolve(new ArrayBuffer(0));
  });

  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: () => body,
  }));

  vi.stubGlobal("fetch", fetch);
  const load = vi.fn(async () => () => <p>Downloaded editor</p>);

  const Split = defineSplit({
    id: "download-only",
    load,
    loading: () => <p>Waiting for bytes</p>,
  });

  try {
    const downloading = downloadSplit("download-only");
    await act(async () => {});
    expect(fetch).toHaveBeenCalledOnce();
    render(<Split />);
    await act(async () => {});
    expect(screen.getByText("Waiting for bytes")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await downloading;
    });
    expect(await screen.findByText("Downloaded editor")).toBeTruthy();
    expect(await downloadSplit("download-only")).toBe("downloaded");
    expect(fetch).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  } finally {
    finish();
    manifest.remove();
  }
});

it("shares a pending intent preload with rendering, preserves props, and stays mounted across parent renders", async () => {
  let finish: (
    value: React.ComponentType<{ label: string }>,
  ) => void = () => {};

  const load = vi.fn(
    () =>
      new Promise<React.ComponentType<{ label: string }>>((resolve) => {
        finish = resolve;
      }),
  );

  const Split = defineSplit({
    id: "editor",
    load,
    loading: ({ label }) => <p>Loading {label}</p>,
  });

  const view = render(<button {...Split.intentProps}>Open</button>);
  expect(load).not.toHaveBeenCalled();
  fireEvent.focus(screen.getByRole("button"));
  fireEvent.pointerEnter(screen.getByRole("button"));
  await act(async () => {});
  view.rerender(<Split label="document" />);
  expect(screen.getByText("Loading document")).toBeTruthy();
  expect(load).toHaveBeenCalledOnce();
  await act(async () =>
    finish(({ label }) => <input aria-label={label} defaultValue="draft" />),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "unsaved" },
  });
  view.rerender(<Split label="renamed" />);
  expect(screen.getByRole("textbox", { name: "renamed" })).toHaveProperty(
    "value",
    "unsaved",
  );
});

it("keeps load failure local and retries a failed import instead of caching the rejection forever", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi.fn<() => Promise<React.ComponentType>>();
  load.mockRejectedValueOnce(new Error("offline"));
  load.mockResolvedValueOnce(() => <p>Editor ready</p>);

  const Split = defineSplit({
    id: "retry",
    load,
    loading: () => <p>Loading</p>,
  });

  render(
    <>
      <p>Shell stays</p>
      <Split />
    </>,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Shell stays")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Editor ready")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it("recovers from a rejected speculative preload when the feature is opened", async () => {
  const load = vi.fn<() => Promise<React.ComponentType>>();
  load.mockRejectedValueOnce(new Error("offline"));
  load.mockResolvedValueOnce(() => <p>Ready after preload failure</p>);

  const Split = defineSplit({
    id: "preload-retry",
    load,
    loading: () => null,
  });

  await Split.preload();
  render(<Split />);
  expect(await screen.findByText("Ready after preload failure")).toBeTruthy();
});

it.each(["preload", "previous mount"])(
  "does not commit a loading fallback after %s resolves the component",
  async (warmup) => {
    const fallbackCommitted = vi.fn();

    function Loading() {
      useLayoutEffect(() => {
        fallbackCommitted();
      }, []);

      return <p>Loading cached feature</p>;
    }

    const Split = defineSplit({
      id: "cached-mount",
      load: async () => () => <input aria-label="Cached editor" />,
      loading: Loading,
    });

    if (warmup === "preload") {
      await Split.preload();
    } else {
      const first = render(<Split />);
      await screen.findByRole("textbox", { name: "Cached editor" });
      first.unmount();
      fallbackCommitted.mockClear();
    }

    const second = render(<Split />);
    expect(fallbackCommitted).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Cached editor" })).toBeTruthy();
    second.unmount();
  },
);

it("retries a failed download twice across preload and opening, then imports once", async () => {
  vi.useFakeTimers();

  const manifest = installSplitManifest({
    "automatic-retry": ["/assets/automatic-retry.js"],
  });

  let failures = 2;
  const fetch = stubRelay(() => failures-- <= 0);
  const load = vi.fn(async () => () => <p>Recovered editor</p>);

  const Split = defineSplit({
    id: "automatic-retry",
    load,
    loading: () => <p>Loading editor</p>,
  });

  try {
    const warm = Split.preload();
    render(<Split />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Loading editor")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    await warm;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("Recovered editor")).toBeTruthy();
  } finally {
    manifest.remove();
  }
});

it("stops after three failed downloads without importing, and Try again downloads again", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let relayUp = false;

  const manifest = installSplitManifest({
    "exhausted-retry": ["/assets/exhausted-retry.js"],
  });

  const fetch = stubRelay(() => relayUp);
  const load = vi.fn(async () => () => <p>Editor after the relay recovered</p>);

  const Split = defineSplit({
    id: "exhausted-retry",
    load,
    loading: () => <p>Loading editor</p>,
  });

  try {
    render(<Split />);
    await act(async () => vi.runAllTimersAsync());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetch).toHaveBeenCalledTimes(3);
    relayUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText("Editor after the relay recovered")).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
  } finally {
    manifest.remove();
  }
});

it.each(["http", "timeout", "network"] as const)(
  "preserves the safe terminal %s download cause without request content",
  async (kind) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = `diagnostic-${kind}`;

    const manifest = installSplitManifest({
      [id]: [
        `https://private.example/assets/${id}-AbCd1234.js?private=request-content`,
      ],
    });

    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      if (kind === "network")
        throw new TypeError("private=request-content network detail");

      if (kind === "timeout")
        await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private=request-content timeout detail")),
            { once: true },
          );
        });

      return new Response(null, { status: 503 });
    });

    vi.stubGlobal("fetch", fetch);
    const load = vi.fn(async () => () => null);
    let capturedError: Error | undefined;

    const Split = defineSplit({
      id,
      load,
      loading: () => null,
      error: ({ error }) => {
        capturedError = error;

        return <p role="alert">{error?.message}</p>;
      },
    });

    try {
      render(<Split />);
      await act(async () => vi.runAllTimersAsync());

      const reason =
        kind === "http"
          ? "HTTP 503"
          : kind === "timeout"
            ? "timeout"
            : "network failure";

      expect(screen.getByRole("alert").textContent).toBe(
        `Could not download the ${id} feature (${reason} after 3 attempts)`,
      );
      expect(screen.getByRole("alert").textContent).not.toContain(
        "request-content",
      );
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(load).not.toHaveBeenCalled();
      expect(readSplitFailureDiagnostic(capturedError)).toEqual({
        operation: "split-load",
        stage: "download",
        kind,
        failureClass:
          kind === "http"
            ? "upstream-rejected"
            : kind === "timeout"
              ? "timeout"
              : "connection",
        outcome: "terminal",
        attempt: 3,
        assetName: `${id}-AbCd1234.js`,
        downloadPhase: "request",
        online: true,
        ...(kind === "http" ? { status: 503 } : {}),
      });
    } finally {
      manifest.remove();
    }
  },
);

it.each(["headers", "body"])(
  "times out stalled response %s, reports failure, and recovers on request",
  async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const id = `stalled-${phase}`;

    const manifest = installSplitManifest({
      [id]: [`/assets/${id}.js`],
    });

    let recovered = false;

    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      const stall = () =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });

      if (!recovered && phase === "headers") await stall();

      return {
        ok: true,
        status: 200,
        arrayBuffer: () =>
          recovered ? Promise.resolve(new ArrayBuffer(0)) : stall(),
      };
    });

    vi.stubGlobal("fetch", fetch);
    const load = vi.fn(async () => () => <p>Recovered stalled feature</p>);

    const Split = defineSplit({
      id,
      load,
      loading: () => <p>Waiting for stalled feature</p>,
    });

    try {
      render(<Split />);
      await act(async () => vi.advanceTimersByTimeAsync(32_000));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(load).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toBeTruthy();
      recovered = true;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await act(async () => vi.runAllTimersAsync());
      expect(screen.getByText("Recovered stalled feature")).toBeTruthy();
      expect(load).toHaveBeenCalledOnce();
    } finally {
      manifest.remove();
    }
  },
);

it("offers a full reload without retrying when the browser refuses a downloaded module", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});

  const manifest = installSplitManifest({
    "refused-module": ["/assets/refused-module-AbCd1234.js"],
  });

  stubRelay(() => true);

  const originalError = new TypeError("Importing a module script failed.");
  const originalStack = originalError.stack;

  const load = vi
    .fn<() => Promise<React.ComponentType>>()
    .mockRejectedValue(originalError);

  const Split = defineSplit({
    id: "refused-module",
    load,
    loading: () => <p>Loading editor</p>,
  });

  try {
    render(<Split />);
    await act(async () => vi.runAllTimersAsync());
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reload Omnyo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(originalError.stack).toBe(originalStack);
    expect(readSplitFailureDiagnostic(originalError)).toEqual({
      operation: "split-load",
      stage: "import",
      kind: "module",
      failureClass: "unknown",
      outcome: "terminal",
      attempt: 1,
      assetName: "refused-module-AbCd1234.js",
      preflight: "downloaded",
      importFailure: "fetch",
      online: true,
    });
  } finally {
    manifest.remove();
  }
});

it.each([
  new SyntaxError("Unexpected token in feature module"),
  new Error("Unable to preload CSS for /assets/editor.css"),
])(
  "does not automatically retry non-JavaScript-download failures: %s",
  async (error) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const load = vi
      .fn<() => Promise<React.ComponentType>>()
      .mockRejectedValue(error);

    const Split = defineSplit({
      id: "non-download-failure",
      load,
      loading: () => null,
    });

    render(<Split />);
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
  },
);

it("mounts only when wanted and keeps a retained split mounted after it closes", async () => {
  const Split = defineSplit<{ open: boolean }>({
    id: "gated",
    load: async () => () => <input aria-label="Gated editor" />,
    loading: () => null,
    unmounted: () => <p>Closed shell</p>,
    mountWhen: ({ open }) => open,
    keepMounted: true,
  });

  const view = render(<Split open={false} />);
  expect(screen.getByText("Closed shell")).toBeTruthy();
  view.rerender(<Split open />);
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Gated editor" }),
    { target: { value: "kept" } },
  );
  view.rerender(<Split open={false} />);
  expect(screen.queryByText("Closed shell")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Gated editor" })).toHaveProperty(
    "value",
    "kept",
  );
});

it("does not load an unused feature when the current route finishes", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const { defineSplit: define } = await import("./define-split");

  const { trackCriticalLoad, whenCriticalLoadsSettled } =
    await import("./split-load");

  const load = vi.fn(async () => () => <p>Optional editor</p>);
  const Optional = define({ id: "unused-editor", load, loading: () => null });
  const ready = whenCriticalLoadsSettled();
  await trackCriticalLoad(Promise.resolve());
  await act(async () => vi.runAllTimersAsync());
  await ready;
  expect(load).not.toHaveBeenCalled();
  await Optional.preload();
  expect(load).toHaveBeenCalledOnce();
});
