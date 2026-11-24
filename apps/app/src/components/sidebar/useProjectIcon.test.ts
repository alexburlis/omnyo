// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSource } from "@omnyo/domain";
import { buildProjectFileContentUrl } from "@/lib/file-content-urls";
import {
  MAX_CONCURRENT_PROJECT_ICON_RESOLUTIONS,
  PROJECT_ICON_CACHE_TTL_MS,
  pickProjectIconPath,
  projectMonogram,
  projectMonogramHue,
  selectProjectIconSource,
  useProjectIcon,
  type ProjectIconProject,
} from "./useProjectIcon";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { files: { list: mocks.list } },
}));

const HOST_ID = "host_mac";

const CONNECTED: ReadonlySet<string> = new Set([HOST_ID]);

function source(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    id: "src_main",
    projectId: "proj_app",
    type: "local_path",
    isDefault: true,
    hostId: HOST_ID,
    path: "/Users/developer/projects/app",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function project(
  overrides: Partial<ProjectIconProject> = {},
): ProjectIconProject {
  return {
    id: "proj_app",
    kind: "standard",
    sources: [source()],
    ...overrides,
  };
}

function listing(paths: string[]) {
  return {
    files: paths.map((path) => ({ path, name: path.split("/").at(-1) ?? "" })),
    truncated: false,
  };
}

function renderIcon(
  target: ProjectIconProject,
  connected: ReadonlySet<string> = CONNECTED,
  client = new QueryClient(),
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return renderHook(() => useProjectIcon(target, connected), {
    wrapper: Wrapper,
  });
}

function iconUrl(path: string, projectId = "proj_app"): string {
  return buildProjectFileContentUrl(projectId, path, {
    environmentId: null,
    hostId: HOST_ID,
  });
}

beforeEach(() => {
  mocks.list.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("pickProjectIconPath", () => {
  it("prefers app icons over favicons, then the shallowest path", () => {
    expect(
      pickProjectIconPath([
        "apps/web/public/favicon.ico",
        "apps/desktop/assets/icon.png",
        "src/components/Icon.tsx",
        "favicon.svg",
        "assets/icons/close.png",
        "apps/app/app-icon.svg",
      ]),
    ).toBe("apps/app/app-icon.svg");
    expect(
      pickProjectIconPath([
        "apps/web/public/favicon.ico",
        "public/favicon.png",
        "favicon-32x32.png",
      ]),
    ).toBe("public/favicon.png");
    expect(pickProjectIconPath(["src/Icon.tsx", "icon.jpg"])).toBeNull();
  });
});

describe("selectProjectIconSource", () => {
  it("uses the default source, then the first, and never Personal", () => {
    const first = source({ id: "src_first", isDefault: false });
    const fallback = source({ id: "src_default", isDefault: true });
    expect(
      selectProjectIconSource(project({ sources: [first, fallback] }))?.id,
    ).toBe("src_default");
    expect(
      selectProjectIconSource(
        project({
          sources: [first, source({ id: "src_b", isDefault: false })],
        }),
      )?.id,
    ).toBe("src_first");
    expect(
      selectProjectIconSource(
        project({ id: "proj_personal", kind: "personal" }),
      ),
    ).toBeNull();
  });
});

describe("useProjectIcon", () => {
  it("uses the saved custom icon offline without searching the project", () => {
    const customIcon = "data:image/png;base64,custom";
    const { result } = renderIcon(project({ customIcon }), new Set());
    expect(result.current.image).toBe(customIcon);
    expect(result.current.url).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("resumes automatic discovery after removing a custom icon", async () => {
    mocks.list.mockResolvedValue(listing(["assets/icon.png"]));

    const { result, rerender } = renderHook(
      ({ customIcon }) => useProjectIcon(project({ customIcon }), CONNECTED),
      {
        initialProps: {
          customIcon: "data:image/png;base64,custom" as string | null,
        },
        wrapper: ({ children }) =>
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            children,
          ),
      },
    );

    expect(result.current.image).toBe("data:image/png;base64,custom");
    rerender({ customIcon: null });
    await waitFor(() =>
      expect(result.current.url).toBe(iconUrl("assets/icon.png")),
    );
  });
  it("recovers from a temporary listing failure without remounting", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("host went away"))
      .mockResolvedValue(listing(["assets/icon.png"]));

    const client = new QueryClient({
      defaultOptions: { queries: { retryDelay: 10 } },
    });

    const { result } = renderIcon(project(), CONNECTED, client);

    await waitFor(() =>
      expect(result.current.url).toBe(iconUrl("assets/icon.png")),
    );
  });

  it("requests bounded icon discovery once and caches the choice", async () => {
    mocks.list.mockResolvedValue(listing(["web/public/favicon.ico"]));
    const { result } = renderIcon(project());
    await waitFor(() =>
      expect(result.current.url).toBe(iconUrl("web/public/favicon.ico")),
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]?.[0]).toMatchObject({
      discovery: "icons",
      includeHidden: false,
    });
    cleanup();
    const again = renderIcon(project());
    expect(again.result.current.url).toBe(iconUrl("web/public/favicon.ico"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("does not persist an incomplete negative search", async () => {
    mocks.list.mockResolvedValue({ files: [], truncated: true });
    renderIcon(project());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(
      window.localStorage.getItem(
        "omnyo.sidebar.project-icon:v2:proj_app:src_main",
      ),
    ).toBeNull();
  });

  it("stops after the icon query when it finds an app icon", async () => {
    mocks.list.mockResolvedValue(listing(["assets/icon.png", "favicon.ico"]));

    const { result } = renderIcon(project());
    await waitFor(() =>
      expect(result.current.url).toBe(iconUrl("assets/icon.png")),
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("caches a project without an icon so it is not listed again", async () => {
    mocks.list.mockResolvedValue(listing([]));

    renderIcon(project());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        window.localStorage.getItem(
          "omnyo.sidebar.project-icon:v2:proj_app:src_main",
        ),
      ).toContain('"path":null'),
    );

    cleanup();
    const again = renderIcon(project(), CONNECTED, new QueryClient());
    expect(again.result.current.url).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed listing", async () => {
    mocks.list.mockRejectedValueOnce(new Error("host went away"));

    const { result } = renderIcon(project());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(result.current.url).toBeNull();
    expect(
      window.localStorage.getItem(
        "omnyo.sidebar.project-icon:v2:proj_app:src_main",
      ),
    ).toBeNull();

    cleanup();
    mocks.list.mockResolvedValue(listing(["icon.svg"]));
    const again = renderIcon(project(), CONNECTED, new QueryClient());
    await waitFor(() =>
      expect(again.result.current.url).toBe(iconUrl("icon.svg")),
    );
  });

  it("lists again once the cached choice is older than seven days", async () => {
    window.localStorage.setItem(
      "omnyo.sidebar.project-icon:v2:proj_app:src_main",
      JSON.stringify({
        path: "old/icon.png",
        at: Date.now() - PROJECT_ICON_CACHE_TTL_MS - 1,
        hostId: HOST_ID,
        root: "/Users/developer/projects/app",
      }),
    );
    mocks.list.mockResolvedValue(listing(["new/icon.png"]));

    const { result } = renderIcon(project());
    await waitFor(() =>
      expect(result.current.url).toBe(iconUrl("new/icon.png")),
    );
  });

  it("replaces a saved icon image once the file changed on disk", async () => {
    window.localStorage.setItem(
      "omnyo.sidebar.project-icon:v2:proj_app:src_main",
      JSON.stringify({
        path: "icon.png",
        at: Date.now(),
        hostId: HOST_ID,
        root: "/Users/developer/projects/app",
        image: {
          dataUrl: "data:image/png;base64,b2xk",
          at: Date.now() - 10 * 60 * 1000,
        },
      }),
    );

    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      blob: async () => new Blob(["new"], { type: "image/png" }),
    }));

    vi.stubGlobal("fetch", fetchMock);

    try {
      const { result } = renderIcon(project());
      expect(result.current.image).toBe("data:image/png;base64,b2xk");

      await waitFor(() =>
        expect(result.current.image).toBe("data:image/png;base64,bmV3"),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        iconUrl("icon.png"),
        expect.anything(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips a project whose source host is offline", () => {
    const { result } = renderIcon(project(), new Set());

    expect(result.current.url).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("resolves at most three projects at once", async () => {
    const pending: (() => void)[] = [];
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(listing(["icon.png"])));
        }),
    );

    const client = new QueryClient();

    const projects = Array.from({ length: 5 }, (_, index) =>
      project({
        id: `proj_${index}`,
        sources: [source({ id: `src_${index}`, projectId: `proj_${index}` })],
      }),
    );

    const rendered = projects.map((target) =>
      renderIcon(target, CONNECTED, client),
    );

    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledTimes(
        MAX_CONCURRENT_PROJECT_ICON_RESOLUTIONS,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.list).toHaveBeenCalledTimes(3);

    pending.shift()?.();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(4));

    while (mocks.list.mock.calls.length < 5 || pending.length > 0) {
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await waitFor(() =>
      expect(rendered.map(({ result }) => result.current.url)).toEqual(
        projects.map((target) => iconUrl("icon.png", target.id)),
      ),
    );
  });
});

describe("project monograms", () => {
  it("uses two initials for multi-word names and two letters otherwise", () => {
    expect(projectMonogram("omnyo-private")).toBe("op");
    expect(projectMonogram("Glassy UI")).toBe("GU");
    expect(projectMonogram("axiom")).toBe("ax");
    expect(projectMonogram("  ")).toBe("?");
  });

  it("derives a stable hue from the project id", () => {
    expect(projectMonogramHue("proj_app")).toBe(projectMonogramHue("proj_app"));
    expect(projectMonogramHue("proj_app")).not.toBe(
      projectMonogramHue("proj_web"),
    );
    expect(projectMonogramHue("proj_app")).toBeGreaterThanOrEqual(0);
    expect(projectMonogramHue("proj_app")).toBeLessThan(360);
  });
});
