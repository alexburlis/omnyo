import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  makeDispatchOptions,
  makeTempDir,
} from "../test/command/dispatch-helpers.js";
import { manageClaudeProfiles } from "./claude-profiles.js";
import { RuntimeManager } from "./runtime-manager.js";

afterEach(cleanupTempDirs);

async function fixture() {
  const dataDir = await makeTempDir("omnyo-native-claude-profiles-");
  const executable = path.join(dataDir, "claude");
  await fs.writeFile(
    executable,
    `#!${process.execPath}
if (process.argv[2] === "--version") {
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

  return {
    add,
    options,
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
  },
);
