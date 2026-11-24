// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  resolveLocationProject,
  SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE,
  useLocationProject,
  useSetSidebarScope,
  useSidebarScope,
  useSidebarScopeFollowsLocation,
  type SidebarScope,
} from "./sidebarScope";

const STORAGE_KEY = "omnyo.sidebar.scope";

let navigation: SidebarBootstrapResponse | undefined;

let isPlaceholderData = false;

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: navigation, isPlaceholderData }),
}));

const CATALOG = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_app",
      name: "App",
      threads: [makeThreadListEntry({ id: "thr_app", projectId: "proj_app" })],
    }),
    makeProjectWithThreadsResponse({
      id: "proj_web",
      name: "Web",
      threads: [makeThreadListEntry({ id: "thr_web", projectId: "proj_web" })],
    }),
    makeProjectWithThreadsResponse({ id: "proj_empty", name: "Empty" }),
    makeProjectWithThreadsResponse({ id: "proj game/like", name: "Encoded" }),
  ],
  personalProject: makeProjectWithThreadsResponse({
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    threads: [
      makeThreadListEntry({ id: "thr_personal", projectId: "proj_personal" }),
    ],
  }),
});

function storeScope(scope: SidebarScope) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
}

function renderScope(initialPath = "/", follow = false) {
  const store = createStore();

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      Provider,
      { store },
      createElement(MemoryRouter, { initialEntries: [initialPath] }, children),
    );
  }

  return renderHook(
    () => {
      if (follow) useSidebarScopeFollowsLocation();

      return {
        location: useLocationProject(),
        scope: useSidebarScope(),
        setScope: useSetSidebarScope(),
        navigate: useNavigate(),
      };
    },
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  localStorage.clear();
  navigation = CATALOG;
  isPlaceholderData = false;
});

afterEach(cleanup);

describe("sidebar scope", () => {
  it("defaults to the inbox", () => {
    const { result } = renderScope();

    expect(result.current.scope).toEqual({ kind: "inbox" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists the scope on this device and restores it", () => {
    const first = renderScope();

    act(() =>
      first.result.current.setScope({ kind: "project", projectId: "proj_web" }),
    );

    expect(first.result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
    first.unmount();

    expect(renderScope().result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
  });

  it.each([
    "not json",
    JSON.stringify({ kind: "project" }),
    JSON.stringify({ kind: "project", projectId: "" }),
    JSON.stringify({ kind: "inbox", projectId: "proj_web" }),
    JSON.stringify({ kind: "workspace" }),
  ])("reads the stored value %s as the inbox", (stored) => {
    localStorage.setItem(STORAGE_KEY, stored);

    expect(renderScope().result.current.scope).toEqual({ kind: "inbox" });
  });

  it("keeps a stored project while the catalog loads, then falls back to the inbox when it is gone", () => {
    storeScope({ kind: "project", projectId: "proj_deleted" });
    navigation = undefined;
    const { result, rerender } = renderScope();

    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_deleted",
    });

    navigation = CATALOG;
    isPlaceholderData = true;
    rerender();
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_deleted",
    });

    isPlaceholderData = false;
    rerender();
    expect(result.current.scope).toEqual({ kind: "inbox" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      kind: "project",
      projectId: "proj_deleted",
    });
  });

  it.each(["proj_empty", "proj_personal"])(
    "keeps the catalog project %s, including Personal and empty projects",
    (projectId) => {
      storeScope({ kind: "project", projectId });

      expect(renderScope().result.current.scope).toEqual({
        kind: "project",
        projectId,
      });
    },
  );
});

const CANVAS_WEB = "/plugins/canvas/p/proj_web/v/view_board";

const CANVAS_APP = "/plugins/canvas/p/proj_app/v/view_board";

describe("resolving the project a location shows", () => {
  it.each([
    {
      name: "a chat, from the catalog",
      pathname: "/projects/proj_app/threads/thr_app",
      route: { threadId: "thr_app", projectId: "proj_app" },
      expected: { key: "thread:thr_app", projectId: "proj_app" },
    },
    {
      name: "a chat moved to another project",
      pathname: "/projects/proj_app/threads/thr_web",
      route: { threadId: "thr_web", projectId: "proj_app" },
      expected: { key: "thread:thr_web", projectId: "proj_web" },
    },
    {
      name: "a chat the catalog has not listed yet",
      pathname: "/projects/proj_empty/threads/thr_new",
      route: { threadId: "thr_new", projectId: "proj_empty" },
      expected: { key: "thread:thr_new", projectId: "proj_empty" },
    },
    {
      name: "a project route",
      pathname: "/projects/proj_web/archived",
      route: { threadId: undefined, projectId: "proj_web" },
      expected: { key: "project:proj_web", projectId: "proj_web" },
    },
    {
      name: "a Canvas page of a catalog project",
      pathname: CANVAS_WEB,
      route: { threadId: undefined, projectId: undefined },
      expected: { key: "panel:canvas/p/proj_web", projectId: "proj_web" },
    },
    {
      name: "a plugin page whose first segment is an encoded project id",
      pathname: "/plugins/canvas/p/proj%20game%2Flike/v/view_board",
      route: { threadId: undefined, projectId: undefined },
      expected: {
        key: "panel:canvas/p/proj game/like",
        projectId: "proj game/like",
      },
    },
    {
      name: "a plugin page whose first segment is not a project",
      pathname: "/plugins/canvas/p/proj_unknown/v/view_board",
      route: { threadId: undefined, projectId: undefined },
      expected: null,
    },
    {
      name: "a plugin page with a malformed first segment",
      pathname: "/plugins/canvas/p/%E0%A4%A/v/view_board",
      route: { threadId: undefined, projectId: undefined },
      expected: null,
    },
    {
      name: "a plugin page without a sub-path",
      pathname: "/plugins/canvas/p",
      route: { threadId: undefined, projectId: undefined },
      expected: null,
    },
    {
      name: "a project route outside the catalog",
      pathname: "/projects/proj_hidden/archived",
      route: { threadId: undefined, projectId: "proj_hidden" },
      expected: null,
    },
    {
      name: "the root",
      pathname: "/",
      route: { threadId: undefined, projectId: undefined },
      expected: null,
    },
    {
      name: "the projectless archive",
      pathname: "/archived",
      route: { threadId: undefined, projectId: "proj_personal" },
      expected: null,
    },
  ])("resolves $name", ({ pathname, route, expected }) => {
    expect(
      resolveLocationProject({ pathname, route, catalog: CATALOG }),
    ).toEqual(expected);
  });

  it("resolves nothing until the catalog has loaded", () => {
    expect(
      resolveLocationProject({
        pathname: CANVAS_WEB,
        route: { threadId: undefined, projectId: undefined },
        catalog: undefined,
      }),
    ).toBeNull();
    expect(
      resolveLocationProject({
        pathname: "/projects/proj_app/threads/thr_app",
        route: { threadId: "thr_app", projectId: "proj_app" },
        catalog: undefined,
      }),
    ).toBeNull();
  });

  it("reads the current location and ignores placeholder catalogs", () => {
    isPlaceholderData = true;
    const { result, rerender } = renderScope(CANVAS_WEB);

    expect(result.current.location).toBeNull();

    isPlaceholderData = false;
    rerender();
    expect(result.current.location).toEqual({
      key: "panel:canvas/p/proj_web",
      projectId: "proj_web",
    });
  });
});

describe("following the location", () => {
  it("moves a project scope to the project of a Canvas page", () => {
    storeScope({ kind: "project", projectId: "proj_app" });
    const { result } = renderScope("/projects/proj_app/threads/thr_app", true);

    act(() => {
      void result.current.navigate(CANVAS_WEB);
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });

    act(() => {
      void result.current.navigate("/projects/proj_empty/archived");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_empty",
    });
  });

  it("never changes an inbox scope on a Canvas page", () => {
    const { result } = renderScope(CANVAS_WEB, true);

    act(() => {
      void result.current.navigate(CANVAS_APP);
    });

    expect(result.current.location?.projectId).toBe("proj_app");
    expect(result.current.scope).toEqual({ kind: "inbox" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("leaves a tile choice alone on the same Canvas page until another location opens", () => {
    storeScope({ kind: "project", projectId: "proj_app" });
    const { result } = renderScope(CANVAS_WEB, true);

    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });

    act(() =>
      result.current.setScope({ kind: "project", projectId: "proj_empty" }),
    );
    act(() => {
      void result.current.navigate("/");
    });
    act(() => {
      void result.current.navigate("/plugins/canvas/p/proj_web/v/view_other");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_empty",
    });

    act(() => {
      void result.current.navigate(CANVAS_APP);
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_app",
    });
  });

  it("keeps a tile choice when the rail returns to the last chat from a Canvas page, but not when history does", () => {
    storeScope({ kind: "project", projectId: "proj_web" });
    const { result } = renderScope("/projects/proj_web/threads/thr_web", true);

    act(() => {
      void result.current.navigate(CANVAS_APP);
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_app",
    });

    act(() => {
      result.current.setScope({ kind: "project", projectId: "proj_empty" });
      void result.current.navigate("/projects/proj_web/threads/thr_web", {
        state: SIDEBAR_SCOPE_KEEPING_NAVIGATION_STATE,
      });
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_empty",
    });

    act(() => {
      void result.current.navigate("/projects/proj_app/threads/thr_app");
    });
    act(() => {
      void result.current.navigate(-1);
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
  });
});

describe("following the active chat", () => {
  it("moves a project scope to the project of a chat opened elsewhere", () => {
    storeScope({ kind: "project", projectId: "proj_app" });
    const { result } = renderScope("/projects/proj_app/threads/thr_app", true);

    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_app",
    });

    act(() => {
      void result.current.navigate("/projects/proj_web/threads/thr_web");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });

    act(() => {
      void result.current.navigate("/threads/thr_personal");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_personal",
    });
  });

  it("never changes an inbox scope", () => {
    const { result } = renderScope("/projects/proj_app/threads/thr_app", true);

    act(() => {
      void result.current.navigate("/projects/proj_web/threads/thr_web");
    });

    expect(result.current.scope).toEqual({ kind: "inbox" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("leaves the user's choice alone until another chat opens", () => {
    storeScope({ kind: "project", projectId: "proj_app" });
    const { result } = renderScope("/projects/proj_web/threads/thr_web", true);

    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });

    act(() =>
      result.current.setScope({ kind: "project", projectId: "proj_empty" }),
    );
    act(() => {
      void result.current.navigate("/settings");
    });
    act(() => {
      void result.current.navigate("/projects/proj_web/threads/thr_web");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_empty",
    });

    act(() => {
      void result.current.navigate("/projects/proj_app/threads/thr_app");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_app",
    });
  });

  it("waits for the catalog and ignores projects outside it", () => {
    storeScope({ kind: "project", projectId: "proj_app" });
    navigation = undefined;

    const { result, rerender } = renderScope(
      "/projects/proj_web/threads/thr_web",
      true,
    );

    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_app",
    });

    navigation = CATALOG;
    rerender();
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });

    act(() => {
      void result.current.navigate("/projects/proj_hidden/threads/thr_hidden");
    });
    expect(result.current.scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
  });
});
