// @vitest-environment jsdom

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import type {
  PluginSidebarThreadsState,
  PluginThreadListProps,
} from "@omnyo/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  makeSidebarWork,
  sdkResult,
  type SidebarThreadOverrides,
} from "./model/fixtures.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./preferences/preferences-sync.js";
import { defaultPreferences } from "../shared/preferences.js";

let sidebarState: PluginSidebarThreadsState | null = null;

const sidebarListeners = new Set<() => void>();

function subscribeToSidebar(listener: () => void) {
  sidebarListeners.add(listener);

  return () => sidebarListeners.delete(listener);
}

function sidebarSnapshot() {
  if (sidebarState === null) throw new Error("Sidebar snapshot missing");

  return sidebarState;
}

function useSidebarSnapshot() {
  return useSyncExternalStore(subscribeToSidebar, sidebarSnapshot);
}

vi.mock("@omnyo/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnyo/plugin-sdk/app")>();

  return {
    ...actual,
    experimental_useSidebarThreads: useSidebarSnapshot,
  };
});

const app = await loadPluginApp(() => import("../app.js"));

const registration = app.threadLists[0];

if (!registration) throw new Error("thread-list slot not registered");

type Work = ReturnType<typeof makeSidebarWork>;

function workflowWork(count: number): Work {
  const work = makeSidebarWork(count === 0 ? "ready-to-archive" : "working");

  return {
    ...work,
    primary: {
      ...work.primary,
      reason: {
        code: count === 0 ? "settled" : "workflow-running",
        text:
          count === 0 ? "All runs settled." : `Workflow runs active: ${count}.`,
      },
    },
    activity: Array.from({ length: count }, (_, index) => ({
      id: `workflow-${index + 1}`,
      kind: "workflow",
      label: `Workflow ${index + 1}`,
      phase: index === 0 ? "running" : "queued",
      actor: { kind: "agent", id: null, label: "Workflow" },
    })),
  };
}

function mountServerWork(
  work: Work | null,
  {
    threadOverrides = {},
    hasComposerDraft = false,
  }: {
    threadOverrides?: SidebarThreadOverrides;
    hasComposerDraft?: boolean;
  } = {},
) {
  const props: PluginThreadListProps = {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: vi.fn(),
    searchQuery: "",
  };

  const thread = makeSidebarThread({
    ...threadOverrides,
    id: "thr_origin",
    title: "Workflow origin",
    isUnread: false,
    lastReadAt: 1,
    experimental_work: work,
  });

  sidebarState = {
    status: "ready",
    projects: [makePluginProject()],
    threads: [thread],
    sections: [],
    experimental_hosts: [],
    experimental_archived: null,
    experimental_shelved: null,
  };

  const read = vi.fn();
  setPreferencesMirrorStorageForTest(null);

  renderSlot(registration, props, {
    sidebarThreads: sidebarState,
    sidebarDraftThreadIds: hasComposerDraft ? ["thr_origin"] : [],
    rpc: {
      listPreferences: () => ({
        preferences: {
          ...defaultPreferences(),
          organizationMode: "chronological",
        },
      }),
    },
    sdk: {
      plugins: {
        list: sdkResult({ plugins: [{ id: "workflows", enabled: true }] }),
        callRpc: async (args) => {
          read(args);
          throw new Error("Thread list must not poll workflow activity");
        },
      },
    },
  });

  return {
    read,
    async setWork(next: Work | null) {
      await act(async () => {
        sidebarState = {
          ...sidebarSnapshot(),
          threads: [{ ...thread, experimental_work: next }],
        };

        for (const listener of sidebarListeners) listener();
      });
    },
  };
}

function glyph() {
  const row = screen
    .getByRole("link", { name: /^Open Workflow origin(?: \(|$)/ })
    .closest("[data-sidebar-rename-row]");

  if (!row) throw new Error("Workflow origin row was not rendered");

  return row.querySelector("[data-thread-status-glyph]");
}

async function expectWork(indicator: string, reason?: string) {
  await waitFor(() => {
    expect(glyph()?.getAttribute("data-thread-status-glyph")).toBe(indicator);
    expect(glyph()?.hasAttribute("data-row-status")).toBe(false);

    if (reason !== undefined) {
      expect(
        glyph()
          ?.closest("[data-sidebar-thread-trailing-indicator]")
          ?.getAttribute("data-status-reason"),
      ).toBe(reason);
    }
  });
}

afterEach(() => {
  cleanup();
  sidebarState = null;
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  vi.restoreAllMocks();
});

describe("Thread list server-owned workflow activity", () => {
  it("keeps queued and running workflows Working until the server reports every run settled", async () => {
    const host = mountServerWork(workflowWork(2));
    await screen.findByText("Workflow origin");
    await expectWork("runtime", "Workflow runs active: 2.");
    await host.setWork(workflowWork(1));
    await expectWork("runtime", "Workflow runs active: 1.");
    await host.setWork(workflowWork(0));
    await expectWork("ready-to-archive", "All runs settled.");
    expect(host.read).not.toHaveBeenCalled();
  });

  it.each(["checking", "failed", "stale"] as const)(
    "uses the server Open state while its completion assessment is %s",
    async (availability) => {
      const work = makeSidebarWork("open");

      const host = mountServerWork({
        ...work,
        assessment: {
          ...work.assessment,
          availability,
          suggestion: "unavailable",
        },
      });

      await screen.findByText("Workflow origin");
      await expectWork("open", work.primary.reason.text);
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "background agent", kind: "agent" },
    { name: "background command", kind: "command" },
    { name: "goal", kind: "plugin" },
    { name: "plan", kind: "plugin" },
  ] as const)(
    "keeps server-reported $name work visible with zero legacy counts",
    async ({ name, kind }) => {
      const work = makeSidebarWork("working");
      const reason = `${name} is still running.`;

      const host = mountServerWork({
        ...work,
        primary: {
          ...work.primary,
          reason: { code: "active-work", text: reason },
        },
        activity: [
          {
            id: name,
            kind,
            label: name,
            phase: "running",
            actor: { kind: "agent", id: null, label: "Agent" },
          },
        ],
      });

      await screen.findByText("Workflow origin");
      await expectWork("runtime", reason);
      await host.setWork(workflowWork(0));
      await expectWork("ready-to-archive");
      expect(host.read).not.toHaveBeenCalled();
    },
  );

  it("keeps required input primary while independent workflow activity continues", async () => {
    const work = makeSidebarWork("needs-you");
    mountServerWork({ ...work, activity: workflowWork(1).activity });
    await screen.findByText("Workflow origin");
    await expectWork("waiting-for-input", work.primary.reason.text);
  });

  it("decorates server Working with a local draft without making the draft count as work", async () => {
    const host = mountServerWork(workflowWork(1), { hasComposerDraft: true });
    await screen.findByText("Workflow origin");
    await expectWork("working-draft");
    await host.setWork(workflowWork(0));
    await expectWork("draft");
  });

  it("withdraws Ready after the server basis changes and restores it only after a fresh assessment", async () => {
    const ready = { ...workflowWork(0), revision: "before", basis: "before" };
    const host = mountServerWork(ready);
    await screen.findByText("Workflow origin");
    await expectWork("ready-to-archive");
    const open = makeSidebarWork("open");
    await host.setWork({
      ...open,
      revision: "changed",
      basis: "changed",
      assessment: {
        ...ready.assessment,
        availability: "stale",
        suggestion: "unavailable",
      },
    });
    await expectWork("open");
    await host.setWork({ ...ready, revision: "reassessed", basis: "changed" });
    await expectWork("ready-to-archive");
    expect(host.read).not.toHaveBeenCalled();
  });

  it("does not infer new work from legacy counts after the server reports Ready", async () => {
    const host = mountServerWork(workflowWork(0), {
      threadOverrides: {
        status: "active",
        runtimeStatus: "active",
        activity: { workflows: 3, goals: 1, planMode: 1 },
      },
    });

    await screen.findByText("Workflow origin");
    await expectWork("ready-to-archive");
    expect(host.read).not.toHaveBeenCalled();
  });

  it("keeps a legacy host's missing work summary Open instead of inferring Ready or Working", async () => {
    const host = mountServerWork(null, {
      threadOverrides: {
        status: "active",
        runtimeStatus: "active",
        activity: { workflows: 1 },
      },
    });

    await screen.findByText("Workflow origin");
    await expectWork("open");
    expect(host.read).not.toHaveBeenCalled();
  });
});
