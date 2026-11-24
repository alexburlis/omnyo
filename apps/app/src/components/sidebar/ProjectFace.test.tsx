// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { buildProjectFileContentUrl } from "@/lib/file-content-urls";
import { classifyIconPixels, ProjectIcon, TileIconImage } from "./ProjectFace";
import { railAttentionFixtureCatalog } from "./rail-attention.fixture";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();

const ICON_CACHE_KEY = "omnyo.sidebar.project-icon:v2:proj_web:src_web";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

const SVG_DATA_URL = `data:image/svg+xml;base64,${btoa(SVG)}`;

let navigation: SidebarBootstrapResponse | undefined;

let hosts: Host[] = [];

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: navigation }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: hosts }),
}));

vi.mock("@/lib/sdk", () => ({ sdk: { files: { list: mocks.list } } }));

function renderIcon(projectId: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectIcon projectId={projectId} className="plugin-mark" />
    </QueryClientProvider>,
  );
}

function withWebSource(
  catalog: SidebarBootstrapResponse,
): SidebarBootstrapResponse {
  return {
    ...catalog,
    projects: catalog.projects.map((project) =>
      project.id === "proj_web"
        ? {
            ...project,
            sources: [
              {
                id: "src_web",
                projectId: "proj_web",
                type: "local_path",
                isDefault: true,
                hostId: "host_mac",
                path: "/Users/developer/projects/web",
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          }
        : project,
    ),
  };
}

beforeEach(() => {
  navigation = railAttentionFixtureCatalog();
  hosts = [];
  mocks.list.mockReset();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error("no icon bytes in this test"));
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ProjectIcon", () => {
  it("renders the icon file the rail discovers inside the caller's sized mark", async () => {
    hosts = [makeHost({ id: "host_mac", status: "connected" })];
    navigation = withWebSource(railAttentionFixtureCatalog());
    mocks.list.mockResolvedValue({
      files: [{ path: "public/icon.svg", name: "icon.svg" }],
      truncated: false,
    });

    const { container } = renderIcon("proj_web");

    const image = await waitFor(() => {
      const found = container.querySelector("img");

      if (found === null) throw new Error("Expected the project icon");

      return found;
    });

    expect(image.getAttribute("src")).toBe(
      buildProjectFileContentUrl("proj_web", "public/icon.svg", {
        environmentId: null,
        hostId: "host_mac",
      }),
    );
    expect(image.closest(".plugin-mark")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("shows the monogram while the project's machine is offline", () => {
    navigation = withWebSource(railAttentionFixtureCatalog());

    const { container } = renderIcon("proj_web");

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-rail-tile-monogram]")?.textContent,
    ).not.toBe("");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("shows the cached icon image while the project's machine is offline", () => {
    navigation = withWebSource(railAttentionFixtureCatalog());
    window.localStorage.setItem(
      ICON_CACHE_KEY,
      JSON.stringify({
        path: "public/icon.svg",
        at: Date.now(),
        hostId: "host_mac",
        root: "/Users/developer/projects/web",
        image: { dataUrl: SVG_DATA_URL, at: Date.now() },
      }),
    );

    const { container } = renderIcon("proj_web");

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      SVG_DATA_URL,
    );
    expect(container.querySelector("[data-rail-tile-monogram]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a cached icon image older than the path refresh window while offline", () => {
    navigation = withWebSource(railAttentionFixtureCatalog());
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(
      ICON_CACHE_KEY,
      JSON.stringify({
        path: "public/icon.svg",
        at: eightDaysAgo,
        hostId: "host_mac",
        root: "/Users/developer/projects/web",
        image: { dataUrl: SVG_DATA_URL, at: eightDaysAgo },
      }),
    );

    const { container } = renderIcon("proj_web");

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      SVG_DATA_URL,
    );
  });

  it("drops a cached icon image whose file is gone and finds the moved icon", async () => {
    hosts = [makeHost({ id: "host_mac", status: "connected" })];
    navigation = withWebSource(railAttentionFixtureCatalog());
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    window.localStorage.setItem(
      ICON_CACHE_KEY,
      JSON.stringify({
        path: "icon.svg",
        at: yesterday,
        hostId: "host_mac",
        root: "/Users/developer/projects/web",
        image: { dataUrl: SVG_DATA_URL, at: yesterday },
      }),
    );
    mocks.list.mockResolvedValue({
      files: [{ path: "public/icon.svg", name: "icon.svg" }],
      truncated: false,
    });

    const movedUrl = buildProjectFileContentUrl("proj_web", "public/icon.svg", {
      environmentId: null,
      hostId: "host_mac",
    });

    fetchMock.mockImplementation(async (url) =>
      String(url) === movedUrl
        ? new Response(SVG, { headers: { "content-type": "image/svg+xml" } })
        : new Response("missing", { status: 404 }),
    );

    renderIcon("proj_web");

    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(ICON_CACHE_KEY) ?? "{}"),
      ).toMatchObject({
        path: "public/icon.svg",
        image: { dataUrl: expect.stringMatching(/^data:image\/svg\+xml/u) },
      }),
    );
    expect(mocks.list).toHaveBeenCalled();
  });

  it("caches the icon image after loading it from the project's machine", async () => {
    hosts = [makeHost({ id: "host_mac", status: "connected" })];
    navigation = withWebSource(railAttentionFixtureCatalog());
    mocks.list.mockResolvedValue({
      files: [{ path: "public/icon.svg", name: "icon.svg" }],
      truncated: false,
    });
    fetchMock.mockResolvedValue(
      new Response(SVG, { headers: { "content-type": "image/svg+xml" } }),
    );

    const { container } = renderIcon("proj_web");

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/svg\+xml;base64,/u,
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      buildProjectFileContentUrl("proj_web", "public/icon.svg", {
        environmentId: null,
        hostId: "host_mac",
      }),
      expect.anything(),
    );
    expect(
      JSON.parse(window.localStorage.getItem(ICON_CACHE_KEY) ?? "{}").image
        ?.dataUrl,
    ).toMatch(/^data:image\/svg\+xml;base64,/u);
  });

  it("renders nothing for an unknown project or before the catalog loads", () => {
    expect(renderIcon("proj_missing").container.innerHTML).toBe("");
    cleanup();
    navigation = undefined;
    expect(renderIcon("proj_web").container.innerHTML).toBe("");
  });
});

describe("classifyIconPixels", () => {
  type Rgba = readonly [number, number, number, number];

  const SIZE = 8;

  function iconPixels(field: Rgba, mark: Rgba): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);

    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const inMark = x >= 2 && x < SIZE - 2 && y >= 2 && y < SIZE - 2;
        pixels.set(inMark ? mark : field, (y * SIZE + x) * 4);
      }
    }

    return pixels;
  }

  it.each([
    [
      "a dark logo on a white field",
      [255, 255, 255, 255],
      [20, 20, 20, 255],
      "dark-mark",
    ],
    [
      "a coloured logo on a pale neutral field",
      [236, 246, 242, 255],
      [40, 170, 120, 255],
      "dark-mark",
    ],
    [
      "a dark logo on a transparent field",
      [0, 0, 0, 0],
      [20, 20, 20, 255],
      "dark-mark",
    ],
    [
      "a white logo on a transparent field",
      [0, 0, 0, 0],
      [250, 250, 250, 255],
      "light-mark",
    ],
    [
      "a mid-tone logo on a transparent field",
      [0, 0, 0, 0],
      [220, 60, 40, 255],
      "mark",
    ],
    [
      "a full-bleed yellow tile",
      [245, 217, 10, 255],
      [30, 30, 30, 255],
      "artwork",
    ],
    [
      "a full-bleed dark tile",
      [30, 30, 40, 255],
      [250, 250, 250, 255],
      "artwork",
    ],
  ] as const)("classifies %s as %s", (_name, field, mark, tone) => {
    expect(classifyIconPixels(iconPixels(field, mark), SIZE)).toBe(tone);
  });
});

describe("TileIconImage", () => {
  function loadedImage(width: number) {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      width,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an image that finished loading before its load listener attached", () => {
    loadedImage(16);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) }),
    } as unknown as CanvasRenderingContext2D);
    const src = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" id="a"/>')}`;

    const { container } = render(
      <TileIconImage src={src} onError={() => undefined} />,
    );

    expect(container.querySelector("img")?.className).not.toContain(
      "opacity-0",
    );
  });

  it("shows every tile that shares an image once any of them measured it", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) }),
    } as unknown as CanvasRenderingContext2D);
    const src = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" id="c"/>')}`;

    const { container } = render(
      <>
        <TileIconImage src={src} onError={() => undefined} />
        <TileIconImage src={src} onError={() => undefined} />
      </>,
    );

    const [first, second] = container.querySelectorAll("img");
    fireEvent.load(first!);
    fireEvent.load(second!);

    expect(
      [...container.querySelectorAll("img")].map((image) =>
        image.className.includes("opacity-0"),
      ),
    ).toEqual([false, false]);
  });

  it("shows the image unchanged when sampling it fails", () => {
    loadedImage(16);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => {
        throw new Error("tainted");
      },
    );
    const src = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" id="b"/>')}`;

    const { container } = render(
      <TileIconImage src={src} onError={() => undefined} />,
    );

    expect(
      container
        .querySelector("[data-rail-tile-icon-tone]")
        ?.getAttribute("data-rail-tile-icon-tone"),
    ).toBe("artwork");
  });
});
