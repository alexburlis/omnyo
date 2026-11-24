// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import {
  ProjectSidebarItems,
  projectSidebarClaims,
} from "./ProjectSidebarItems.js";

installTestPluginRuntime();

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("claims descendant chats only for projects whose trees render", () => {
  const claims = projectSidebarClaims(
    [
      {
        projectId: "p1",
        items: [
          {
            id: "canvas",
            label: "Canvas",
            icon: "Layout",
            href: "/",
            children: [
              {
                id: "chat",
                label: "Chat",
                icon: "MessageSquare",
                href: "/",
                threadId: "thr_claimed",
              },
            ],
          },
        ],
      },
      {
        projectId: "p2",
        items: [
          {
            id: "chat",
            label: "Other",
            icon: "Layout",
            href: "/",
            threadId: "thr_other",
          },
        ],
      },
    ],
    new Set(["p1"]),
  );

  expect([...(claims.get("p1") ?? [])]).toEqual(["thr_claimed"]);
  expect(claims.has("p2")).toBe(false);
});

it("keeps an empty project's root childless and navigable", async () => {
  await renderSlot(
    {
      component: () => (
        <SidebarRenameProvider>
          <ProjectSidebarItems projectId="p1" />
        </SidebarRenameProvider>
      ),
    },
    {},
    {
      projectSidebarItems: [
        {
          projectId: "p1",
          items: [
            {
              id: "canvas",
              label: "Canvas",
              icon: "Layout",
              href: "/plugins/canvas/p/p1",
            },
          ],
        },
      ],
    },
  );
  expect(
    screen.getByRole("link", { name: "Canvas" }).getAttribute("href"),
  ).toBe("/plugins/canvas/p/p1");
  expect(screen.queryByRole("button", { name: /Expand|Collapse/ })).toBeNull();
});

it("renames through the shared editor and persists collapsed state", async () => {
  const onRename = vi.fn(async () => {});
  await renderSlot(
    {
      component: () => (
        <SidebarRenameProvider>
          <ProjectSidebarItems projectId="p1" />
        </SidebarRenameProvider>
      ),
    },
    {},
    {
      projectSidebarItems: [
        {
          projectId: "p1",
          items: [
            {
              id: "canvas",
              label: "Canvas",
              icon: "Layout",
              href: "/",
              children: [
                {
                  id: "section",
                  label: "Revenue",
                  icon: "Layout",
                  href: "/",
                  onRename,
                },
              ],
            },
          ],
        },
      ],
    },
  );
  fireEvent.doubleClick(screen.getByRole("link", { name: "Revenue" }));
  const editor = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(editor, { target: { value: "Sales" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  await waitFor(() => expect(onRename).toHaveBeenCalledWith("Sales"));
  fireEvent.click(screen.getByRole("button", { name: "Collapse Canvas" }));
  expect(screen.queryByRole("link", { name: "Revenue" })).toBeNull();
  expect(localStorage.getItem("omnyo.sidebar.projectItems.p1/0.canvas")).toBe(
    "collapsed",
  );
});

it("reorders siblings before accepting a cross-section chat drop", async () => {
  const onReorder = vi.fn(async () => {});
  const onDrop = vi.fn(async () => {});
  renderSlot(
    {
      component: () => (
        <SidebarRenameProvider>
          <ProjectSidebarItems projectId="p1" />
        </SidebarRenameProvider>
      ),
    },
    {},
    {
      projectSidebarItems: [
        {
          key: "canvas/tree/p1",
          projectId: "p1",
          items: [
            {
              id: "canvas",
              label: "Canvas",
              icon: "Layout",
              href: "/",
              onReorder,
              children: [
                { id: "a", label: "First", icon: "Layout", href: "/", onDrop },
                {
                  id: "b",
                  label: "Second",
                  icon: "Layout",
                  href: "/",
                  children: [
                    {
                      id: "chat",
                      label: "Chat",
                      icon: "MessageSquare",
                      href: "/",
                      threadId: "thr_1",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );
  const target = screen.getByRole("link", { name: "First" }).parentElement;

  if (!target) throw new Error("Missing drop target");

  const drop = (id: string) =>
    fireEvent.drop(target, {
      dataTransfer: {
        types: ["application/x-omnyo-project-sidebar-item"],
        getData: () => JSON.stringify({ owner: "canvas/tree/p1", id }),
      },
    });

  drop("b");
  await waitFor(() => expect(onReorder).toHaveBeenCalledWith(["b", "a"]));
  expect(onDrop).not.toHaveBeenCalled();
  drop("chat");
  await waitFor(() => expect(onDrop).toHaveBeenCalledWith("chat"));
});

it("navigates the tree and expands rows with the keyboard", () => {
  renderSlot(
    {
      component: () => (
        <SidebarRenameProvider>
          <ProjectSidebarItems projectId="p1" />
        </SidebarRenameProvider>
      ),
    },
    {},
    {
      projectSidebarItems: [
        {
          projectId: "p1",
          items: [
            {
              id: "canvas",
              label: "Canvas",
              icon: "Layout",
              href: "/",
              children: [
                { id: "section", label: "Section", icon: "Layout", href: "/" },
              ],
            },
          ],
        },
      ],
    },
  );
  const canvas = screen.getByRole("link", { name: "Canvas" });
  fireEvent.keyDown(canvas, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("link", { name: "Section" }),
  );
  fireEvent.keyDown(canvas, { key: "ArrowLeft" });
  expect(screen.queryByRole("link", { name: "Section" })).toBeNull();
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  expect(screen.getByRole("link", { name: "Section" })).toBeTruthy();
});
