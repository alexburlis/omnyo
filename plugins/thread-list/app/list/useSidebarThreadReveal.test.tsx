// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import {
  collapsedEnvironmentIdsAtom,
  collapsedSidebarSectionIdsAtom,
  sidebarCollapsedThreadSectionsAtom,
  sidebarOrganizationModeAtom,
} from "../preferences/atoms.js";
import { preferenceValueAtom } from "../preferences/preferences-sync.js";
import {
  useSidebarThreadRevealCore,
  type SidebarThreadRevealInputs,
} from "./useSidebarThreadReveal.js";

afterEach(cleanup);

function thread(id: string, overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    id,
    projectId: "proj_personal",
    sectionId: id,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  });
}

function setup(
  threads: SidebarThread[],
  initial: Partial<SidebarThreadRevealInputs> = {},
) {
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, "chronological");
  store.set(sidebarCollapsedThreadSectionsAtom, [
    "chronological::first",
    "chronological::second",
    "chronological::third",
  ]);

  function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }

  const hook = renderHook<void, SidebarThreadRevealInputs>(
    (inputs) => useSidebarThreadRevealCore(inputs),
    {
      wrapper: Wrapper,
      initialProps: {
        selectedThreadId: "first",
        threads,
        threadsReady: true,
        preferencesReady: true,
        personalProjectId: "proj_personal",
        ...initial,
      },
    },
  );

  const current: SidebarThreadRevealInputs = {
    selectedThreadId: "first",
    threads,
    threadsReady: true,
    preferencesReady: true,
    personalProjectId: "proj_personal",
    ...initial,
  };

  const update = (next: Partial<SidebarThreadRevealInputs>) => {
    Object.assign(current, next);
    hook.rerender({ ...current });
  };

  return { ...hook, store, update };
}

describe("useSidebarThreadReveal", () => {
  it("requires leaving and returning before revealing a manually collapsed open thread", () => {
    const { store, update } = setup([thread("first"), thread("second")]);
    act(() =>
      store.set(sidebarCollapsedThreadSectionsAtom, ["chronological::first"]),
    );

    update({
      threads: [
        thread("first", { title: "Updated", latestAttentionAt: 2 }),
        thread("second"),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::first",
    ]);

    update({ selectedThreadId: undefined });
    update({ selectedThreadId: "first" });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([]);
  });

  it("does not reveal a background thread when it arrives or becomes unread", () => {
    const { store, update } = setup([thread("first")]);
    act(() =>
      store.set(sidebarCollapsedThreadSectionsAtom, [
        "chronological::background",
      ]),
    );

    update({
      threads: [
        thread("first"),
        thread("background", { latestAttentionAt: 2 }),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::background",
    ]);

    update({ threads: [thread("first"), thread("background")] });
    update({
      threads: [
        thread("first"),
        thread("background", { latestAttentionAt: 3 }),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::background",
    ]);

    update({ selectedThreadId: "background" });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([]);
  });

  it("keeps initially unread threads collapsed and ignores hidden unread threads", () => {
    const { store, update } = setup([
      thread("first"),
      thread("second", { latestAttentionAt: 2 }),
    ]);

    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);
    update({
      threads: [
        thread("first"),
        thread("second", { latestAttentionAt: 2 }),
        thread("third", { latestAttentionAt: 2, isHidden: true }),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);
  });

  it("waits for the threads to be ready before revealing navigation", () => {
    const { store, update } = setup([thread("first")], {
      threadsReady: false,
    });

    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );

    update({
      threadsReady: true,
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);

    update({ threads: [thread("first"), thread("second")] });
    update({
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);
  });

  it("reveals the pinned ancestors and environment when navigating to a child", () => {
    const parent = thread("parent", {
      pinnedAt: 1,
      environment: makeSidebarEnvironment({ id: "env_parent" }),
    });

    const child = thread("child", {
      parentThreadId: "parent",
      environment: makeSidebarEnvironment({ id: "env_child" }),
    });

    const { store, update } = setup([thread("first"), parent, child]);
    act(() => {
      store.set(collapsedSidebarSectionIdsAtom, ["pinned"]);
      store.set(collapsedEnvironmentIdsAtom, ["env_parent", "env_child"]);
    });
    update({ selectedThreadId: "child" });
    expect(store.get(collapsedSidebarSectionIdsAtom)).toEqual([]);
    expect(store.get(collapsedEnvironmentIdsAtom)).toEqual([]);
    expect(store.get(preferenceValueAtom("collapsedSections"))).toEqual([
      "pinned",
    ]);
    expect(store.get(preferenceValueAtom("collapsedEnvironments"))).toEqual([
      "env_parent",
      "env_child",
    ]);
  });

  it("waits for preferences and the destination thread before revealing navigation", () => {
    const { store, update } = setup([], { preferencesReady: false });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );
    update({ preferencesReady: true });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );
    update({ threads: [thread("first")] });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).not.toContain(
      "chronological::first",
    );
  });
});
