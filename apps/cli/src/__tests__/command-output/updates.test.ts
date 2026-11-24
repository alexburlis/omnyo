import { describe, expect, it, vi } from "vitest";
import type { Host } from "@omnyo/domain";
import type {
  HostProviderCliStatusResponse,
  SystemAppUpdateStatus,
} from "@omnyo/server-contract";
import {
  collectLogPayloads,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerUpdatesCommands } from "../../commands/updates.js";

const hosts: Host[] = [
  {
    id: "host-primary",
    name: "workstation",
    type: "persistent",
    status: "connected",
    machineProviderId: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: "full",
    availability: "available",
    lastSeenAt: 1_700_000_000_000,
    lastRejectedProtocolVersion: null,
    runtimeVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "host-remote",
    name: "laptop",
    type: "persistent",
    status: "disconnected",
    machineProviderId: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: "full",
    availability: "available",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    runtimeVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
];

const version = {
  currentVersion: "0.0.32",
  latestVersion: "0.0.33",
  currentCommit: null,
  installKind: "npm" as const,
  source: "npm" as const,
  updateAvailable: true,
  isDevelopment: false,
  upgradeCommand: "npx omnyo-app@latest",
};

function providerStatus(args: {
  codexNeedsUpdate: boolean;
}): HostProviderCliStatusResponse {
  const base = {
    executablePath: "/usr/local/bin/cli",
    installed: true,
    installSource: "npmGlobal" as const,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    versionUnsupported: false,
  };

  return {
    codex: {
      ...base,
      displayName: "Codex",
      executableName: "codex",
      currentVersion: "0.140.0",
      latestVersion: args.codexNeedsUpdate ? "0.141.0" : "0.140.0",
      needsUpdate: args.codexNeedsUpdate,
      installAction: args.codexNeedsUpdate
        ? {
            kind: "update" as const,
            label: "Update" as const,
            command: "codex update",
          }
        : null,
    },
    "claude-code": {
      ...base,
      displayName: "Claude Code",
      executableName: "claude",
      currentVersion: "2.0.14",
      latestVersion: "2.0.14",
      needsUpdate: false,
      installAction: null,
    },
    "acp-cursor": {
      ...base,
      displayName: "Cursor",
      executableName: "agent",
      currentVersion: null,
      latestVersion: null,
      installed: false,
      needsUpdate: false,
      installAction: null,
    },
  };
}

describe("omnyo updates command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerUpdatesCommands(program, () => "http://server");

  it("reports a failed startup update even when the installed version is current", async () => {
    const statuses = providerStatus({ codexNeedsUpdate: false });
    const failure = "Automatic CLI update failed. Check the installed version.";
    statuses.codex = { ...statuses.codex!, startupUpdateError: failure };
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => [hosts[0]]),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => statuses),
    });

    await runCommand(["updates", "status"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain(failure);
  });

  it("omnyo updates renders omnyo-app and per-machine provider rows", async () => {
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
    });

    await runCommand(["updates"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("omnyo-app");
    expect(output).toContain("0.0.32 -> 0.0.33");
    expect(output).toContain("Update available (run: npx omnyo-app@latest)");
    expect(output).toContain("workstation · Codex");
    expect(output).toContain("0.140.0 -> 0.141.0");
    expect(output).toContain("workstation · Claude Code");
    expect(output).toContain("Up to date");
    expect(output).toContain("laptop");
    expect(output).toContain("offline");
  });

  it.each(["source", "npm"] as const)(
    "reports unknown freshness for an unmanaged %s install",
    async (installKind) => {
      stubServerApi({
        "v1.system.version.$get": vi.fn(async () => ({
          ...version,
          installKind,
          currentCommit: installKind === "source" ? "a".repeat(40) : null,
          latestVersion: null,
          updateAvailable: false,
        })),
        "v1.hosts.$get": vi.fn(async () => []),
      });
      await runCommand(["updates"], register);
      const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
      expect(output).toContain("Latest unknown");
      expect(output).not.toContain("Up to date");
      expect(output).not.toContain("npx omnyo-app@latest");

      if (installKind === "source") {
        expect(output).toContain("source checkout aaaaaaaaaa");
        expect(output).toContain("update this checkout with Git");
      }
    },
  );

  it("omnyo updates --json prints the aggregate", async () => {
    const status = providerStatus({ codexNeedsUpdate: false });
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => status),
    });

    await runCommand(["updates", "--json"], register);

    const payload = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    );

    expect(payload.app).toEqual(version);
    expect(payload.machines).toHaveLength(2);
    expect(payload.machines[0].providerStatus).toEqual(status);
    expect(payload.machines[1].providerStatus).toBeNull();
  });

  it("omnyo updates reports private release ownership without claiming freshness", async () => {
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => ({
        ...version,
        currentVersion: "0.46.3+private.1",
        source: "private",
        latestVersion: null,
        updateAvailable: false,
        upgradeCommand: "Use the verified private release installer",
      })),
      "v1.hosts.$get": vi.fn(async () => []),
    });

    await runCommand(["updates"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("0.46.3+private.1");
    expect(output).toContain(
      "Private release (Use the verified private release installer)",
    );
    expect(output).not.toContain("Latest unknown");
    expect(output).not.toContain("Up to date");
    expect(output).not.toContain("npx omnyo-app");
  });

  it("omnyo updates apply runs each available provider update", async () => {
    const install = vi.fn(
      async () =>
        new Response(
          [
            JSON.stringify({
              type: "started",
              provider: "codex",
              actionKind: "update",
              command: "codex update",
            }),
            JSON.stringify({
              type: "completed",
              provider: "codex",
              success: true,
              exitCode: 0,
              signal: null,
            }),
          ].join("\n"),
          { status: 200 },
        ),
    );

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
      "v1.hosts.:id.provider-clis.install.$post": install,
    });

    await runCommand(["updates", "apply"], register);

    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({ confirmInterruptingThreads: false }),
      }),
    );
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Codex on workstation: running update…",
      "Codex on workstation: done",
    ]);
  });

  it("omnyo updates apply --yes pauses chats explicitly and streams progress", async () => {
    const install = vi.fn(
      async () =>
        new Response(
          [
            JSON.stringify({
              type: "progress",
              provider: "codex",
              phase: "pausing",
              message: "Pausing chats on this machine.",
            }),
            JSON.stringify({
              type: "completed",
              provider: "codex",
              success: true,
              exitCode: 0,
              signal: null,
            }),
          ].join("\n"),
        ),
    );

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
      "v1.hosts.:id.provider-clis.install.$post": install,
    });
    await runCommand(["updates", "apply", "--yes"], register);
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({ confirmInterruptingThreads: true }),
      }),
    );
    expect(collectLogPayloads(vi.mocked(console.log))).toContain(
      "Codex on workstation: Pausing chats on this machine.",
    );
  });

  it("omnyo updates apply --json returns an installer error code and fails the command", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
      "v1.hosts.:id.provider-clis.install.$post": vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: "error",
              provider: "codex",
              code: "runtime_update_busy",
              message: "Close the terminal, then retry.",
            }),
          ),
      ),
    });
    await expect(
      runCommand(["updates", "apply", "--yes", "--json"], register),
    ).rejects.toThrow("process.exit:1");

    const payload = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    );

    expect(payload.results).toEqual([
      expect.objectContaining({
        success: false,
        errorCode: "runtime_update_busy",
      }),
    ]);
  });

  it("clears a replayed uncertain error after the same installation succeeds", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: true }),
      ),
      "v1.hosts.:id.provider-clis.install.$post": vi.fn(
        async () =>
          new Response(
            [
              JSON.stringify({
                type: "error",
                provider: "codex",
                code: "provider_cli_update_outcome_unknown",
                message: "Waiting for the update result.",
              }),
              JSON.stringify({
                type: "completed",
                provider: "codex",
                success: true,
                exitCode: 0,
                signal: null,
              }),
            ].join("\n"),
          ),
      ),
    });
    await runCommand(["updates", "apply", "--yes", "--json"], register);

    const payload = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    );

    expect(payload.results).toEqual([
      expect.objectContaining({
        success: true,
        errorCode: null,
        message: null,
      }),
    ]);
  });

  it("omnyo updates apply reports when everything is current", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () =>
        providerStatus({ codexNeedsUpdate: false }),
      ),
    });

    await runCommand(["updates", "apply"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Everything is up to date.",
    ]);
  });

  it("omnyo updates reports but does not apply manual provider updates", async () => {
    const status = providerStatus({ codexNeedsUpdate: true });
    status.codex.installAction = null;
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.provider-clis.status.$get": vi.fn(async () => status),
    });

    await runCommand(["updates"], register);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "Update in terminal",
    );

    vi.mocked(console.log).mockClear();
    await runCommand(["updates", "apply"], register);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No updates Omnyo can apply. Run omnyo updates status for manual updates.",
    ]);
  });

  it("omnyo updates points at the in-app update when the launcher supports it", async () => {
    stubServerApi({
      "v1.system.version.$get": vi.fn(async () => version),
      "v1.system.app-update.$get": vi.fn(async () => appUpdateStatus()),
      "v1.hosts.$get": vi.fn(async () => []),
    });

    await runCommand(["updates"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("0.0.32 -> 0.0.33");
    expect(output).toContain("Update available (run: omnyo updates app apply)");
  });
});

function appUpdateStatus(
  overrides: Partial<SystemAppUpdateStatus> = {},
): SystemAppUpdateStatus {
  return {
    activity: { phase: "idle" },
    available: {
      channel: "latest",
      commit: null,
      commitCount: null,
      subjects: [],
      version: "0.0.33",
    },
    blocked: null,
    current: { commit: null, version: "0.0.32" },
    installsWhenIdle: false,
    lastResult: null,
    newTurnsPausedForUpdate: false,
    runningThreadCount: 0,
    support: { kind: "supported", mode: "npm" },
    ...overrides,
  };
}

describe("omnyo updates app command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerUpdatesCommands(program, () => "http://server");

  it("omnyo updates app shows the available version and how to apply it", async () => {
    const getStatus = vi.fn(async () => appUpdateStatus());
    stubServerApi({ "v1.system.app-update.$get": getStatus });

    await runCommand(["updates", "app"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "omnyo-app 0.0.32 -> 0.0.33",
      "Run omnyo updates app apply to update and restart Omnyo.",
    ]);
    expect(getStatus).toHaveBeenCalledWith({ query: { force: "true" } });
  });

  it("omnyo updates app does not call a failed check up to date", async () => {
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () => ({
        activity: { phase: "idle" },
        available: null,
        blocked: {
          reason: "fetch-failed",
          message: "Couldn't check for a newer Omnyo release.",
        },
        current: { version: "0.0.32", commit: null },
        installsWhenIdle: false,
        lastResult: null,
        newTurnsPausedForUpdate: false,
        runningThreadCount: 0,
        support: { kind: "supported", mode: "npm" },
      })),
    });
    await runCommand(["updates", "app"], register);
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Couldn't check for a newer Omnyo release.");
    expect(output).not.toContain("up to date");
  });

  it("omnyo updates app lists incoming commits and blockers for a source checkout", async () => {
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({
          available: {
            channel: "main",
            commit: "b".repeat(40),
            commitCount: 12,
            subjects: ["Fix bug", "Add feature"],
            version: "0.0.32",
          },
          blocked: {
            message: "The working tree has uncommitted changes.",
            reason: "uncommitted-changes",
          },
          current: { commit: "a".repeat(40), version: "0.0.32" },
          support: { kind: "supported", mode: "source" },
        }),
      ),
    });

    await runCommand(["updates", "app"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      `omnyo-app source checkout ${"a".repeat(10)} -> ${"b".repeat(10)} (+12 commits)`,
      "  Fix bug",
      "  Add feature",
      "  … 10 more",
      "Blocked: The working tree has uncommitted changes.",
    ]);
  });

  it("omnyo updates app apply confirms before interrupting threads, then follows the restart", async () => {
    const statuses = [
      appUpdateStatus({ runningThreadCount: 2 }),
      appUpdateStatus({
        activity: {
          output: [],
          phase: "preparing",
          startedAt: "2026-09-23T00:00:00.000Z",
          step: "Downloading omnyo-app 0.0.33",
          targetVersion: "0.0.33",
        },
      }),
      appUpdateStatus({
        available: null,
        current: { commit: null, version: "0.0.33" },
        lastResult: {
          acknowledged: false,
          finishedAt: "2026-09-23T00:00:10.000Z",
          from: { commit: null, version: "0.0.32" },
          id: "update-1",
          logTail: [],
          message: null,
          outcome: "updated",
          phase: null,
          to: { commit: null, version: "0.0.33" },
        },
      }),
    ];

    const apply = vi.fn(async () => statuses[1]);
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () => statuses.shift()),
      "v1.system.app-update.apply.$post": apply,
    });
    readlineMocks.question.mockResolvedValue("y");

    await runCommand(["updates", "app", "apply"], register);

    expect(readlineMocks.question).toHaveBeenCalledWith(
      expect.stringContaining("2 threads are running"),
    );
    expect(apply).toHaveBeenCalledWith({
      json: { confirmInterruptingThreads: true },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Updating Omnyo to 0.0.33",
      "Downloading omnyo-app 0.0.33…",
      "Updated Omnyo to 0.0.33.",
    ]);
  });

  it.each([false, true])(
    "omnyo updates app apply reports cancellation without a failure exit (json: %s)",
    async (json) => {
      const cancelled = {
        acknowledged: false,
        finishedAt: "2026-09-23T00:00:10.000Z",
        from: { commit: null, version: "0.0.32" },
        id: "cancelled-update",
        logTail: [],
        message: "The update was cancelled.",
        outcome: "cancelled" as const,
        phase: null,
        to: { commit: null, version: "0.0.33" },
      };

      const statuses = [
        appUpdateStatus(),
        appUpdateStatus({ lastResult: cancelled }),
      ];

      stubServerApi({
        "v1.system.app-update.$get": vi.fn(async () => statuses.shift()),
        "v1.system.app-update.apply.$post": vi.fn(async () =>
          appUpdateStatus(),
        ),
      });

      await runCommand(
        ["updates", "app", "apply", ...(json ? ["--json"] : [])],
        register,
      );

      expect(process.exitCode ?? 0).toBe(0);
      const output = collectLogPayloads(vi.mocked(console.log));

      if (json) {
        expect(JSON.parse(output.at(-1) ?? "").lastResult).toEqual(cancelled);
      } else {
        expect(output.at(-1)).toBe("Update cancelled.");
      }
    },
  );

  it("omnyo updates app apply exits non-zero when the update fails", async () => {
    const statuses = [
      appUpdateStatus(),
      appUpdateStatus({
        lastResult: {
          acknowledged: false,
          finishedAt: "2026-09-23T00:00:10.000Z",
          from: { commit: null, version: "0.0.32" },
          id: "update-1",
          logTail: ["npm error 404"],
          message: "npm install failed",
          errorCode: "app_update_prepare_failed",
          outcome: "failed",
          phase: "install",
          to: { commit: null, version: "0.0.33" },
        },
      }),
    ];

    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () => statuses.shift()),
      "v1.system.app-update.apply.$post": vi.fn(async () => appUpdateStatus()),
    });

    await expect(
      runCommand(["updates", "app", "apply"], register),
    ).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "Error: Update to 0.0.33 failed [app_update_prepare_failed]: npm install failed",
    );
  });

  it("omnyo updates app apply refuses to interrupt threads without a terminal or --yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    const apply = vi.fn(async () => appUpdateStatus());
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({ runningThreadCount: 1 }),
      ),
      "v1.system.app-update.apply.$post": apply,
    });

    await expect(
      runCommand(["updates", "app", "apply"], register),
    ).rejects.toThrow("process.exit:1");
    expect(apply).not.toHaveBeenCalled();
  });

  it("omnyo updates app apply --yes --no-wait starts the update and returns", async () => {
    const apply = vi.fn(async () => appUpdateStatus());
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({ runningThreadCount: 3 }),
      ),
      "v1.system.app-update.apply.$post": apply,
    });

    await runCommand(
      ["updates", "app", "apply", "--yes", "--no-wait"],
      register,
    );

    expect(apply).toHaveBeenCalledWith({
      json: { confirmInterruptingThreads: true },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Updating Omnyo to 0.0.33. Run omnyo updates app to follow it.",
    ]);
  });

  it("omnyo updates app apply explains when Omnyo cannot update itself", async () => {
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({
          support: { kind: "unsupported", reason: "unmanaged" },
        }),
      ),
    });

    await expect(
      runCommand(["updates", "app", "apply"], register),
    ).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "Error: In-app updates are off. Start Omnyo with `omnyo-app start` or `pnpm start`, without `--no-in-app-updates`, to turn them on.",
    );
  });

  it("omnyo updates app dismiss acknowledges an unseen result", async () => {
    const acknowledge = vi.fn(async () => appUpdateStatus());
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({
          lastResult: {
            acknowledged: false,
            finishedAt: "2026-09-23T00:00:10.000Z",
            from: { commit: null, version: "0.0.32" },
            id: "update-1",
            logTail: [],
            message: "boom",
            outcome: "failed",
            phase: "install",
            to: { commit: null, version: "0.0.33" },
          },
        }),
      ),
      "v1.system.app-update.acknowledge.$post": acknowledge,
    });

    await runCommand(["updates", "app", "dismiss"], register);

    expect(acknowledge).toHaveBeenCalledWith({ json: { id: "update-1" } });
  });

  const privateUpdate = {
    available: {
      channel: "private" as const,
      commit: "b".repeat(40),
      commitCount: null,
      subjects: [],
      version: "0.46.20+private.1",
    },
    current: { commit: null, version: "0.46.19+private.1" },
    support: { kind: "supported" as const, mode: "private" as const },
  };

  const draining = {
    phase: "draining" as const,
    startedAt: "2026-10-18T10:00:00.000Z",
    stopsRunningChatsAt: "2026-10-18T10:10:00.000Z",
    targetVersion: "0.46.20+private.1",
  };

  const stopsAt = new Date(draining.stopsRunningChatsAt).toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" },
  );

  it("reports a paused update independently of its visible activity phase", async () => {
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({
          ...privateUpdate,
          available: null,
          newTurnsPausedForUpdate: true,
        }),
      ),
    });

    await runCommand(["updates", "app"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "omnyo-app 0.46.19+private.1",
      "New turns wait until the Omnyo update finishes.",
    ]);
  });

  it("omnyo updates app apply lets running threads finish on a private server instead of interrupting them", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const statuses = [
      appUpdateStatus({ ...privateUpdate, runningThreadCount: 2 }),
      appUpdateStatus({
        ...privateUpdate,
        activity: draining,
        runningThreadCount: 2,
      }),
    ];

    const apply = vi.fn(async () =>
      appUpdateStatus({ ...privateUpdate, runningThreadCount: 2 }),
    );

    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () => statuses.shift()),
      "v1.system.app-update.apply.$post": apply,
    });

    await runCommand(["updates", "app", "apply"], register);

    expect(readlineMocks.question).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith({
      json: { confirmInterruptingThreads: false },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Updating Omnyo to 0.46.20+private.1",
      `Omnyo installs 0.46.20+private.1 once 2 running chats finish, or at ${stopsAt} pauses them, updates and resumes them.`,
      "Run omnyo updates app apply --yes to stop running chats, update now and resume them, or omnyo updates app cancel to stop.",
    ]);
  });

  it("omnyo updates app shows a private update waiting for running threads", async () => {
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({
          ...privateUpdate,
          activity: draining,
          runningThreadCount: 1,
        }),
      ),
    });

    await runCommand(["updates", "app"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "omnyo-app 0.46.19+private.1 -> 0.46.20+private.1",
      `Omnyo installs 0.46.20+private.1 once 1 running chat finishes, or at ${stopsAt} pauses it, updates and resumes it.`,
      "Run omnyo updates app apply --yes to stop running chats, update now and resume them, or omnyo updates app cancel to stop.",
    ]);
  });

  it("omnyo updates app cancel stops an update that is waiting to restart", async () => {
    const cancel = vi.fn(async () => appUpdateStatus(privateUpdate));
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus({ ...privateUpdate, activity: draining }),
      ),
      "v1.system.app-update.cancel.$post": cancel,
    });

    await runCommand(["updates", "app", "cancel"], register);

    expect(cancel).toHaveBeenCalled();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Cancelled the Omnyo update. Waiting messages send now.",
    ]);
  });

  it("omnyo updates app cancel reports when no update is waiting", async () => {
    const cancel = vi.fn(async () => appUpdateStatus(privateUpdate));
    stubServerApi({
      "v1.system.app-update.$get": vi.fn(async () =>
        appUpdateStatus(privateUpdate),
      ),
      "v1.system.app-update.cancel.$post": cancel,
    });

    await runCommand(["updates", "app", "cancel"], register);

    expect(cancel).not.toHaveBeenCalled();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No Omnyo update is waiting to restart.",
    ]);
  });
});
