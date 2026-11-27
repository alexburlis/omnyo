// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";

it.each(["issue", "pr"] as const)(
  "disables unauthorized %s actions and explains access",
  async (kind) => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0]!;

    const detail = {
      repo: "acme/widgets",
      number: 7,
      title: "External contribution",
      state: "OPEN",
      author: "octocat",
      body: "Description",
      labels: [],
      assignees: [],
      url: "https://github.com/acme/widgets",
      updatedAt: "2026-10-23T00:00:00Z",
      comments: [],
      checks: [],
      files: [],
      reviews: [],
      reviewThreads: [],
      reviewRequests: [],
      baseRefName: "main",
      headRefName: "fix",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      reviewDecision: "",
      mergeStateStatus: "CLEAN",
    };

    let writes = 0;

    const slot = renderSlot(
      panel,
      { subPath: `${kind === "pr" ? "pulls" : "issues"}/acme/widgets/7` },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            repos: [{ repo: "acme/widgets", projectId: null }],
            projects: [],
            warnings: [],
            notices: [],
          }),
          listItems: () => ({ items: [] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
          getIssue: () => ({ issue: detail }),
          getPull: () => ({ pull: detail }),
          itemActions: () => ({
            canClose: false,
            canReopen: false,
            canMerge: false,
            mergeMethods: [],
            headOid: "a".repeat(40),
            mergeBlockReason:
              "Your GitHub account needs write permission to merge this pull request.",
          }),
          setIssueState: () => {
            writes++;

            return { ok: true };
          },
          setPullState: () => {
            writes++;

            return { ok: true };
          },
          mergePull: () => {
            writes++;

            return { ok: true };
          },
        },
      },
    );

    try {
      await slot.findByText(
        `Your GitHub account cannot close this ${kind === "pr" ? "pull request" : "issue"}.`,
      );

      const close = slot.getByRole("button", {
        name: `Close ${kind === "pr" ? "pull request" : "issue"}`,
      });

      expect(close).toHaveProperty("disabled", true);
      fireEvent.click(close);

      if (kind === "pr") {
        const merge = slot.getByRole("button", { name: "Merge pull request" });
        expect(merge).toHaveProperty("disabled", true);
        fireEvent.click(merge);
      }

      expect(writes).toBe(0);
    } finally {
      slot.lifecycle.unmount();
    }
  },
);

it("requires confirmation, sends the reviewed head, and retains a visible merge refusal", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0]!;
  const writes: unknown[] = [];

  const slot = renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/7" },
    {
      rpc: {
        status: () => ({
          ghOk: true,
          ghState: "ready",
          repos: [{ repo: "acme/widgets", projectId: null }],
          projects: [],
          warnings: [],
          notices: [],
        }),
        listItems: () => ({ items: [] }),
        listLinks: () => ({ links: {} }),
        viewer: () => ({ login: "octocat" }),
        getPull: () => ({
          pull: {
            repo: "acme/widgets",
            number: 7,
            title: "Reviewed change",
            state: "OPEN",
            author: "octocat",
            body: "Description",
            labels: [],
            assignees: [],
            url: "https://github.com/acme/widgets",
            updatedAt: "2026-10-23T00:00:00Z",
            comments: [],
            checks: [],
            files: [],
            reviews: [],
            reviewThreads: [],
            reviewRequests: [],
            baseRefName: "main",
            headRefName: "fix",
            additions: 1,
            deletions: 0,
            changedFiles: 1,
            reviewDecision: "",
            mergeStateStatus: "CLEAN",
          },
        }),
        itemActions: () => ({
          canClose: true,
          canReopen: false,
          canMerge: true,
          mergeMethods: ["squash", "merge"],
          headOid: "a".repeat(40),
          mergeBlockReason: null,
        }),
        mergePull: (input) => {
          writes.push(input);
          throw new Error("The pull request changed. Reload it before merging.");
        },
      },
    },
  );

  try {
    const merge = await slot.findByRole("button", { name: "Merge pull request" });
    await waitFor(() => expect(merge).toHaveProperty("disabled", false));
    await act(async () => {
      fireEvent.click(merge);
    });
    expect(await slot.findByText("Commit aaaaaaa")).toBeTruthy();
    expect(writes).toEqual([]);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    });
    expect(slot.queryByRole("button", { name: "Confirm merge" })).toBeNull();
    expect(writes).toEqual([]);
    await act(async () => {
      fireEvent.click(merge);
    });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Confirm merge" }));
    });
    expect(writes).toEqual([
      { repo: "acme/widgets", number: 7, method: "squash", headOid: "a".repeat(40) },
    ]);
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "The pull request changed. Reload it before merging.",
    );
    expect(slot.queryByText("merged")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

it.each([true, false])(
  "confirms a list close in place and writes only when GitHub allows it (allowed: %s)",
  async (allowed) => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0]!;
    const writes: unknown[] = [];
    let detailLoads = 0;

    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "acme/widgets", projectId: null }],
            projects: [],
            lastSyncedAt: "2026-10-23T00:00:00Z",
            warnings: [],
            notices: [],
          }),
          listItems: () => ({
            items: [
              {
                repo: "acme/widgets",
                kind: "issue",
                number: 7,
                title: "External contribution",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: "https://github.com/acme/widgets/issues/7",
                body: "",
                updatedAt: "2026-10-23T00:00:00Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
          getIssue: () => {
            detailLoads++;
            throw new Error("The list must not open the issue");
          },
          itemActions: () => ({
            canClose: allowed,
            canReopen: false,
            canMerge: false,
            mergeMethods: [],
            headOid: null,
            mergeBlockReason: null,
          }),
          setIssueState: (input) => {
            writes.push(input);

            return { ok: true };
          },
        },
      },
    );

    try {
      const menu = await slot.findByRole("button", { name: "Actions for #7" });
      await act(async () => {
        fireEvent.keyDown(menu, { key: "Enter" });
      });
      await act(async () => {
        fireEvent.click(await slot.findByRole("menuitem", { name: "Close issue…" }));
      });

      expect(await slot.findByText("Close issue #7?")).toBeTruthy();
      expect(slot.getByText("External contribution")).toBeTruthy();
      expect(detailLoads).toBe(0);
      expect(writes).toEqual([]);

      const confirm = slot.getByRole("button", { name: "Close issue" });

      if (!allowed) {
        expect(await slot.findByText("Your GitHub account cannot close this issue.")).toBeTruthy();
        expect(confirm).toHaveProperty("disabled", true);
        fireEvent.click(confirm);
        expect(writes).toEqual([]);

        return;
      }

      await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
      await act(async () => {
        fireEvent.click(confirm);
      });
      expect(writes).toEqual([{ repo: "acme/widgets", number: 7, state: "closed" }]);
      await waitFor(() => expect(slot.queryByText("Close issue #7?")).toBeNull());
      expect(detailLoads).toBe(0);
    } finally {
      slot.lifecycle.unmount();
    }
  },
);
