// @vitest-environment jsdom
import { cleanup, act, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createStore, Provider } from "jotai";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  withDisabledWorkflowsSdk,
} from "../model/fixtures.js";
import { preferencesReadyAtom } from "../preferences/preferences-sync.js";
import {
  sidebarOrganizationModeAtom,
  sidebarShowEmptyProjectsAtom,
} from "../preferences/atoms.js";
import { ProjectList } from "./ProjectList.js";

installTestPluginRuntime();

afterEach(cleanup);

it.each([
  { pinnedAt: 1, showEmpty: true, showsTree: true, hasContent: true },
  { pinnedAt: 1, showEmpty: false, showsTree: true, hasContent: true },
  { pinnedAt: null, showEmpty: false, showsTree: true, hasContent: true },
  { pinnedAt: 1, showEmpty: false, showsTree: false, hasContent: false },
])(
  "keeps chat claims reachable with pinnedAt=$pinnedAt and showEmpty=$showEmpty",
  async ({ pinnedAt, showEmpty, showsTree, hasContent }) => {
    const store = createStore();
    store.set(preferencesReadyAtom(), true);
    store.set(sidebarOrganizationModeAtom, "project");
    store.set(sidebarShowEmptyProjectsAtom, showEmpty);
    const project = makePluginProject();
    renderSlot(
      {
        component: () => (
          <TooltipProvider>
            <Provider store={store}>
              <ProjectList activeThreadId={null} scopeProjectId={null} />
            </Provider>
          </TooltipProvider>
        ),
      },
      {},
      {
        sidebarThreads: {
          projects: [project],
          threads: [
            makeSidebarThread({
              id: "thr_claimed",
              projectId: project.id,
              title: "Pinned canvas chat",
              titleFallback: "Pinned canvas chat",
              pinnedAt,
            }),
          ],
        },
        projectSidebarItems: [
          {
            projectId: project.id,
            items: [
              {
                id: "canvas",
                label: "Canvas",
                icon: "Layout",
                href: "/plugins/canvas",
                children: hasContent
                  ? [
                      {
                        id: "chat",
                        label: "Canvas card",
                        icon: "MessageSquare",
                        href: "/plugins/canvas/c/thr_claimed",
                        threadId: "thr_claimed",
                      },
                    ]
                  : [],
              },
            ],
          },
        ],
        sdk: withDisabledWorkflowsSdk({}),
      },
    );

    if (showsTree) {
      expect(
        await screen.findByRole("link", { name: "Canvas card" }),
      ).toBeTruthy();
      expect(screen.queryByText("Pinned canvas chat")).toBeNull();
    } else {
      expect(screen.queryByRole("link", { name: "Canvas card" })).toBeNull();
      expect(await screen.findByText("Pinned canvas chat")).toBeTruthy();
    }

    act(() => store.set(sidebarOrganizationModeAtom, "chronological"));
    expect(await screen.findByText("Pinned canvas chat")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Canvas card" })).toBeNull();
    act(() => store.set(sidebarOrganizationModeAtom, "machine"));
    expect(await screen.findByText("Pinned canvas chat")).toBeTruthy();
  },
);
