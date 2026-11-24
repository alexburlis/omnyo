import { describe, expect, it } from "vitest";
import {
  getNativeClaudeProfilesOwnerPilot,
  setNativeClaudeProfileDefault,
} from "@omnyo/db";
import {
  manageClaudeProfiles,
  requireThreadClaudeProfile,
  resolveNewThreadClaudeProfile,
} from "../../src/services/providers/claude-profiles.js";
import { withTestHarness } from "../helpers/test-app.js";
import { readJson } from "../helpers/json.js";

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
});
