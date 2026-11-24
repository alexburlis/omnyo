// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { ScopedProjectTitle } from "./ScopedProject";
import { sidebarScopeAtom, type SidebarScope } from "./sidebarScope";

const navigation: SidebarBootstrapResponse = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_app",
      name: "omnyo-private",
      threads: [
        makeThreadListEntry({
          id: "thr_root",
          projectId: "proj_app",
          parentThreadId: null,
        }),
      ],
    }),
  ],
});

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: navigation, isPlaceholderData: false }),
}));

function renderScoped(scope: SidebarScope) {
  const store = createStore();
  store.set(sidebarScopeAtom, scope);

  return render(
    <Provider store={store}>
      <MemoryRouter>
        <ScopedProjectTitle />
      </MemoryRouter>
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("scoped project title", () => {
  it("shows the scoped project's name", () => {
    renderScoped({ kind: "project", projectId: "proj_app" });

    expect(screen.getByTestId("window-title-project").textContent).toBe(
      "omnyo-private",
    );
  });

  it("renders nothing for the Inbox or an unknown project", () => {
    renderScoped({ kind: "inbox" });
    expect(screen.queryByTestId("window-title-project")).toBeNull();
    cleanup();

    renderScoped({ kind: "project", projectId: "proj_missing" });
    expect(screen.queryByTestId("window-title-project")).toBeNull();
  });
});
