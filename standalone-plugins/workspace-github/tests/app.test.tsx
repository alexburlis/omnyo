// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";

type FixtureItem = {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  state: string;
  author?: string;
  labels?: string[];
  updatedAt?: string;
  pullMerge?: string;
  pullReview?: string;
  checks?: "success" | "failure" | "pending";
};

function item(fixture: FixtureItem) {
  return {
    author: "octocat",
    labels: [],
    assignees: [],
    url: `https://github.com/${fixture.repo}/${fixture.kind === "pr" ? "pull" : "issues"}/${fixture.number}`,
    body: "",
    updatedAt: "2026-11-20T00:00:00Z",
    ...fixture,
  };
}

const status = {
  ghOk: true,
  ghState: "ready",
  ghError: null,
  repos: [
    { repo: "acme/widgets", projectId: "widgets" },
    { repo: "acme/tools", projectId: "tools" },
  ],
  projects: [
    { id: "widgets", name: "Widgets" },
    { id: "tools", name: "Tools" },
  ],
  lastSyncedAt: "2026-11-23T00:00:00Z",
  warnings: [],
  notices: [],
};

const items = [
  item({
    repo: "acme/widgets",
    number: 1,
    kind: "pr",
    title: "Update tailwind",
    state: "OPEN",
    pullReview: "open",
    pullMerge: "CLEAN",
    checks: "success",
    updatedAt: "2026-11-22T00:00:00Z",
  }),
  item({
    repo: "acme/tools",
    number: 2,
    kind: "pr",
    title: "Bump next [SECURITY]",
    state: "OPEN",
    labels: ["dependency-security"],
    pullReview: "open",
    pullMerge: "CLEAN",
    checks: "success",
    updatedAt: "2026-11-01T00:00:00Z",
  }),
  item({
    repo: "acme/widgets",
    number: 3,
    kind: "pr",
    title: "Update nextjs",
    state: "OPEN",
    pullReview: "open",
    pullMerge: "BLOCKED",
    checks: "failure",
  }),
  item({
    repo: "acme/widgets",
    number: 4,
    kind: "pr",
    title: "Prototype refactor",
    state: "OPEN",
    pullReview: "draft",
  }),
  item({
    repo: "acme/tools",
    number: 5,
    kind: "pr",
    title: "Bump undici",
    state: "OPEN",
    author: "app/dependabot",
    pullReview: "open",
    pullMerge: "UNKNOWN",
  }),
  item({ repo: "acme/tools", number: 6, kind: "issue", title: "Fix crash", state: "OPEN" }),
  item({ repo: "acme/widgets", number: 7, kind: "pr", title: "Old merge", state: "MERGED" }),
  item({ repo: "acme/widgets", number: 8, kind: "issue", title: "Old issue", state: "CLOSED" }),
];

const pullDetail = {
  repo: "acme/widgets",
  number: 3,
  title: "Update nextjs",
  state: "OPEN",
  author: "octocat",
  body: "Release notes",
  url: "https://github.com/acme/widgets/pull/3",
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  baseRefName: "main",
  headRefName: "renovate/nextjs-monorepo",
  additions: 106,
  deletions: 106,
  changedFiles: 5,
  labels: [],
  assignees: [],
  reviewDecision: "",
  mergeStateStatus: "BLOCKED",
  reviewRequests: [],
  checks: [
    { name: "renovate/stability-days", status: "success", url: "" },
    { name: "renovate/artifacts", status: "failure", url: "" },
  ],
  comments: [],
  reviews: [],
  reviewThreads: [],
  files: [],
};

const actions = {
  canClose: true,
  canReopen: false,
  canMerge: false,
  mergeMethods: [],
  headOid: "a".repeat(40),
  mergeBlockReason: "Required checks are failing.",
};

type RpcHandlers = NonNullable<NonNullable<Parameters<typeof renderSlot>[2]>["rpc"]>;

function rpc(overrides: RpcHandlers = {}): RpcHandlers {
  return {
    status: () => status,
    listItems: (input) => {
      expect(input).toEqual({ includeBody: false });

      return { items: items.map((entry) => ({ ...entry })) };
    },
    listLinks: () => ({ links: {} }),
    viewer: () => ({ login: "octocat" }),
    getPull: () => ({ pull: pullDetail }),
    itemActions: () => actions,
    ...overrides,
  };
}

function groupToggle(slot: ReturnType<typeof renderSlot>, label: RegExp) {
  return slot.getByRole("button", { name: label, expanded: true });
}

it("lists issues and pull requests in one attention-ordered view and keeps history separate", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pulls" }, { rpc: rpc() });

  try {
    await slot.findByText("Update tailwind");
    const list = slot.getByRole("region", { name: "Launchpad · 6 items" });

    const titles = within(list)
      .getAllByRole("button")
      .flatMap((button) => (button.dataset.rowKey === undefined ? [] : [button.dataset.rowKey]));

    expect(titles).toEqual([
      "pr:acme/tools#2",
      "pr:acme/widgets#1",
      "pr:acme/widgets#3",
      "pr:acme/tools#5",
      "pr:acme/widgets#4",
      "issue:acme/tools#6",
    ]);
    expect(groupToggle(slot, /Ready to merge\s*2/u)).toBeTruthy();
    expect(groupToggle(slot, /Blocked\s*1/u)).toBeTruthy();
    expect(groupToggle(slot, /Open issues\s*1/u)).toBeTruthy();
    expect(slot.getAllByText("Checks failing").length).toBeGreaterThan(0);
    expect(slot.getByText("security")).toBeTruthy();
    expect(slot.queryByText("Old merge")).toBeNull();
    expect(slot.getByRole("button", { name: "Review acme/widgets#1 with agent" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Work on acme/tools#6 with agent" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Merge #1…" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Merge #3…" })).toBeNull();

    const views = slot.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("button", { name: /Launchpad\s*6/u })).toBeTruthy();
    expect(within(views).getByRole("button", { name: /Recently closed\s*2/u })).toBeTruthy();
    expect(within(views).queryByRole("button", { name: /Ready to merge/u })).toBeNull();
    expect(within(views).queryByRole("button", { name: /Blocked/u })).toBeNull();
    const types = slot.getByRole("group", { name: "Item type" });
    expect(within(types).getByRole("button", { name: /^PRs\s*5$/u })).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(types).getByRole("button", { name: /^Issues\s*1$/u }));
    });
    expect(slot.queryByText("Update tailwind")).toBeNull();
    expect(slot.getByText("Fix crash")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(types).getByRole("button", { name: /^All\s*\d+$/u }));
    });
    await act(async () => {
      fireEvent.click(within(views).getByRole("button", { name: /Recently closed\s*2/u }));
    });
    expect(slot.getByText("Old merge")).toBeTruthy();
    expect(slot.getByText("Old issue")).toBeTruthy();
    expect(slot.queryByText("Update tailwind")).toBeNull();
    expect(slot.queryByRole("button", { name: "Review acme/widgets#7 with agent" })).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("scopes by repository and filter text, remembers the scope and offers a reset", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  const Panel = app.navPanels[0]!.component;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });

  try {
    await slot.findByText("Update tailwind");
    const repos = slot.getByRole("region", { name: "Repositories" });
    const tools = within(repos).getByRole("button", { name: /tools\s*3/u });

    await act(async () => {
      fireEvent.click(tools);
    });
    expect(tools.getAttribute("aria-pressed")).toBe("true");
    expect(slot.queryByText("Update tailwind")).toBeNull();
    expect(slot.getByText("Bump undici")).toBeTruthy();

    await act(async () => {
      fireEvent.change(slot.getByRole("combobox", { name: "Filter work" }), {
        target: { value: "nothing-matches" },
      });
    });
    expect(slot.getByText("Nothing matches")).toBeTruthy();

    await act(async () => {
      fireEvent.change(slot.getByRole("combobox", { name: "Filter work" }), {
        target: { value: "" },
      });
    });
    await act(async () => {
      slot.lifecycle.rerender(<Panel key="remount" subPath="" />);
    });
    expect(await slot.findByText("Bump undici")).toBeTruthy();
    expect(slot.queryByText("Update tailwind")).toBeNull();

    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Clear repository scope" }));
    });
    expect(await slot.findByText("Update tailwind")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("inspects a selected item beside the list, steps with j and closes with Escape", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  const Panel = app.navPanels[0]!.component;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });

  try {
    const row = await slot.findByRole("button", { name: /Update nextjs/u });

    await act(async () => {
      fireEvent.click(row);
    });
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      options: { subPath: "pulls/acme/widgets/3", replace: false },
    });

    await act(async () => {
      slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/3" />);
    });
    const inspector = slot.getByRole("region", { name: "Inspector" });
    expect(await within(inspector).findByRole("heading", { name: "Update nextjs" })).toBeTruthy();
    expect(within(inspector).getByText("Blocked — 1 of 2 checks failing")).toBeTruthy();
    expect(within(inspector).getByText("renovate/artifacts")).toBeTruthy();
    expect(within(inspector).getByText("renovate/nextjs-monorepo")).toBeTruthy();
    expect(slot.getByText("Update tailwind")).toBeTruthy();

    const selected = slot.getByRole("button", { name: /Update nextjs/u, current: true });
    await act(async () => {
      fireEvent.keyDown(selected, { key: "j" });
    });
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
      options: { subPath: "pulls/acme/tools/5", replace: true },
    });

    await act(async () => {
      fireEvent.keyDown(selected, { key: "Escape" });
    });
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "" } });
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("says honestly that only issues you created are cached when none are open", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: rpc({
        listItems: () => ({ items: items.filter((entry) => entry.kind === "pr") }),
      }),
    },
  );

  try {
    await slot.findByText("Update tailwind");
    await act(async () => {
      fireEvent.click(
        within(slot.getByRole("group", { name: "Item type" })).getByRole("button", {
          name: /^Issues\s*0$/u,
        }),
      );
    });
    expect(slot.getByText("No open issues you created")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("shows retained PR details immediately on reopen while a new read is still pending", async () => {
  const app = await loadPluginApp(() => import("../app"));

  const pull = {
    ...pullDetail,
    repo: "acme/cache",
    number: 77,
    title: "Retained PR details",
    mergeStateStatus: "CLEAN",
    checks: [],
  };

  let calls = 0;
  let fail = false;
  let finish: (value: { pull: typeof pull }) => void = () => {};

  const held = new Promise<{ pull: typeof pull }>((resolve) => {
    finish = resolve;
  });

  const handlers = rpc({
    listItems: () => ({ items: [] }),
    getPull: () => {
      calls++;

      if (fail) throw new Error("Offline");

      return calls === 1 ? Promise.resolve({ pull }) : held;
    },
    counts: () => ({ issues: 0, prs: 0, lastSyncedAt: null, stale: false }),
  });

  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const subPath = "pulls/acme/cache/77";
  let current = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers });

  try {
    await current.findByRole("heading", { name: /Retained PR details/u });
    current.lifecycle.unmount();
    current = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers });
    expect(current.getByRole("heading", { name: /Retained PR details/u })).toBeDefined();
    await act(async () => {});
    expect(calls).toBe(1);
    current.lifecycle.unmount();
    now += 30_001;
    current = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers });
    expect(current.getByRole("heading", { name: /Retained PR details/u })).toBeDefined();
    await act(async () => {});
    expect(calls).toBe(2);
    await act(async () => finish({ pull: { ...pull, title: "Revalidated PR details" } }));
    expect(current.getByRole("heading", { name: /Revalidated PR details/u })).toBeDefined();
    current.lifecycle.unmount();
    const overlay = app.appOverlays[0];

    if (!overlay) throw new Error("Missing global count owner");
    const owner = renderSlot(overlay, {}, { rpc: handlers });

    try {
      await owner.emitRealtime("data-changed", {});
      current = renderSlot(app.navPanels[0]!, { subPath }, { rpc: handlers });
      expect(current.getByRole("heading", { name: /Revalidated PR details/u })).toBeDefined();
      await act(async () => {});
      expect(calls).toBe(3);
    } finally {
      owner.lifecycle.unmount();
    }

    fail = true;
    await current.emitRealtime("data-changed", {});
    const inspector = current.getByRole("region", { name: "Inspector" });
    expect(within(inspector).getByRole("alert").textContent).toContain("Offline");
    expect(current.getByRole("heading", { name: /Revalidated PR details/u })).toBeDefined();
  } finally {
    current.lifecycle.unmount();
    clock.mockRestore();
  }
}, 30_000);

it("batches equivalent sync problems, remembers dismissal, and reopens for changed failures", async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0]!;

  const missing = "Could not inspect /Volumes/Backup/acme: ENOENT: scandir";
  const failed = "Sync failed for acme/widgets; any displayed rows are from the previous sync.";
  let warnings = [missing, failed, missing];

  const handlers = rpc({
    status: () => ({
      ...status,
      warnings: [...warnings],
      notices: ["Build PC is offline. Showing its repositories found on 23 Nov."],
    }),
    listItems: () => ({ items: [] }),
  });

  let slot = renderSlot(panel, { subPath: "" }, { rpc: handlers });

  try {
    await act(async () => {
      await slot.behavior.emitRealtime("data-changed", {});
    });
    const summary = await slot.findByRole("button", { name: /Sync issues \(3\)/u });
    expect(await slot.findByText("Nothing here in the cache")).toBeTruthy();
    expect(slot.queryByText("You’re all caught up")).toBeNull();
    await act(async () => {
      fireEvent.click(summary);
    });
    expect(slot.getByRole("region", { name: "Missing folders" })).toBeTruthy();
    expect(slot.getAllByText("/Volumes/Backup/acme")).toHaveLength(1);
    expect(slot.queryByText(/ENOENT/u)).toBeNull();

    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Dismiss GitHub sync notice" }));
    });
    expect(slot.queryByRole("region", { name: "Missing folders" })).toBeNull();
    expect(document.activeElement).toBe(slot.getByRole("button", { name: /Sync issues \(3\)/u }));

    slot.lifecycle.unmount();
    warnings = [failed, missing];
    slot = renderSlot(panel, { subPath: "" }, { rpc: handlers });
    await slot.findByRole("button", { name: /^Sync issues \(3\)$/u });
    expect(slot.queryByRole("button", { name: "Dismiss GitHub sync notice" })).toBeNull();

    warnings.push("Sync failed for acme/docs; any displayed rows are from the previous sync.");
    await act(async () => {
      await slot.behavior.emitRealtime("data-changed", {});
    });
    expect(await slot.findByRole("button", { name: "Dismiss GitHub sync notice" })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Sync issues \(4\)/u })).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
    window.sessionStorage.clear();
  }
}, 30_000);

it("keeps menu keys out of list navigation and explains when the type filter hides a view", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: rpc({ listItems: () => ({ items: items.filter((entry) => entry.kind === "issue") }) }) },
  );

  try {
    const menu = await slot.findByRole("button", { name: "Actions for #6" });
    const before = slot.inspection.navigateCalls.length;

    await act(async () => {
      fireEvent.keyDown(menu, { key: "Enter" });
    });
    const item = await slot.findByRole("menuitem", { name: "Copy link" });

    await act(async () => {
      fireEvent.keyDown(item, { key: "ArrowDown" });
      fireEvent.keyDown(item, { key: "j" });
    });
    expect(slot.inspection.navigateCalls.length).toBe(before);
    await act(async () => {
      fireEvent.keyDown(item, { key: "Escape" });
    });

    const types = slot.getByRole("group", { name: "Item type" });

    await act(async () => {
      fireEvent.click(within(types).getByRole("button", { name: /^PRs\s*\d+$/u }));
    });
    expect(slot.getByText("No pull requests in Launchpad")).toBeTruthy();
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Show all types" }));
    });
    expect(slot.getByText("Fix crash")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("saves the current filter as a view, shows coverage with Sync now and opens the shortcut sheet", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  let refreshes = 0;

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: rpc({
        refresh: () => {
          refreshes += 1;

          return { repos: 2, items: 8 };
        },
      }),
    },
  );

  try {
    await slot.findByText("Update tailwind");
    const filter = slot.getByRole("combobox", { name: "Filter work" });

    await act(async () => {
      fireEvent.change(filter, { target: { value: "tailwind" } });
    });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Save this view" }));
    });
    await act(async () => {
      fireEvent.change(slot.getByRole("textbox", { name: "Saved view name" }), {
        target: { value: "Tailwind" },
      });
    });
    await act(async () => {
      fireEvent.submit(slot.getByRole("textbox", { name: "Saved view name" }));
    });

    const views = slot.getByRole("navigation", { name: "Views" });
    const saved = within(views).getByRole("button", { name: /^Tailwind\s*1$/u });

    expect(saved.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.change(filter, { target: { value: "" } });
    });
    expect(saved.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(saved);
    });
    expect(slot.getByRole("combobox", { name: "Filter work" })).toHaveProperty("value", "tailwind");
    expect(slot.queryByText("Fix crash")).toBeNull();
    await act(async () => {
      fireEvent.click(within(views).getByRole("button", { name: /^Launchpad\s*\d+$/u }));
    });
    expect(slot.getByRole("combobox", { name: "Filter work" })).toHaveProperty("value", "");
    expect(slot.getByText("Fix crash")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(slot.getByRole("button", { name: "Recent cache" }), { key: "Enter" });
    });
    expect(
      await slot.findByText(/up to 50 open and 30 recently closed pull requests/u),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(await slot.findByRole("menuitem", { name: "Sync now" }));
    });
    expect(refreshes).toBe(1);

    await act(async () => {
      fireEvent.keyDown(slot.getByTestId("github-workbench"), { key: "?" });
    });
    expect(await slot.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("merges the ready group in one confirmed batch and skips pull requests GitHub refuses", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  const merges: unknown[] = [];

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: rpc({
        itemActions: (input) =>
          JSON.stringify(input).includes('"number":1')
            ? {
                canClose: true,
                canReopen: false,
                canMerge: true,
                mergeMethods: ["merge", "squash"],
                headOid: "b".repeat(40),
                mergeBlockReason: null,
              }
            : {
                canClose: true,
                canReopen: false,
                canMerge: false,
                mergeMethods: ["squash"],
                headOid: "c".repeat(40),
                mergeBlockReason: "Required review is missing.",
              },
        mergePull: (input) => {
          merges.push(input);

          return { ok: true };
        },
      }),
    },
  );

  try {
    await slot.findByText("Update tailwind");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Merge all 2…" }));
    });
    const dialog = await slot.findByRole("dialog", { name: "Merge ready pull requests" });

    expect(await within(dialog).findByText("Required review is missing.")).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "Merge acme/tools#2" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByRole("checkbox", { name: "Merge acme/widgets#1" })).toHaveProperty(
      "checked",
      true,
    );
    expect(merges).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Merge 1 pull request" }));
    });
    expect(merges).toEqual([
      { repo: "acme/widgets", number: 1, method: "squash", headOid: "b".repeat(40) },
    ]);
    expect(await within(dialog).findByText("Merged")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);

it("rechecks the head commit each time the merge dialog opens", async () => {
  window.localStorage.clear();
  const app = await loadPluginApp(() => import("../app"));
  let checks = 0;

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "pulls/acme/widgets/3" },
    {
      rpc: rpc({
        itemActions: () => {
          checks += 1;

          return {
            canClose: true,
            canReopen: false,
            canMerge: true,
            mergeMethods: ["squash"],
            headOid: (checks === 1 ? "a" : "e").repeat(40),
            mergeBlockReason: null,
          };
        },
      }),
    },
  );

  try {
    const merge = await slot.findByRole("button", { name: "Merge pull request" });

    await vi.waitFor(() => expect(merge).toHaveProperty("disabled", false));
    await act(async () => {
      fireEvent.click(merge);
    });
    const dialog = await slot.findByRole("dialog", { name: "Merge pull request #3?" });

    expect(within(dialog).getByText("Commit eeeeeee")).toBeTruthy();
    expect(within(dialog).getByText(/1 of 2 checks failing/u)).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
}, 30_000);
