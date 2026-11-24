import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonSkillTree } from "@omnyo/host-daemon-contract";
import {
  installGlobalSkills,
  readGlobalSkillsStatus,
  replaceSkillDirectory,
} from "./install-global-skills.js";

const logger = { debug: () => undefined, warn: () => undefined };

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(
    path.join(tmpdir(), "omnyo-install-global-skills-"),
  );

  tempDirs.push(dir);

  return dir;
}

function createTreePayload(name: string, body: string): HostDaemonSkillTree {
  const entries = [
    {
      path: "SKILL.md",
      mode: 0o644,
      contentBase64: Buffer.from(
        `---\nname: ${name}\ndescription: Use ${name} outside Omnyo.\n---\n\n${body}\n`,
      ).toString("base64"),
    },
    {
      path: "references/usage.md",
      mode: 0o644,
      contentBase64: Buffer.from(`# ${name}\n`).toString("base64"),
    },
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const hash = createHash("sha256");
  hash.update("bb-skill-tree-v1");

  for (const entry of entries) {
    const bytes = Buffer.from(entry.contentBase64, "base64");
    hash.update("\0file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }

  return { treeHash: hash.digest("hex"), entries };
}

describe("install global skills", () => {
  it("writes the skill into both global agent roots", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const payload = createTreePayload("sample", "first body");

    const result = await installGlobalSkills(
      {
        type: "host.install_global_skills",
        skills: [
          { name: "sample", treeHash: payload.treeHash, entryPath: "SKILL.md" },
        ],
      },
      { dataDir, fetchSkillTree: async () => payload, homeDir, logger },
    );

    expect(result.installations.map((entry) => entry.path)).toEqual([
      path.join(homeDir, ".agents", "skills", "sample"),
      path.join(homeDir, ".claude", "skills", "sample"),
    ]);

    for (const installation of result.installations) {
      await expect(
        readFile(path.join(installation.path, "SKILL.md"), "utf8"),
      ).resolves.toContain("first body");
      await expect(
        readFile(
          path.join(installation.path, "references", "usage.md"),
          "utf8",
        ),
      ).resolves.toBe("# sample\n");
    }
  });

  it("replaces a stale copy without leaving its removed files or staging dirs behind", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const claudeRoot = path.join(homeDir, ".claude", "skills");
    await mkdir(path.join(claudeRoot, "sample"), { recursive: true });
    await writeFile(path.join(claudeRoot, "sample", "SKILL.md"), "stale\n");
    await writeFile(path.join(claudeRoot, "sample", "dropped.md"), "gone\n");
    await mkdir(path.join(claudeRoot, "unrelated"), { recursive: true });
    await writeFile(path.join(claudeRoot, "unrelated", "SKILL.md"), "keep\n");
    const payload = createTreePayload("sample", "fresh body");

    await installGlobalSkills(
      {
        type: "host.install_global_skills",
        skills: [
          { name: "sample", treeHash: payload.treeHash, entryPath: "SKILL.md" },
        ],
      },
      { dataDir, fetchSkillTree: async () => payload, homeDir, logger },
    );

    await expect(
      readFile(path.join(claudeRoot, "sample", "SKILL.md"), "utf8"),
    ).resolves.toContain("fresh body");
    expect((await readdir(path.join(claudeRoot, "sample"))).sort()).toEqual([
      "SKILL.md",
      "references",
    ]);
    expect((await readdir(claudeRoot)).sort()).toEqual(["sample", "unrelated"]);
  });

  it("leaves the installed copy intact when the tree cannot be fetched", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const agentsRoot = path.join(homeDir, ".agents", "skills");
    await mkdir(path.join(agentsRoot, "sample"), { recursive: true });
    await writeFile(path.join(agentsRoot, "sample", "SKILL.md"), "previous\n");
    const payload = createTreePayload("sample", "never arrives");

    const fetchSkillTree = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      installGlobalSkills(
        {
          type: "host.install_global_skills",
          skills: [
            {
              name: "sample",
              treeHash: payload.treeHash,
              entryPath: "SKILL.md",
            },
          ],
        },
        { dataDir, fetchSkillTree, homeDir, logger },
      ),
    ).rejects.toThrow("offline");

    await expect(
      readFile(path.join(agentsRoot, "sample", "SKILL.md"), "utf8"),
    ).resolves.toBe("previous\n");
  });

  it.skipIf(process.platform === "win32").each(["copied", "linked"] as const)(
    "reports the installed hash and detects drift in %s global skill roots",
    async (rootKind) => {
      const dataDir = await makeTempDir();
      const homeDir = await makeTempDir();
      const payload = createTreePayload("sample", "installed body");

      const command = {
        type: "host.install_global_skills" as const,
        skills: [
          { name: "sample", treeHash: payload.treeHash, entryPath: "SKILL.md" },
        ],
      };

      const statusCommand = {
        type: "host.global_skills_status" as const,
        names: ["sample"],
      };

      const before = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(before.entries.map((entry) => entry.treeHash)).toEqual([
        null,
        null,
      ]);

      await installGlobalSkills(command, {
        dataDir,
        fetchSkillTree: async () => payload,
        homeDir,
        logger,
      });

      const agentsSkillPath = path.join(homeDir, ".agents", "skills", "sample");
      const claudeSkillPath = path.join(homeDir, ".claude", "skills", "sample");

      if (rootKind === "linked") {
        await rm(claudeSkillPath, { recursive: true });
        await symlink(agentsSkillPath, claudeSkillPath, "dir");
      }

      const after = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(after.entries.map((entry) => entry.treeHash)).toEqual([
        payload.treeHash,
        payload.treeHash,
      ]);

      await writeFile(
        path.join(homeDir, ".claude", "skills", "sample", "SKILL.md"),
        "---\nname: sample\ndescription: Edited by hand.\n---\n",
      );
      const drifted = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(drifted.entries[1]?.treeHash).not.toBe(payload.treeHash);

      if (rootKind === "linked") {
        expect(drifted.entries[0]?.treeHash).toBe(drifted.entries[1]?.treeHash);
        await expect(readlink(claudeSkillPath)).resolves.toBe(agentsSkillPath);
        const outside = await makeTempDir();
        const outsideFile = path.join(outside, "outside.md");
        await writeFile(outsideFile, "Outside the skill root\n");
        await symlink(
          outsideFile,
          path.join(agentsSkillPath, "references", "outside.md"),
        );
        const unsafe = await readGlobalSkillsStatus(statusCommand, { homeDir });
        expect(unsafe.entries.map((entry) => entry.treeHash)).toEqual([
          null,
          null,
        ]);
      } else expect(drifted.entries[0]?.treeHash).toBe(payload.treeHash);
    },
  );

  it("installs the canonical CLI tree into both empty global roots", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const payload = createTreePayload("omnyo-cli", "canonical body");

    const result = await installGlobalSkills(
      {
        type: "host.install_global_skills",
        skills: [
          {
            name: "omnyo-cli",
            treeHash: payload.treeHash,
            entryPath: "SKILL.md",
          },
        ],
      },
      { dataDir, fetchSkillTree: async () => payload, homeDir, logger },
    );

    expect(result.installations).toEqual([
      {
        name: "omnyo-cli",
        path: path.join(homeDir, ".agents", "skills", "omnyo-cli"),
      },
      {
        name: "omnyo-cli",
        path: path.join(homeDir, ".claude", "skills", "omnyo-cli"),
      },
    ]);

    const status = await readGlobalSkillsStatus(
      { type: "host.global_skills_status", names: ["omnyo-cli"] },
      { homeDir },
    );

    expect(status.entries.map((entry) => entry.treeHash)).toEqual([
      payload.treeHash,
      payload.treeHash,
    ]);

    for (const root of [".agents", ".claude"]) {
      expect(await readdir(path.join(homeDir, root, "skills"))).toEqual([
        "omnyo-cli",
      ]);
    }
  });

  it.skipIf(process.platform === "win32").each(["copied", "linked"] as const)(
    "does not fetch or replace an identical canonical %s installation",
    async (rootKind) => {
      const dataDir = await makeTempDir();
      const homeDir = await makeTempDir();
      const payload = createTreePayload("omnyo-cli", "same body");

      const command = {
        type: "host.install_global_skills" as const,
        skills: [
          {
            name: "omnyo-cli",
            treeHash: payload.treeHash,
            entryPath: "SKILL.md",
          },
        ],
      };

      await installGlobalSkills(command, {
        dataDir,
        fetchSkillTree: async () => payload,
        homeDir,
        logger,
      });
      const agentsPath = path.join(homeDir, ".agents", "skills", "omnyo-cli");
      const claudePath = path.join(homeDir, ".claude", "skills", "omnyo-cli");

      if (rootKind === "linked") {
        await rm(claudePath, { recursive: true });
        await symlink(agentsPath, claudePath, "dir");
      }

      const before = await stat(agentsPath);
      const fetchSkillTree = vi.fn(async () => payload);
      const replaceDirectory = vi.fn(replaceSkillDirectory);

      const result = await installGlobalSkills(command, {
        dataDir,
        fetchSkillTree,
        homeDir,
        logger,
        replaceDirectory,
      });

      expect(result.installations).toHaveLength(2);
      expect(fetchSkillTree).not.toHaveBeenCalled();
      expect(replaceDirectory).not.toHaveBeenCalled();
      const after = await stat(agentsPath);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

      if (rootKind === "linked") {
        await expect(readlink(claudePath)).resolves.toBe(agentsPath);
      }
    },
  );

  it.each(["canonical-edits", "canonical-malformed"] as const)(
    "preserves %s and refuses before any canonical installation or fetch",
    async (kind) => {
      const dataDir = await makeTempDir();
      const homeDir = await makeTempDir();
      const payload = createTreePayload("omnyo-cli", "requested body");
      const root = path.join(homeDir, ".claude", "skills");
      const originalPath = path.join(root, "omnyo-cli");

      const original =
        kind === "canonical-malformed"
          ? "unfinished user notes\n"
          : "---\nname: custom\n---\nUser changes must survive\n";

      await mkdir(originalPath, { recursive: true });
      await writeFile(path.join(originalPath, "SKILL.md"), original);

      const fetchSkillTree = vi.fn(async () => payload);
      const replaceDirectory = vi.fn(replaceSkillDirectory);

      await expect(
        installGlobalSkills(
          {
            type: "host.install_global_skills",
            skills: [
              {
                name: "omnyo-cli",
                treeHash: payload.treeHash,
                entryPath: "SKILL.md",
              },
            ],
          },
          { dataDir, fetchSkillTree, homeDir, logger, replaceDirectory },
        ),
      ).rejects.toMatchObject({ code: "global_skill_conflict" });

      expect(fetchSkillTree).not.toHaveBeenCalled();
      expect(replaceDirectory).not.toHaveBeenCalled();
      await expect(
        readFile(path.join(originalPath, "SKILL.md"), "utf8"),
      ).resolves.toBe(original);
      await expect(
        stat(path.join(homeDir, ".agents", "skills", "omnyo-cli")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(root)).toEqual(["omnyo-cli"]);
    },
  );

  it("rechecks canonical conflicts inside the actual replacement owner after fetch", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const destination = path.join(homeDir, ".agents", "skills", "omnyo-cli");
    const payload = createTreePayload("omnyo-cli", "requested body");

    const fetchSkillTree = vi.fn(async () => {
      await mkdir(destination, { recursive: true });
      await writeFile(
        path.join(destination, "SKILL.md"),
        "work created during fetch\n",
      );

      return payload;
    });

    await expect(
      installGlobalSkills(
        {
          type: "host.install_global_skills",
          skills: [
            {
              name: "omnyo-cli",
              treeHash: payload.treeHash,
              entryPath: "SKILL.md",
            },
          ],
        },
        { dataDir, fetchSkillTree, homeDir, logger },
      ),
    ).rejects.toMatchObject({ code: "global_skill_conflict" });

    expect(fetchSkillTree).toHaveBeenCalledTimes(1);
    await expect(
      readFile(path.join(destination, "SKILL.md"), "utf8"),
    ).resolves.toBe("work created during fetch\n");
    expect(await readdir(path.dirname(destination))).toEqual(["omnyo-cli"]);
    await expect(
      stat(path.join(homeDir, ".claude", "skills", "omnyo-cli")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
