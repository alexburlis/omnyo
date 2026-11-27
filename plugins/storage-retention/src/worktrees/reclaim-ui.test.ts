// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { WorktreesSection } from "./app.js";
import { scanInventory } from "./contract.js";

afterEach(cleanup);

function fixture() {
  const inventory = scanInventory.parse({
    entries: [
      {
        projectId: "project",
        projectName: "Remote project",
        path: "/remote/repo",
        error: null,
        repo: {
          path: "/remote/repo",
          base: "main",
          branches: [],
          worktrees: ["/remote/repo", "/remote/idle"].map((path) => ({
            path,
            head: "abc",
            branch: "topic",
            locked: false,
            missing: false,
            bare: false,
            error: null,
            dirty: path === "/remote/idle",
            dirtyFiles: [],
            ignored: false,
            ahead: 0,
            behind: 0,
            storage: {
              status: "measured",
              allocatedBytes: 8192,
              reclaimableBytes: 8192,
              measuredAt: "2026-11-27T00:00:00Z",
              error: null,
            },
            purgeReady: true,
            preserveIn: "main",
            reasons: [],
          })),
        },
      },
    ],
    issues: [],
    scannedAt: "2026-11-27T00:00:00Z",
  });

  const reclaimSpace = vi.fn(async () => ({
    status: "completed",
    sharedFiles: 2,
    privateBytesReleased: 4096,
    volumeFreeBytesChange: -12288,
    skippedFiles: 1,
    skippedWorktrees: [],
  }));

  const hostInventory = vi.fn(() => inventory);
  const files = vi.fn(() => []);

  const slot = renderSlot(
    {
      component: () =>
        createElement(WorktreesSection, {
          hostId: "remote",
          machineName: "Remote Mac",
          isCoordinator: false,
          onSummaryChange: () => {},
        }),
    },
    {},
    { rpc: { hostInventory, reclaimSpace, files } },
  );

  return { slot, reclaimSpace, hostInventory, files };
}

it("selects remote worktrees for reclaim without exposing coordinator removal actions", async () => {
  const f = fixture();
  const page = within(f.slot.container);
  fireEvent.click(await page.findByText("Remote project"));

  const primary = await page.findByRole("checkbox", {
    name: "Select worktree /remote/repo",
  });

  expect(primary.hasAttribute("disabled")).toBe(true);

  const linked = page.getByRole("checkbox", {
    name: "Select worktree /remote/idle",
  });

  fireEvent.click(linked);
  expect(page.queryByRole("button", { name: "Remove folder…" })).toBeNull();
  expect(page.queryByRole("button", { name: /Review cleanup/ })).toBeNull();
  fireEvent.click(page.getByRole("button", { name: "Reclaim space (1)" }));
  await waitFor(() =>
    expect(f.reclaimSpace).toHaveBeenCalledWith({
      hostId: "remote",
      worktrees: [
        { projectId: "project", repo: "/remote/repo", path: "/remote/idle" },
      ],
    }),
  );
  expect(
    await page.findByText(
      /Space reclaim completed.*2 files shared.*4.1 KB of private data released/,
    ),
  ).toBeTruthy();
  expect(
    page.getByText(/Observed volume free-space change: −12.3 KB/).textContent,
  ).toContain("Other activity and snapshots");
  expect(f.hostInventory).toHaveBeenCalledWith({ hostId: "remote" });
  expect(linked.hasAttribute("checked")).toBe(false);
});

it("routes remote file inspection to the selected host", async () => {
  const f = fixture();
  const page = within(f.slot.container);
  fireEvent.click(await page.findByText("Remote project"));
  fireEvent.click(page.getByTitle("View changes in /remote/idle"));
  await waitFor(() =>
    expect(f.files).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "remote",
        repo: "/remote/repo",
        target: "/remote/idle",
      }),
    ),
  );
});

it("shows the setting-off result while offering cancellation during reclaim", async () => {
  const f = fixture();
  const page = within(f.slot.container);

  let finish: (
    result: Awaited<ReturnType<typeof f.reclaimSpace>>,
  ) => void = () => {};

  f.reclaimSpace.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(await page.findByText("Remote project"));
  fireEvent.click(
    page.getByRole("checkbox", { name: "Select worktree /remote/idle" }),
  );
  fireEvent.click(page.getByRole("button", { name: "Reclaim space (1)" }));
  expect(
    await page.findByRole("button", { name: "Cancel reclaim" }),
  ).toBeTruthy();
  finish({
    status: "disabled",
    sharedFiles: 0,
    privateBytesReleased: 0,
    volumeFreeBytesChange: 0,
    skippedFiles: 0,
    skippedWorktrees: [],
  });
  expect(await page.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Enable Share disk space between worktrees"),
  );
});
