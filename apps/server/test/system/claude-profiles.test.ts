import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getNativeClaudeProfileDefault,
  getNativeClaudeProfilesOwnerPilot,
  noopNotifier,
  openSession,
  setNativeClaudeProfileDefault,
  setNativeClaudeProfilesOwnerPilot,
  upsertHost,
} from "@omnyo/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  HOST_ID_FILE_NAME,
} from "@omnyo/host-daemon-contract";
import {
  manageClaudeProfiles,
  requireThreadClaudeProfile,
  resolveNewThreadClaudeProfile,
} from "../../src/services/providers/claude-profiles.js";
import * as pluginContributions from "../../src/services/plugins/plugin-agent-contributions.js";
import { withTestHarness } from "../helpers/test-app.js";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

describe("native Claude profile owner pilot", () => {
  it("hides unsupported profiles and refuses enabling without a supported coordinator host", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        expect(
          await manageClaudeProfiles(harness.deps, {
            action: "list",
            hostId: "old-worker",
          }),
        ).toEqual({
          action: "list",
          supported: false,
          profiles: [],
          defaultSelection: { kind: "unprofiled" },
        });
        await expect(
          manageClaudeProfiles(harness.deps, {
            action: "pilotSet",
            enabled: true,
          }),
        ).rejects.toThrow("unavailable");
        expect(getNativeClaudeProfilesOwnerPilot(harness.db)).toBe(false);
        setNativeClaudeProfileDefault(harness.db, {
          hostId: "old-worker",
          projectId: null,
          selection: {
            kind: "profile",
            profileId: "00000000-0000-4000-8000-000000000001",
          },
        });
        expect(
          await resolveNewThreadClaudeProfile(harness.deps, {
            providerId: "claude-code",
            hostId: "old-worker",
            projectId: "project",
            selection: undefined,
          }),
        ).toBeNull();
      },
    );
  });

  it("refuses machine credentials before changing the pilot", async () => {
    await withTestHarness(
      {
        seedFirstPartyProviders: false,
        nativeClaudeProfilesOwnerPilotAvailable: true,
      },
      async (harness) => {
        const response = await harness.app.request(
          "/api/v1/system/providers/claude-profiles",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-omnyo-gate-auth": "machine",
            },
            body: JSON.stringify({ action: "pilotSet", enabled: true }),
          },
        );

        expect(response.status).toBe(403);
        expect(await readJson(response)).toMatchObject({ code: "forbidden" });
        expect(getNativeClaudeProfilesOwnerPilot(harness.db)).toBe(false);
      },
    );
  });

  it("refuses moving a bound session to another machine or provider", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const binding = {
          hostId: "owner-mac",
          profileId: "00000000-0000-4000-8000-000000000001",
        };

        expect(() =>
          requireThreadClaudeProfile(harness.deps, {
            binding,
            hostId: "worker",
            providerId: "claude-code",
          }),
        ).toThrow("assigned");
        await expect(
          resolveNewThreadClaudeProfile(harness.deps, {
            providerId: "codex",
            hostId: "owner-mac",
            projectId: "project",
            selection: { kind: "profile", profileId: binding.profileId },
          }),
        ).rejects.toThrow("Claude Code");
      },
    );
  });

  it("routes through Account Pooler, rejects an explicit removed profile, and clears its settings after removal", async () => {
    await withTestHarness(
      { nativeClaudeProfilesOwnerPilotAvailable: true },
      async (harness) => {
        const { db, deps } = harness;
        const host = upsertHost(db, noopNotifier, { name: "owner-mac" });
        await writeFile(join(deps.config.dataDir, HOST_ID_FILE_NAME), host.id);

        const session = openSession(db, {
          hostId: host.id,
          hostName: host.name,
          instanceId: "owner-daemon",
          dataDir: deps.config.dataDir,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          heartbeatIntervalMs: 30_000,
          leaseTimeoutMs: 90_000,
        });

        deps.hub.registerDaemon(session.id, host.id, createMockHubSocket());
        vi.spyOn(deps.hub, "getDaemonPlatformForHost").mockReturnValue(
          "darwin",
        );
        setNativeClaudeProfilesOwnerPilot(db, true);

        const removed = {
          kind: "profile",
          profileId: "00000000-0000-4000-8000-000000000001",
        } as const;

        const remaining = {
          kind: "profile",
          profileId: "00000000-0000-4000-8000-000000000002",
        } as const;

        setNativeClaudeProfileDefault(db, {
          hostId: host.id,
          projectId: "project",
          selection: removed,
        });
        setNativeClaudeProfileDefault(db, {
          hostId: host.id,
          projectId: null,
          selection: remaining,
        });

        vi.spyOn(deps.hub, "requestHostOnlineRpc").mockImplementation(
          async ({ message }) => {
            if (message.command.type !== "claude-profile/manage")
              throw new Error("Unexpected host request");
            const request = message.command.request;

            if (
              request.action !== "remove" &&
              request.action !== "status" &&
              request.action !== "list"
            )
              throw new Error("Unexpected profile request");

            return {
              type: "host-rpc.response",
              requestId: message.requestId,
              commandType: "claude-profile/manage",
              ok: true,
              result:
                request.action === "remove"
                  ? { action: "remove", profileId: request.profileId }
                  : request.action === "list"
                    ? {
                        action: "list",
                        supported: true,
                        profiles: [
                          {
                            id: removed.profileId,
                            label: "Removed",
                            status: "removed",
                            loginExpiresAt: null,
                          },
                          {
                            id: remaining.profileId,
                            label: "Claude",
                            status: "ready",
                            loginExpiresAt: null,
                          },
                        ],
                      }
                    : {
                        action: "status",
                        profile: {
                          id: request.profileId,
                          label: "Claude",
                          status:
                            request.profileId === removed.profileId
                              ? "removed"
                              : "ready",
                          loginExpiresAt: null,
                        },
                      },
            };
          },
        );

        const target = {
          hostId: host.id,
          projectId: "project",
          providerId: "claude-code",
        };

        const route = vi
          .spyOn(pluginContributions, "selectAccountPoolerClaudeProfile")
          .mockResolvedValue({
            ok: true,
            result: { kind: "selected", profileId: remaining.profileId },
          });

        try {
          await expect(
            resolveNewThreadClaudeProfile(deps, {
              ...target,
              selection: undefined,
            }),
          ).resolves.toEqual({
            hostId: host.id,
            profileId: remaining.profileId,
          });
          expect(route).toHaveBeenCalledExactlyOnceWith(host.id, [
            remaining.profileId,
          ]);
        } finally {
          route.mockRestore();
        }

        await expect(
          resolveNewThreadClaudeProfile(deps, {
            ...target,
            selection: removed,
          }),
        ).rejects.toThrow("removed");

        const response = await harness.app.request(
          "/api/v1/system/providers/claude-profiles",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "remove",
              hostId: host.id,
              profileId: removed.profileId,
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({
          action: "remove",
          profileId: removed.profileId,
        });
        expect(
          getNativeClaudeProfileDefault(db, {
            hostId: host.id,
            projectId: "project",
          }),
        ).toBeNull();
        expect(
          getNativeClaudeProfileDefault(db, {
            hostId: host.id,
            projectId: null,
          }),
        ).toEqual(remaining);
      },
    );
  });
});
