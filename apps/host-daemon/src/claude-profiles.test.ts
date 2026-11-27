import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  makeDispatchOptions,
  makeTempDir,
} from "../test/command/dispatch-helpers.js";
import {
  manageClaudeProfiles,
  setClaudeCheckTimeoutForTests,
  withClaudeProfileEnvironment,
} from "./claude-profiles.js";
import { RuntimeManager } from "./runtime-manager.js";

afterEach(cleanupTempDirs);

async function fixture() {
  const dataDir = await makeTempDir("omnyo-native-claude-profiles-");
  const executable = path.join(dataDir, "claude");
  await fs.writeFile(
    executable,
    `#!${process.execPath}
const slowMarker = require("node:path").join(
  require("node:path").dirname(process.argv[1]),
  process.argv[2] === "--version" ? "slow-version" : "slow-auth",
);
if (require("node:fs").existsSync(slowMarker)) {
  setTimeout(() => {}, 10_000);
} else if (process.argv[2] === "--version") {
  console.log("2.1.331 (Claude Code)");
} else {
  const fs = require("node:fs");
  const path = require("node:path");
  const configDirectory = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude");
  const file = path.join(configDirectory, "test-account.json");
  console.log(JSON.stringify({
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    configDirectory,
    loggedIn: fs.existsSync(file),
    ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}),
  }));
}
`,
    { mode: 0o700 },
  );

  const runtimeManager = new RuntimeManager({
    createRuntime: () => {
      throw new Error("Unexpected runtime");
    },
    provisionWorkspace: async () => {
      throw new Error("Unexpected workspace");
    },
    shellEnv: {
      ...Object.fromEntries(Object.keys(process.env).map((key) => [key, ""])),
      HOME: dataDir,
      OMNYO_CLAUDE_CODE_EXECUTABLE: executable,
    },
  });

  const options = makeDispatchOptions({ dataDir, runtimeManager });

  const add = async (label: string, adoptExisting?: true) => {
    const result = await manageClaudeProfiles(
      { action: "add", label, adoptExisting },
      options,
    );

    if (result.action !== "add") throw new Error("Expected a Claude profile");

    return result.profile;
  };

  const signIn = async (directory: string, email: string, orgId: string) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, "test-account.json"),
      JSON.stringify({ email, orgId }),
      { mode: 0o600 },
    );
  };

  const slow = (check: "version" | "auth", enabled: boolean) =>
    enabled
      ? fs.writeFile(path.join(dataDir, `slow-${check}`), "")
      : fs.rm(path.join(dataDir, `slow-${check}`));

  return {
    add,
    options,
    slow,
    profileConfig: (profileId: string) =>
      path.join(dataDir, "native-claude-profiles", profileId, "claude"),
    existingConfig: path.join(dataDir, ".claude"),
    signIn,
  };
}

describe.skipIf(process.platform !== "darwin")(
  "native Claude account identity",
  () => {
    it("accepts only one of two concurrent sign-ins for the same account", async () => {
      const { add, options, profileConfig, signIn } = await fixture();
      const first = await add("First");
      const second = await add("Second");
      await Promise.all([
        signIn(profileConfig(first.id), "person@example.com", "example-org"),
        signIn(profileConfig(second.id), "PERSON@example.com", "example-org"),
      ]);

      const getStatuses = () =>
        Promise.all(
          [first, second].map(({ id }) =>
            manageClaudeProfiles({ action: "status", profileId: id }, options),
          ),
        );

      const result = await getStatuses();
      expect(
        result
          .map((row) =>
            row.action === "status" ? row.profile.status : row.action,
          )
          .sort(),
      ).toEqual(["duplicate-account", "ready"]);

      const rejected = result.find(
        (row) =>
          row.action === "status" && row.profile.status === "duplicate-account",
      );

      if (rejected?.action !== "status")
        throw new Error("Expected a duplicate");

      await signIn(
        profileConfig(rejected.profile.id),
        "other@example.com",
        "other-org",
      );
      expect(await getStatuses()).toMatchObject([
        { profile: { status: "ready" } },
        { profile: { status: "ready" } },
      ]);
    });

    it("refuses to adopt the same account again without adding a profile", async () => {
      const { add, existingConfig, options, signIn } = await fixture();
      await signIn(existingConfig, "person@example.com", "example-org");
      const original = await add("Original", true);

      await expect(add("Duplicate", true)).rejects.toThrow("already added");
      expect(await manageClaudeProfiles({ action: "list" }, options)).toEqual({
        action: "list",
        supported: true,
        profiles: [original],
      });
    });

    it("removes the account from new selections and keeps existing chat bindings usable", async () => {
      const { add, existingConfig, options, signIn } = await fixture();
      await signIn(existingConfig, "person@example.com", "example-org");
      const original = await add("Original", true);
      const target = { profileId: original.id };

      const remove = () =>
        manageClaudeProfiles({ action: "remove", ...target }, options);

      await expect(remove()).resolves.toEqual({ action: "remove", ...target });
      await expect(remove()).resolves.toEqual({ action: "remove", ...target });
      await expect(
        manageClaudeProfiles({ action: "list" }, options),
      ).resolves.toMatchObject({ profiles: [] });
      await expect(
        manageClaudeProfiles({ action: "status", ...target }, options),
      ).resolves.toMatchObject({ profile: { status: "removed" } });

      const binding = {
        options,
        context: {
          providerId: "claude-code",
          claudeProfileBinding: target,
          contributedEnv: [],
        },
      };

      await expect(withClaudeProfileEnvironment(binding)).rejects.toThrow(
        "removed",
      );
      await expect(
        withClaudeProfileEnvironment({ ...binding, allowRemoved: true }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "ANTHROPIC_CONFIG_DIR" }),
        ]),
      );
      expect(await add("Add again", true)).toMatchObject({ status: "ready" });
    });

    it("reports a slow sign-in check as timed out, not unavailable, and checks again", async () => {
      const { add, options, profileConfig, signIn, slow } = await fixture();
      const original = await add("Original");
      await signIn(profileConfig(original.id), "person@example.com", "org");
      const restore = setClaudeCheckTimeoutForTests(500);

      try {
        await slow("auth", true);
        await expect(
          manageClaudeProfiles({ action: "list" }, options),
        ).resolves.toMatchObject({
          supported: true,
          profiles: [{ id: original.id, status: "check-timed-out" }],
        });
        await expect(
          withClaudeProfileEnvironment({
            options,
            context: {
              providerId: "claude-code",
              claudeProfileBinding: { profileId: original.id },
              contributedEnv: [],
            },
          }),
        ).rejects.toThrow("took too long");

        await slow("auth", false);
        await expect(
          manageClaudeProfiles({ action: "list" }, options),
        ).resolves.toMatchObject({
          profiles: [{ id: original.id, status: "ready" }],
        });
      } finally {
        restore();
      }
    });

    it("does not keep native accounts switched off after a slow version check", async () => {
      const { options, slow } = await fixture();
      const restore = setClaudeCheckTimeoutForTests(500);

      try {
        await slow("version", true);
        await expect(
          manageClaudeProfiles({ action: "list" }, options),
        ).rejects.toThrow("took too long");

        await slow("version", false);
        await expect(
          manageClaudeProfiles({ action: "list" }, options),
        ).resolves.toMatchObject({ supported: true });
      } finally {
        restore();
      }
    });
  },
);
