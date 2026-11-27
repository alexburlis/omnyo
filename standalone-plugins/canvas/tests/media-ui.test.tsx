import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { ResponsiveMedia } from "../components/media";
import type { MediaManifest } from "../media-contract";

const observed = new Map<Element, () => void>();

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly measure: () => void) {}
      observe(target: Element) {
        observed.set(target, this.measure);
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  observed.clear();
  vi.unstubAllGlobals();
});

function manifest(assetId: string): MediaManifest {
  const root = `/api/v1/plugins/canvas/http`;

  return {
    width: 3840,
    height: 2160,
    animated: false,
    originalUrl: `${root}/asset?id=${assetId}`,
    variants: [640, 1280, 3840].map((width) => ({
      width,
      height: (width * 9) / 16,
      mime: "image/webp",
      lossless: true,
      url: `${root}/asset-preview?id=${assetId}&width=${width}`,
    })),
  };
}

function response(assetId: string) {
  return Response.json(manifest(assetId));
}

function pending<Value>() {
  let resolve: (value: Value) => void = () => {};

  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

it("shares pending and completed image metadata across panel reopenings", async () => {
  const assetId = "a".repeat(64);
  const result = pending<Response>();
  const fetch = vi.fn(() => result.promise);
  vi.stubGlobal("fetch", fetch);
  const props = { assetId, title: "Combat capture", zoom: 1 };
  const first = renderSlot({ component: ResponsiveMedia }, props, { pluginId: "canvas" });
  expect(screen.getByLabelText("Loading image")).toBeTruthy();
  first.unmount();
  const second = renderSlot({ component: ResponsiveMedia }, props, { pluginId: "canvas" });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => result.resolve(response(assetId)));
  expect(await screen.findByRole("img", { name: props.title })).toBeTruthy();
  second.unmount();
  renderSlot({ component: ResponsiveMedia }, props, { pluginId: "canvas" });
  expect(await screen.findByRole("img", { name: props.title })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("offers responsive lossless sizes while keeping the exact original as the open target", async () => {
  const assetId = "b".repeat(64);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(assetId)),
  );
  renderSlot(
    { component: ResponsiveMedia },
    { assetId, title: "Flight capture", zoom: 0.5 },
    { pluginId: "canvas" },
  );
  const image = await screen.findByRole("img", { name: "Flight capture" });
  const original = manifest(assetId);
  expect(image.getAttribute("srcset")).toBe(
    original.variants.map((v) => `${v.url} ${v.width}w`).join(", "),
  );
  expect(image.getAttribute("width")).toBe("3840");
  expect(image.getAttribute("height")).toBe("2160");
  expect(image.getAttribute("decoding")).toBe("async");
  const link = image.closest("a");

  if (link === null) throw new Error("The original-image link is missing");
  expect(link.getAttribute("href")).toBe(original.originalUrl);
  Object.defineProperty(link, "clientWidth", { value: 800 });
  act(() => observed.get(link)?.());
  await waitFor(() => expect(image.getAttribute("sizes")).toBe("400px"));
});

it.each(["metadata", "image"])(
  "shows a recoverable error when %s loading fails",
  async (failure) => {
    const assetId = (failure === "metadata" ? "c" : "d").repeat(64);
    let reads = 0;

    const fetch = vi.fn(async () =>
      ++reads === 1 && failure === "metadata"
        ? new Response(null, { status: 503 })
        : response(assetId),
    );

    vi.stubGlobal("fetch", fetch);
    renderSlot(
      { component: ResponsiveMedia },
      { assetId, title: "Retry capture", zoom: 1 },
      { pluginId: "canvas" },
    );

    if (failure === "image")
      fireEvent.error(await screen.findByRole("img", { name: "Retry capture" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("img", { name: "Retry capture" })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  },
);
