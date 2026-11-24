// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import type { Host } from "@omnyo/domain";
import { makeHost } from "@omnyo/test-helpers/domain-fixtures";
import type { ProviderCliKey } from "@omnyo/host-daemon-contract";
import type { SystemAppUpdateStatus } from "@omnyo/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliIssue } from "@/components/provider-cli/provider-cli-install";
import type {
  UpdateInventory,
  UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { formatScheduledTime } from "@/lib/relative-time";
import { createOmnyoDesktopApi } from "@/test/omnyo-desktop-test-utils";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";
import {
  closeAppUpdateResultDetails,
  getAppUpdateResultDetailsSnapshot,
} from "@/components/app-update/app-update-details-store";

const applyAppUpdateMock = vi.hoisted(() => vi.fn());

const { inventoryStore, runningJobKeyStore } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const listeners = new Set<() => void>();

    return {
      get: () => value,
      set: (next: T) => {
        value = next;

        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    };
  }

  return {
    inventoryStore: createStore<Partial<UpdateInventory>>({}),
    runningJobKeyStore: createStore<string | null>(null),
  };
});

vi.mock("@/hooks/useUpdateInventory", async () => {
  const { useSyncExternalStore } = await import("react");

  return {
    useUpdateInventory: () =>
      useSyncExternalStore(inventoryStore.subscribe, inventoryStore.get),
  };
});

vi.mock("@/components/provider-cli/provider-cli-install", async () => {
  const { useSyncExternalStore } = await import("react");

  return {
    useProviderCliInstallRunner: () => ({
      runningJobKey: useSyncExternalStore(
        runningJobKeyStore.subscribe,
        runningJobKeyStore.get,
      ),
    }),
  };
});

function setInventory(inventory: Partial<UpdateInventory>) {
  act(() => inventoryStore.set(inventory));
}

vi.mock("@/lib/sdk", async () => {
  const { makeProviderInfo: provider } =
    await import("@omnyo/test-helpers/domain-fixtures");

  return {
    sdk: {
      system: { applyAppUpdate: applyAppUpdateMock },
      providers: {
        list: vi.fn(async () => [
          provider({ id: "claude-code", displayName: "Claude Code" }),
          provider({ id: "codex", displayName: "Codex" }),
        ]),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

afterEach(() => {
  closeAppUpdateResultDetails();
  cleanup();
  delete window.omnyoDesktop;
  window.localStorage.clear();
  runningJobKeyStore.set(null);
  inventoryStore.set({});
  applyAppUpdateMock.mockReset();
});

function privateAppUpdate(
  overrides: Partial<SystemAppUpdateStatus> = {},
): SystemAppUpdateStatus {
  return {
    activity: { phase: "idle" },
    available: {
      channel: "private",
      commit: "b".repeat(40),
      commitCount: null,
      subjects: [],
      version: "0.46.170+private.1",
    },
    blocked: null,
    current: { commit: null, version: "0.46.169+private.1" },
    installsWhenIdle: false,
    lastResult: null,
    newTurnsPausedForUpdate: false,
    runningThreadCount: 0,
    support: { kind: "supported", mode: "private" },
    ...overrides,
  };
}

function providerIssue(
  provider: ProviderCliKey,
  displayName: string,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: `/usr/local/bin/${provider}`,
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      minimumSupportedVersion: "1.0.0",
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: "1.0.0",
      installAction: null,
      needsUpdate: true,
      versionUnsupported: false,
    },
    action: null,
    title: `${displayName} update available`,
    description: "1.0.0 -> 1.1.0",
    fingerprint: `${provider}:outdated`,
  };
}

function missingInstallIssue(
  provider: ProviderCliKey,
  displayName: string,
): ProviderCliIssue {
  return {
    provider,
    status: {
      displayName,
      executableName: provider,
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      latestVersion: "1.1.0",
      minimumSupportedVersion: null,
      npmPackageName: `@example/${provider}`,
      npmGlobalPackageVersion: null,
      installAction: null,
      needsUpdate: false,
      versionUnsupported: false,
    },
    action: null,
    title: `${displayName} CLI not installed`,
    description: `Install ${displayName} so Omnyo can start ${displayName} sessions.`,
    fingerprint: `${provider}:missing:1.1.0`,
  };
}

function host(id: string): Host {
  return makeHost({
    id,
    name: id,
  });
}

function machine(
  overrides: Partial<UpdateInventoryMachine>,
): UpdateInventoryMachine {
  return {
    host: host("host-1"),
    providerStatus: null,
    statusPending: false,
    statusFetching: false,
    statusError: false,
    issues: [],
    canRetryDaemonUpdate: false,
    ...overrides,
  };
}

function renderBadge(
  inventory: Partial<UpdateInventory>,
  { compact = false }: { compact?: boolean } = {},
) {
  setInventory({
    isLoading: false,
    systemVersion: undefined,
    desktopInfo: null,
    desktopApi: null,
    appUpdate: undefined,
    isDesktop: false,
    appUpdateAvailable: false,
    desktopUpdateReady: false,
    machines: [],
    ...inventory,
  });
  const { wrapper } = createQueryClientTestHarness();

  return render(<BadgeHarness compact={compact} />, { wrapper });
}

function BadgeHarness({ compact = false }: { compact?: boolean }) {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <SidebarUpdatesBadge compact={compact} />
      </TooltipProvider>
    </MemoryRouter>
  );
}

function borderClasses(className: string): string[] {
  return className.split(/\s+/).filter((token) => /^border(-|$)/.test(token));
}

describe("SidebarUpdatesBadge", () => {
  it("renders nothing when no update needs attention", () => {
    const result = renderBadge({});
    expect(result.container.innerHTML).toBe("");
  });

  it("shows only the Omnyo chip for an Omnyo-only update", () => {
    renderBadge({ appUpdateAvailable: true });

    expect(screen.getByTestId("sidebar-updates-badge-omnyo")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("shows the compact update button's label only in a tooltip", async () => {
    renderBadge(
      { appUpdateAvailable: true, appUpdate: privateAppUpdate() },
      { compact: true },
    );

    const chip = screen.getByRole("button", { name: "Update Omnyo now" });

    expect(borderClasses(chip.className)).toEqual([]);
    expect(within(chip).getByTestId("update-chip-dot")).toBeTruthy();
    fireEvent.pointerMove(chip, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Update Omnyo now",
    );
    expect(chip.textContent).toBe("");
    fireEvent.click(chip);
    expect(await screen.findByText(/^Update Omnyo to /)).toBeTruthy();
  });

  it("updates Omnyo from the bottom bar after one confirmation that names the chats it will pause", async () => {
    const appUpdate = privateAppUpdate({ runningThreadCount: 2 });
    applyAppUpdateMock.mockResolvedValue(
      privateAppUpdate({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-10-27T18:00:00.000Z",
          step: "Preparing runtime",
          targetVersion: "0.46.170+private.1",
        },
        runningThreadCount: 2,
      }),
    );
    renderBadge({ appUpdateAvailable: true, appUpdate });

    fireEvent.click(screen.getByRole("button", { name: "Update Omnyo now" }));

    expect(
      await screen.findByText("Update Omnyo to 0.46.170+private.1?"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "2 running chats pause now and resume automatically after Omnyo updates.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() =>
      expect(applyAppUpdateMock).toHaveBeenCalledWith({
        confirmInterruptingThreads: true,
      }),
    );
    expect(applyAppUpdateMock).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByText("Update Omnyo to 0.46.170+private.1?"),
      ).toBeNull(),
    );
  });

  it("offers update-now for an update that is waiting for idle chats", () => {
    const stopsRunningChatsAt = "2026-10-27T18:10:00.000Z";

    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({
        activity: {
          phase: "draining",
          startedAt: "2026-10-27T18:00:00.000Z",
          stopsRunningChatsAt,
          targetVersion: "0.46.170+private.1",
        },
        installsWhenIdle: true,
        runningThreadCount: 1,
      }),
    });

    const stopsAt = formatScheduledTime({
      timestamp: Date.parse(stopsRunningChatsAt),
      now: Date.now(),
    });

    expect(
      screen.getByRole("button", {
        name: `Omnyo update installs when chats are idle or at ${stopsAt}. Update now`,
      }),
    ).toBeTruthy();
  });

  it("shows the actual pause stage and links to update details", () => {
    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-10-27T18:00:00.000Z",
          step: "Stopping running chats",
          targetVersion: "0.46.170+private.1",
        },
      }),
    });

    expect(screen.getByRole("status", { name: "Pausing chats" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Pausing chats" }).textContent,
    ).toBe("Pausing chats");
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  });

  it("keeps an acknowledged failure accessible and offers a retry", () => {
    const failed = {
      acknowledged: true,
      errorCode: "runtime_update_busy",
      finishedAt: "2026-11-01T06:24:56.542Z",
      from: { commit: null, version: "0.46.169+private.1" },
      id: "failed-update",
      logTail: [],
      message: "The worker is still busy. Chats resumed.",
      outcome: "failed" as const,
      phase: "prepare" as const,
      to: { commit: null, version: "0.46.170+private.1" },
    };

    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({ lastResult: failed }),
    });

    expect(
      screen.getByRole("button", { name: "Retry Omnyo update" }).textContent,
    ).toBe("Retry update");
    fireEvent.click(
      screen.getByRole("button", { name: "Show Omnyo update failure details" }),
    );
    expect(getAppUpdateResultDetailsSnapshot()).toEqual(failed);
  });

  it.each([
    ["Preparing runtime", "Preparing update"],
    ["Waiting for worker", "Waiting for worker"],
    ["Restarting", "Waiting for worker"],
  ])("shows %s as %s before the restart starts", (step, label) => {
    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-11-01T06:20:00.000Z",
          step,
          targetVersion: "0.46.170+private.1",
        },
      }),
    });

    expect(screen.getByRole("link", { name: label })).toBeDefined();
    expect(screen.queryByText("Restarting Omnyo")).toBeNull();
  });

  it("shows Restarting Omnyo after the forced restart handoff", () => {
    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-11-01T06:20:00.000Z",
          step: "Restarting Omnyo",
          targetVersion: "0.46.170+private.1",
        },
      }),
    });

    expect(
      screen.getByRole("link", { name: "Restarting Omnyo" }),
    ).toBeDefined();
    expect(screen.queryByText("Waiting for worker")).toBeNull();
  });

  it("shows Restarting Omnyo while the launcher restarts", () => {
    renderBadge({
      appUpdateAvailable: true,
      appUpdate: privateAppUpdate({
        activity: {
          phase: "restarting",
          startedAt: "2026-11-01T06:20:00.000Z",
          targetCommit: null,
          targetVersion: "0.46.170+private.1",
        },
      }),
    });

    expect(
      screen.getByRole("link", { name: "Restarting Omnyo" }),
    ).toBeDefined();
  });

  it("shows a recovery blocker instead of an endless progress spinner", () => {
    renderBadge({
      appUpdate: privateAppUpdate({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-11-01T06:20:00.000Z",
          step: "Waiting for worker",
          targetVersion: "0.46.170+private.1",
        },
        blocked: {
          code: "app_update_handoff_uncertain",
          reason: "update-unreadable",
          message: "The update handoff needs recovery.",
        },
      }),
    });

    const blocked = screen.getByRole("link", { name: "Update blocked" });
    expect(blocked.querySelector(".animate-spin")).toBeNull();
  });

  it("relaunches into a downloaded desktop update from the sidebar", () => {
    const installUpdate = vi.fn(async () => {});
    window.omnyoDesktop = {
      ...createOmnyoDesktopApi({
        downloadState: "downloaded",
        lastCheckedAt: "2026-10-18T10:00:00.000Z",
        latestVersion: "0.46.20",
        pendingVersion: "0.46.20",
        platform: "macos",
        updateAvailable: true,
        updateDownloaded: true,
        version: "0.46.19",
      }),
      installUpdate,
    };
    renderBadge({ desktopUpdateReady: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Relaunch to update Omnyo" }),
    );

    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("sidebar-updates-badge-omnyo")).toBeNull();
  });

  it("acknowledges offline machines across reloads without suppressing real updates", () => {
    const offline = machine({
      host: makeHost({
        id: "offline",
        name: "Work laptop",
        status: "disconnected",
        lastSeenAt: 100,
        lastRejectedProtocolVersion: 1,
      }),
      canRetryDaemonUpdate: true,
    });

    renderBadge({ machines: [offline] });
    expect(screen.queryByTestId("sidebar-updates-badge-omnyo")).toBeNull();

    const warning = screen.getByRole("link", {
      name: "Work laptop is offline",
    });

    expect(warning.getAttribute("href")).toBe("/settings/machines");
    fireEvent.click(warning);
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    cleanup();

    renderBadge({ isLoading: true });
    setInventory({
      isLoading: false,
      machines: [
        {
          ...offline,
          host: { ...offline.host, lastRejectedProtocolVersion: 2 },
        },
      ],
      appUpdateAvailable: true,
    });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    expect(screen.getByTestId("sidebar-updates-badge-omnyo")).toBeTruthy();
    cleanup();

    renderBadge({
      machines: [{ ...offline, host: { ...offline.host, lastSeenAt: 200 } }],
    });
    expect(screen.getByTestId("sidebar-machines-attention-badge")).toBeTruthy();
  });

  it("shows the footer machine warning as a borderless icon button only while a machine needs attention", () => {
    renderBadge({ machines: [] }, { compact: true });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
    cleanup();

    renderBadge(
      {
        machines: [
          machine({
            host: makeHost({
              id: "offline",
              name: "Work laptop",
              status: "disconnected",
            }),
          }),
        ],
      },
      { compact: true },
    );

    const warning = screen.getByRole("link", {
      name: "Work laptop is offline",
    });

    expect(warning.className).toContain("text-warning-text");
    expect(warning.className).toContain("size-6");
    expect(borderClasses(warning.className)).toEqual([]);
  });

  it("keeps the footer update failure a labelled borderless warning", () => {
    renderBadge(
      {
        appUpdateAvailable: true,
        appUpdate: privateAppUpdate({
          lastResult: {
            acknowledged: false,
            errorCode: "runtime_update_busy",
            finishedAt: "2026-11-01T06:24:56.542Z",
            from: { commit: null, version: "0.46.169+private.1" },
            id: "failed-update",
            logTail: [],
            message: "The worker is still busy. Chats resumed.",
            outcome: "failed" as const,
            phase: "prepare" as const,
            to: { commit: null, version: "0.46.170+private.1" },
          },
        }),
      },
      { compact: true },
    );

    const failure = screen.getByRole("button", {
      name: "Show Omnyo update failure details",
    });

    expect(failure.className).toContain("text-warning-text");
    expect(borderClasses(failure.className)).toEqual([]);
  });

  it("keeps acknowledged hosts quiet when peers recover and reports new issues", () => {
    const first = machine({
      host: makeHost({ id: "first", status: "disconnected" }),
    });

    const second = machine({
      host: makeHost({ id: "second", status: "disconnected" }),
    });

    renderBadge({ machines: [first, second] });
    fireEvent.click(screen.getByRole("link", { name: "Machines offline" }));
    setInventory({ isLoading: false, machines: [first] });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();

    setInventory({
      isLoading: false,
      machines: [
        first,
        { ...second, host: { ...second.host, status: "connected" } },
      ],
    });
    setInventory({ isLoading: false, machines: [first, second] });
    expect(screen.getByRole("link", { name: "Machines offline" })).toBeTruthy();
  });

  it("does not warn about intentionally paused machines or ephemeral hosts", () => {
    const paused = makeHost({ status: "disconnected" });
    paused.lifecycle.phase = "suspended";
    renderBadge({
      machines: [
        machine({ host: paused }),
        machine({
          host: makeHost({ status: "disconnected", type: "ephemeral" }),
        }),
      ],
    });
    expect(screen.queryByTestId("sidebar-machines-attention-badge")).toBeNull();
  });

  it("shows only the provider chip when Omnyo itself is current", () => {
    renderBadge({
      machines: [
        machine({ issues: [providerIssue("claude-code", "Claude Code")] }),
      ],
    });

    expect(screen.queryByTestId("sidebar-updates-badge-omnyo")).toBeNull();
    expect(
      screen
        .getByTestId("sidebar-updates-badge-providers")
        .getAttribute("aria-label"),
    ).toBe("Claude Code update available");
  });

  it("shows loading while a provider update runs and restores the download icon when it settles", () => {
    runningJobKeyStore.set("host-1:claude-code");

    renderBadge({
      machines: [
        machine({ issues: [providerIssue("claude-code", "Claude Code")] }),
      ],
    });

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    const loadingIcon = providerChip.querySelector('[data-icon="Loading"]');
    expect(loadingIcon).toBeTruthy();
    expect(loadingIcon?.classList.contains("animate-spin")).toBe(true);
    expect(providerChip.querySelector('[data-icon="Download"]')).toBeNull();

    act(() => runningJobKeyStore.set(null));

    expect(providerChip.querySelector('[data-icon="Loading"]')).toBeNull();
    expect(providerChip.querySelector('[data-icon="Download"]')).toBeTruthy();
  });

  it("renders no provider chip when a CLI is not installed", () => {
    renderBadge({
      machines: [
        machine({
          issues: [missingInstallIssue("claude-code", "Claude Code")],
        }),
      ],
    });

    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
    expect(screen.queryByTestId("sidebar-updates-badge-omnyo")).toBeNull();
  });

  it("still shows the Omnyo chip when the only provider issue is a missing CLI", () => {
    renderBadge({
      appUpdateAvailable: true,
      machines: [
        machine({
          issues: [missingInstallIssue("codex", "Codex")],
        }),
      ],
    });

    expect(screen.getByTestId("sidebar-updates-badge-omnyo")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-updates-badge-providers")).toBeNull();
  });

  it("renders one mark per provider in a stable order when the same CLI is stale on several machines", async () => {
    renderBadge({
      appUpdateAvailable: true,
      machines: [
        machine({
          host: host("host-1"),
          issues: [providerIssue("claude-code", "Claude Code")],
        }),
        machine({
          host: host("host-2"),
          issues: [
            providerIssue("claude-code", "Claude Code"),
            providerIssue("codex", "Codex"),
          ],
        }),
      ],
    });

    const providerChip = screen.getByTestId("sidebar-updates-badge-providers");
    expect(providerChip.getAttribute("aria-label")).toBe(
      "Claude Code and Codex updates available",
    );
    await waitFor(() =>
      expect(
        providerChip.querySelectorAll(
          "[data-provider-icon] [data-provider-logo]",
        ).length,
      ).toBe(2),
    );
    expect(
      [...providerChip.querySelectorAll("[data-provider-icon]")].map((node) =>
        node.getAttribute("data-provider-icon"),
      ),
    ).toEqual(["claude-code", "codex"]);
    expect(
      [...providerChip.querySelectorAll("[data-provider-icon]")].every((node) =>
        node.classList.contains("flex"),
      ),
    ).toBe(true);
    expect(screen.getByTestId("sidebar-updates-badge-omnyo")).toBeTruthy();
  });
});
