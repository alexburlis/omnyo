// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import type { PluginRpcResult } from "@omnyo/plugin-sdk/app";
import type { githubRpcContract } from "../server.js";

type Counts = PluginRpcResult<(typeof githubRpcContract)["counts"]>;

type PendingCounts = { resolve: ((value: Counts) => void) | null };

it("shows cached open counts in the registered navigation icon and marks unknown, stale and failed refreshes", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels[0];
  const overlay = app.appOverlays[0];
  const icon = app.icons.find((entry) => entry.name === panel?.icon);

  if (overlay === undefined || icon === undefined)
    throw new Error("Missing global GitHub count owner or registered navigation icon");

  let result: Counts = {
    issues: 0,
    prs: 0,
    lastSyncedAt: null,
    stale: true,
  };

  let failure = false;
  let calls = 0;

  const owner = renderSlot(
    overlay,
    {},
    {
      rpc: {
        counts: () => {
          calls += 1;

          if (failure) throw new Error("Network unavailable");

          return { ...result };
        },
      },
    },
  );

  const Icon = icon.component;
  let clicks = 0;

  const glyph = render(
    <button
      onClick={() => {
        clicks += 1;
      }}
    >
      <span aria-hidden="true">
        <Icon className="size-4" />
      </span>
    </button>,
  );

  try {
    expect(
      await glyph.findByTitle("GitHub counts unavailable until the first sync"),
    ).toHaveProperty("textContent", "—");

    result = { issues: 0, prs: 0, lastSyncedAt: "2026-10-11T10:00:00Z", stale: false };
    await act(async () => {
      await owner.behavior.emitRealtime("data-changed", {});
    });
    expect(await glyph.findByTitle("0 open pull requests · 0 open issues")).toHaveProperty(
      "textContent",
      "0",
    );

    result = { ...result, issues: 4, prs: 2 };
    await act(async () => {
      await owner.behavior.emitRealtime("data-changed", {});
    });
    expect(await glyph.findByTitle("2 open pull requests · 4 open issues")).toHaveProperty(
      "textContent",
      "6",
    );

    expect(owner.getByRole("status")).toHaveProperty(
      "textContent",
      "2 open pull requests · 4 open issues",
    );
    fireEvent.pointerMove(glyph.getByTitle("2 open pull requests · 4 open issues"), {
      pointerType: "mouse",
    });
    expect(await glyph.findByRole("tooltip")).toHaveProperty(
      "textContent",
      "2 open pull requests · 4 open issues",
    );
    fireEvent.pointerLeave(glyph.getByTitle("2 open pull requests · 4 open issues"));
    fireEvent.click(glyph.getByTitle("2 open pull requests · 4 open issues"));
    expect(clicks).toBe(1);

    result = { ...result, issues: 123, prs: 45, stale: true };
    await act(async () => {
      await owner.behavior.emitRealtime("data-changed", {});
    });
    expect(
      await glyph.findByTitle("45 open pull requests · 123 open issues · may be out of date"),
    ).toHaveProperty("textContent", "99+");
    expect(glyph.container.querySelector("[data-stale='true']")?.textContent).toBe("99+");

    failure = true;
    await act(async () => {
      await owner.behavior.emitRealtime("data-changed", {});
    });
    expect(
      await glyph.findByTitle("GitHub counts unavailable; open GitHub to check sync status"),
    ).toHaveProperty("textContent", "—");

    failure = false;
    result = { ...result, issues: 1, prs: 1, stale: false };
    const beforeReconnect = calls;
    await act(async () => {
      await owner.behavior.setRealtimeConnectionState("reconnecting");
    });
    await act(async () => {
      await owner.behavior.setRealtimeConnectionState("connected");
    });
    expect(calls).toBe(beforeReconnect + 1);
    expect(await glyph.findByTitle("1 open pull requests · 1 open issues")).toHaveProperty(
      "textContent",
      "2",
    );
  } finally {
    glyph.unmount();
    owner.lifecycle.unmount();
  }
});

it.each(["connected", "reconnecting"] as const)(
  "keeps delayed counts stale while realtime is reconnecting after initial %s state",
  async (initialConnection) => {
    const app = await loadPluginApp(() => import("../app"));
    const overlay = app.appOverlays[0];
    const icon = app.icons.find((entry) => entry.name === app.navPanels[0]?.icon);

    if (overlay === undefined || icon === undefined) throw new Error("Missing navigation counts");
    const result = { issues: 3, prs: 1, lastSyncedAt: "2026-10-11T10:00:00Z", stale: false };
    const pending: PendingCounts = { resolve: null };

    const owner = renderSlot(
      overlay,
      {},
      {
        realtimeConnectionState: initialConnection,
        rpc: {
          counts: () =>
            new Promise<Counts>((resolve) => {
              pending.resolve = resolve;
            }),
        },
      },
    );

    const Icon = icon.component;
    const glyph = render(<Icon className="size-4" />);

    try {
      await waitFor(() => expect(pending.resolve).not.toBeNull());
      await act(async () => {
        await owner.behavior.setRealtimeConnectionState("reconnecting");
        pending.resolve?.(result);
      });
      expect(
        await glyph.findByTitle("1 open pull requests · 3 open issues · may be out of date"),
      ).toHaveProperty("textContent", "4");
      expect(glyph.container.querySelector("[data-stale='true']")?.textContent).toBe("4");
    } finally {
      glyph.unmount();
      owner.lifecycle.unmount();
    }
  },
);
