// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PluginContext, usePluginId } from "@/components/plugin/plugin-context";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import {
  ProjectSidebarItemsCollectors,
  useProjectSidebarItems,
} from "./plugin-project-sidebar-items";

vi.mock("./plugin-sidebar-hooks", () => ({
  useSidebarThreads: () => ({
    projects: [
      {
        id: "p1",
        name: "First",
        isPersonal: false,
        href: "/",
        settingsHref: "/",
      },
      {
        id: "p2",
        name: "Empty",
        isPersonal: true,
        href: "/",
        settingsHref: "/",
      },
    ],
  }),
}));

vi.mock("@/components/plugin/PluginSlotMount", () => ({
  PluginSlotMount: ({
    pluginId,
    children,
  }: {
    pluginId: string;
    children: ReactNode;
  }) => (
    <PluginContext.Provider value={pluginId}>{children}</PluginContext.Provider>
  ),
}));

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
});

function Rows() {
  const groups = useProjectSidebarItems();

  return (
    <output>
      {groups
        .map(
          (group) =>
            `${group.key}:${group.items.map((item) => item.label).join(",")}`,
        )
        .join("|")}
    </output>
  );
}

it("collects every project under the contributor identity and releases unloaded claims", () => {
  const owners: string[] = [];
  setPluginSlotRegistrations(
    "canvas",
    makePluginRegistrationSet({
      projectSidebarItems: [
        {
          id: "tree",
          useItems: ({ projects }) => {
            owners.push(usePluginId());

            return projects.map((project) => ({
              projectId: project.id,
              items: [
                {
                  id: "canvas",
                  label: project.name,
                  icon: "Layout",
                  href: "/plugins/canvas",
                  children:
                    project.id === "p1"
                      ? [
                          {
                            id: "chat",
                            label: "Chat",
                            icon: "MessageSquare",
                            href: "/",
                            threadId: "thr_1",
                          },
                        ]
                      : [],
                },
              ],
            }));
          },
        },
      ],
    }),
  );
  render(
    <>
      <ProjectSidebarItemsCollectors />
      <Rows />
    </>,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "canvas/tree/p1:First|canvas/tree/p2:Empty",
  );
  expect(owners).toEqual(["canvas"]);
  act(() => removePluginSlotRegistrations("canvas"));
  expect(screen.getByRole("status").textContent).toBe("");
});
