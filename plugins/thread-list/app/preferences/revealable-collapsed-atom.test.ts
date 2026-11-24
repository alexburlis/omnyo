// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { collapsedProjectIdsAtom, revealProjectIdsAtom } from "./atoms.js";
import {
  preferenceValueAtom,
  resetPreferencesSyncForTest,
} from "./preferences-sync.js";

afterEach(resetPreferencesSyncForTest);

function storeWithCollapsedProjects(ids: string[]) {
  const store = createStore();
  store.set(preferenceValueAtom("collapsedProjects"), ids);

  return store;
}

function toggle(ids: string[], id: string): string[] {
  return ids.includes(id)
    ? ids.filter((current) => current !== id)
    : [...ids, id];
}

describe("revealable collapsed atoms", () => {
  it("shows a revealed row expanded without changing the persisted list", () => {
    const store = storeWithCollapsedProjects(["parent", "other"]);

    store.set(revealProjectIdsAtom, new Set(["parent"]));

    expect(store.get(collapsedProjectIdsAtom)).toEqual(["other"]);
    expect(store.get(preferenceValueAtom("collapsedProjects"))).toEqual([
      "parent",
      "other",
    ]);
  });

  it("collapses a revealed row when the user toggles it", () => {
    const store = storeWithCollapsedProjects(["parent"]);
    store.set(revealProjectIdsAtom, new Set(["parent"]));

    store.set(collapsedProjectIdsAtom, (current) => toggle(current, "parent"));

    expect(store.get(collapsedProjectIdsAtom)).toEqual(["parent"]);
    expect(store.get(preferenceValueAtom("collapsedProjects"))).toEqual([
      "parent",
    ]);
  });

  it("keeps a revealed row's persisted collapse when the user expands another row", () => {
    const store = storeWithCollapsedProjects(["parent", "other"]);
    store.set(revealProjectIdsAtom, new Set(["parent"]));

    store.set(collapsedProjectIdsAtom, (current) => toggle(current, "other"));

    expect(store.get(collapsedProjectIdsAtom)).toEqual([]);
    expect(store.get(preferenceValueAtom("collapsedProjects"))).toEqual([
      "parent",
    ]);
  });
});
