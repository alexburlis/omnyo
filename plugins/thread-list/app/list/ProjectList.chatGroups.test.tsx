// @vitest-environment jsdom

import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  experimental_useThreadGroupActions,
  type PluginSidebarThread,
} from "@omnyo/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  withDisabledWorkflowsSdk,
} from "../model/fixtures.js";
import {
  preferencesReadyAtom,
  preferenceValueAtom,
  resetPreferencesSyncForTest,
} from "../preferences/preferences-sync.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";

installTestPluginRuntime();

const { ProjectList } = await import("./ProjectList.js");

const { resetSidebarDataCacheForTest } =
  await import("../model/use-sidebar-data.js");

afterEach(() => {
  cleanup();
  resetSidebarDataCacheForTest();
  resetPreferencesSyncForTest();
});

const GROUP = {
  id: "grp_importer",
  projectId: "proj_test",
  name: "Importer work",
  createdAt: 1,
  updatedAt: 1,
};

function GroupSelectionButton() {
  const actions = experimental_useThreadGroupActions();

  return (
    <button type="button" onClick={() => void actions.group(["thr_loose"])}>
      Host group
    </button>
  );
}

function Harness({
  children,
  store,
}: {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <TooltipProvider>
      <Provider store={store}>
        {children}
        <GroupSelectionButton />
      </Provider>
    </TooltipProvider>
  );
}

function defaultThreads(): PluginSidebarThread[] {
  return [
    makeSidebarThread({
      id: "thr_loose",
      title: "Release notes",
      latestAttentionAt: 50,
      createdAt: 50,
    }),
    makeSidebarThread({
      id: "thr_member_new",
      title: "Importer parser",
      latestAttentionAt: 40,
      createdAt: 40,
      experimental_groupId: GROUP.id,
    }),
    makeSidebarThread({
      id: "thr_member_old",
      title: "Importer fixtures",
      latestAttentionAt: 20,
      createdAt: 20,
      experimental_groupId: GROUP.id,
    }),
    makeSidebarThread({
      id: "thr_child",
      title: "Fixture follow-up",
      parentThreadId: "thr_member_old",
      latestAttentionAt: 30,
      createdAt: 30,
      experimental_groupId: GROUP.id,
    }),
  ];
}

function renderGroupedList(
  options: {
    threads?: PluginSidebarThread[];
    collapsedGroups?: string[];
  } = {},
) {
  const store = createStore();
  store.set(preferencesReadyAtom(), true);
  store.set(sidebarOrganizationModeAtom, "project");
  store.set(
    preferenceValueAtom("collapsedGroups"),
    options.collapsedGroups ?? [],
  );

  const slot = renderSlot(
    { component: Harness },
    {
      children: <ProjectList activeThreadId={null} scopeProjectId={null} />,
      store,
    },
    {
      sidebarThreads: {
        threads: options.threads ?? defaultThreads(),
        projects: [makePluginProject()],
        sections: [],
        experimental_groups: [GROUP],
      },
      sdk: withDisabledWorkflowsSdk({}),
    },
  );

  return { slot, store };
}

function folderRow(): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-sidebar-chat-group-id="${GROUP.id}"]`,
  );

  if (row === null) throw new Error("No chat group folder row");

  return row;
}

function threadRow(title: string): HTMLElement {
  const link = screen.getByRole("link", { name: new RegExp(`^Open ${title}`) });
  const row = link.closest<HTMLElement>("[data-sidebar-rename-row]");

  if (row === null) throw new Error(`No row for ${title}`);

  return row;
}

function linkOrder(): (string | null)[] {
  return screen
    .getAllByRole("link", { name: /^Open / })
    .map((link) => link.getAttribute("aria-label"));
}

describe("chat group folders in project mode", () => {
  it("renders one folder with its members nested and keeps sub-chats under their parent", async () => {
    renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    const folder = folderRow();

    expect(within(folder).getByText("Importer work")).toBeTruthy();
    expect(within(folder).getByLabelText("2 chats").textContent).toBe("2");
    expect(folder.hasAttribute("data-sidebar-thread-id")).toBe(false);
    expect(folder.hasAttribute("data-sidebar-selectable-thread")).toBe(false);
    expect(folder.querySelector("[data-sidebar-thread-id]")).toBeNull();

    expect(linkOrder()).toEqual([
      "Open Release notes",
      "Open Importer parser",
      "Open Importer fixtures",
      "Open Fixture follow-up",
    ]);

    const loosePadding = Number.parseFloat(
      threadRow("Release notes").style.paddingLeft,
    );

    const memberPadding = Number.parseFloat(
      threadRow("Importer parser").style.paddingLeft,
    );

    const childPadding = Number.parseFloat(
      threadRow("Fixture follow-up").style.paddingLeft,
    );

    expect(Number.parseFloat(folder.style.paddingLeft)).toBe(loosePadding);
    expect(memberPadding).toBeGreaterThan(loosePadding);
    expect(childPadding).toBeGreaterThan(memberPadding);
  });

  it("collapses on click and stores the group id in collapsedGroups", async () => {
    const { store } = renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    fireEvent.click(folderRow());

    expect(
      screen.queryByRole("link", { name: "Open Importer parser" }),
    ).toBeNull();
    expect(store.get(preferenceValueAtom("collapsedGroups"))).toEqual([
      GROUP.id,
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Importer work group" }),
    );

    expect(
      screen.getByRole("link", { name: "Open Importer parser" }),
    ).toBeTruthy();
    expect(store.get(preferenceValueAtom("collapsedGroups"))).toEqual([]);
  });

  it("starts collapsed from the stored preference", async () => {
    renderGroupedList({ collapsedGroups: [GROUP.id] });
    await screen.findByRole("link", { name: "Open Release notes" });

    expect(folderRow()).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open Importer fixtures" }),
    ).toBeNull();
  });

  it("renames inline through the group actions", async () => {
    const { slot } = renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    fireEvent.doubleClick(within(folderRow()).getByText("Importer work"));

    const input = await screen.findByRole("textbox", { name: "Group name" });

    fireEvent.change(input, { target: { value: "Importer v2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(slot.experimental_threadGroupActionCalls).toEqual([
        { action: "rename", groupId: GROUP.id, name: "Importer v2" },
      ]),
    );
  });

  it("ungroups from the folder's context menu", async () => {
    const { slot } = renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    fireEvent.contextMenu(folderRow());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ungroup" }));

    await waitFor(() =>
      expect(slot.experimental_threadGroupActionCalls).toEqual([
        { action: "ungroup", groupId: GROUP.id },
      ]),
    );
  });

  it("renders nothing for a group whose members are all elsewhere", async () => {
    renderGroupedList({
      threads: [
        makeSidebarThread({ id: "thr_loose", title: "Release notes" }),
        makeSidebarThread({
          id: "thr_pinned",
          title: "Pinned importer",
          pinnedAt: 5,
          experimental_groupId: GROUP.id,
        }),
      ],
    });
    await screen.findByRole("link", { name: "Open Pinned importer" });

    expect(
      document.querySelector(`[data-sidebar-chat-group-id="${GROUP.id}"]`),
    ).toBeNull();
  });
});

describe("chat selection hand-off", () => {
  it("publishes the selection in display order and clears it when the host does", async () => {
    const { slot } = renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    fireEvent.click(
      screen.getByRole("link", { name: "Open Importer parser" }),
      {
        metaKey: true,
      },
    );
    fireEvent.click(screen.getByRole("link", { name: "Open Release notes" }), {
      metaKey: true,
    });

    expect(slot.experimental_chatSelectionWrites).toEqual([
      ["thr_member_new"],
      ["thr_loose", "thr_member_new"],
    ]);
    expect(
      screen.getByRole("link", { name: "Open Release notes, selected" }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Host group" }));
    });

    expect(
      screen.getByRole("link", { name: "Open Release notes" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /, selected$/ })).toBeNull();
    expect(slot.experimental_chatSelectionWrites.at(-1)).toEqual([]);
  });

  it("publishes an empty selection when the list unmounts", async () => {
    const { slot } = renderGroupedList();
    await screen.findByRole("link", { name: "Open Importer parser" });

    fireEvent.click(
      screen.getByRole("link", { name: "Open Importer parser" }),
      {
        metaKey: true,
      },
    );
    cleanup();

    expect(slot.experimental_chatSelectionWrites).toEqual([
      ["thr_member_new"],
      [],
    ]);
  });
});
