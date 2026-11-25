import { afterEach, describe, expect, it } from "vitest";
import {
  clearNativeClaudeProfileDefaults,
  createProject,
  createThread,
  getThread,
  getNativeClaudeProfileDefault,
  getNativeClaudeProfilesOwnerPilot,
  noopNotifier,
  setNativeClaudeProfileDefault,
  setNativeClaudeProfilesOwnerPilot,
  upsertHost,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const databases: ReturnType<typeof createMigratedConnection>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

describe("native Claude bindings", () => {
  it("persists the selected host and profile independently of later default changes", () => {
    const db = createMigratedConnection();
    databases.push(db);
    const host = upsertHost(db, noopNotifier, { name: "owner-mac" });

    const { project } = createProject(db, noopNotifier, {
      name: "profile-project",
      source: { type: "local_path", hostId: host.id, path: "/project" },
    });

    const binding = {
      hostId: host.id,
      profileId: "00000000-0000-4000-8000-000000000001",
    };

    setNativeClaudeProfileDefault(db, {
      hostId: host.id,
      projectId: null,
      selection: { kind: "profile", profileId: binding.profileId },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
      claudeProfileBinding: binding,
    });

    setNativeClaudeProfileDefault(db, {
      hostId: host.id,
      projectId: null,
      selection: { kind: "unprofiled" },
    });
    expect(getThread(db, thread.id)?.claudeProfileBinding).toEqual(binding);
    expect(
      getNativeClaudeProfileDefault(db, { hostId: host.id, projectId: null }),
    ).toEqual({ kind: "unprofiled" });
    expect(
      createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "claude-code",
      }).claudeProfileBinding,
    ).toBeNull();
  });

  it("keeps the pilot off by default and scopes machine and project defaults independently", () => {
    const db = createMigratedConnection();
    databases.push(db);
    expect(getNativeClaudeProfilesOwnerPilot(db)).toBe(false);
    setNativeClaudeProfilesOwnerPilot(db, true);
    expect(getNativeClaudeProfilesOwnerPilot(db)).toBe(true);
    setNativeClaudeProfileDefault(db, {
      hostId: "mac",
      projectId: null,
      selection: {
        kind: "profile",
        profileId: "00000000-0000-4000-8000-000000000002",
      },
    });
    setNativeClaudeProfileDefault(db, {
      hostId: "mac",
      projectId: "project",
      selection: { kind: "unprofiled" },
    });
    expect(
      getNativeClaudeProfileDefault(db, {
        hostId: "mac",
        projectId: "project",
      }),
    ).toEqual({ kind: "unprofiled" });
    expect(
      getNativeClaudeProfileDefault(db, { hostId: "other", projectId: null }),
    ).toBeNull();
  });

  it("clears only defaults that reference the removed profile on its host", () => {
    const db = createMigratedConnection();
    databases.push(db);
    const profileId = "00000000-0000-4000-8000-000000000001";
    const selection = { kind: "profile", profileId } as const;
    setNativeClaudeProfileDefault(db, {
      hostId: "mac",
      projectId: null,
      selection,
    });
    setNativeClaudeProfileDefault(db, {
      hostId: "mac",
      projectId: "project",
      selection,
    });
    setNativeClaudeProfileDefault(db, {
      hostId: "other",
      projectId: "project",
      selection,
    });
    setNativeClaudeProfileDefault(db, {
      hostId: "mac",
      projectId: "unprofiled",
      selection: { kind: "unprofiled" },
    });

    clearNativeClaudeProfileDefaults(db, { hostId: "mac", profileId });

    expect(
      getNativeClaudeProfileDefault(db, { hostId: "mac", projectId: null }),
    ).toBeNull();
    expect(
      getNativeClaudeProfileDefault(db, {
        hostId: "mac",
        projectId: "project",
      }),
    ).toBeNull();
    expect(
      getNativeClaudeProfileDefault(db, {
        hostId: "other",
        projectId: "project",
      }),
    ).toEqual(selection);
    expect(
      getNativeClaudeProfileDefault(db, {
        hostId: "mac",
        projectId: "unprofiled",
      }),
    ).toEqual({ kind: "unprofiled" });
  });
});
