import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  createRegistrySkillInstaller,
  installServerRegistrySkill,
} from "../../src/services/skills/registry-skill-install.js";
import { readSkillTreeManifest } from "../../src/services/skills/injected-skills.js";
import {
  readRegistrySkillProvenance,
  REGISTRY_SKILL_PROVENANCE_FILE_NAME,
} from "../../src/services/skills/registry-skill-provenance.js";

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

function stubDownloadedSkill(
  skillId: string,
  body?: string,
  extraFile?: string,
): void {
  spawnMock.mockImplementation(
    (_command: string, _args: string[], options: { cwd: string }) => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        stderr: EventEmitter;
        stdout: EventEmitter;
      };

      child.kill = vi.fn();
      child.stderr = new EventEmitter();
      child.stdout = new EventEmitter();
      void (async () => {
        const skillDirectory = join(options.cwd, ".agents", "skills", skillId);
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
          join(skillDirectory, "SKILL.md"),
          body ?? `---\nname: ${skillId}\ndescription: Test skill.\n---\n`,
        );

        if (extraFile !== undefined)
          await writeFile(join(skillDirectory, "LICENSE"), extraFile);
        child.emit("close", 0);
      })();

      return child;
    },
  );
}

async function writeUntaggedSkill(args: {
  dataDir: string;
  skillId: string;
  body?: string;
}): Promise<string> {
  const skillDirectory = join(args.dataDir, "skills", args.skillId);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    args.body ?? `---\nname: ${args.skillId}\ndescription: Test skill.\n---\n`,
  );

  return skillDirectory;
}

describe("installServerRegistrySkill", () => {
  it("atomically persists the exact registry entry provenance", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-install-test-"),
    );

    try {
      stubDownloadedSkill("find-skills");

      const result = await installServerRegistrySkill({
        dataDir,
        packageRef: "vercel-labs/skills",
        registrySkillId: "github.com/vercel-labs/skills/find-skills",
        skillId: "find-skills",
      });

      const skillDirectory = join(dataDir, "skills", "find-skills");

      expect(result.filePath).toBe(join(skillDirectory, "SKILL.md"));
      expect(readRegistrySkillProvenance(skillDirectory)).toBe(
        "github.com/vercel-labs/skills/find-skills",
      );
      expect(
        (await stat(join(skillDirectory, REGISTRY_SKILL_PROVENANCE_FILE_NAME)))
          .mode & 0o777,
      ).toBe(0o444);
      expect(readSkillTreeManifest(skillDirectory).entries).toEqual([
        expect.objectContaining({ path: "SKILL.md" }),
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs the skills CLI through the bundled npx instead of PATH", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-registry-npx-test-"));
    const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";

    try {
      stubDownloadedSkill("find-skills");

      await installServerRegistrySkill({
        dataDir,
        packageRef: "vercel-labs/skills",
        registrySkillId: "github.com/vercel-labs/skills/find-skills",
        skillId: "find-skills",
      });

      const [command, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];

      expect(command).toBe(process.execPath);
      expect(args[0]).toMatch(/npx-cli\.js$/u);
      expect(existsSync(args[0])).toBe(true);
      expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      if (originalElectronRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
      }

      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("adopts an exact untagged pre-provenance install", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-registry-adopt-test-"));

    try {
      const skillDirectory = await writeUntaggedSkill({
        dataDir,
        skillId: "find-skills",
      });

      stubDownloadedSkill("find-skills");

      const result = await installServerRegistrySkill({
        dataDir,
        packageRef: "vercel-labs/skills",
        registrySkillId: "github.com/vercel-labs/skills/find-skills",
        skillId: "find-skills",
      });

      expect(result.filePath).toBe(join(skillDirectory, "SKILL.md"));
      expect(readRegistrySkillProvenance(skillDirectory)).toBe(
        "github.com/vercel-labs/skills/find-skills",
      );
      expect(await readFile(result.filePath, "utf8")).toBe(
        `---\nname: find-skills\ndescription: Test skill.\n---\n`,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("protects a differing manually-authored skill at the canonical path", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-conflict-test-"),
    );

    try {
      const skillDirectory = await writeUntaggedSkill({
        dataDir,
        skillId: "find-skills",
        body: `---\nname: find-skills\ndescription: Manual skill.\n---\nKeep my local instructions.\n`,
      });

      stubDownloadedSkill("find-skills");

      await expect(
        installServerRegistrySkill({
          dataDir,
          packageRef: "vercel-labs/skills",
          registrySkillId: "github.com/vercel-labs/skills/find-skills",
          skillId: "find-skills",
        }),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: "skill_install_conflict" },
      });
      expect(readRegistrySkillProvenance(skillDirectory)).toBeNull();
      expect(
        await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      ).toContain("Keep my local instructions.");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not adopt an untagged tree containing a symlink", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-symlink-test-"),
    );

    try {
      const skillDirectory = await writeUntaggedSkill({
        dataDir,
        skillId: "find-skills",
      });

      const outsidePath = join(dataDir, "outside.txt");
      await writeFile(outsidePath, "outside\n");
      await symlink(outsidePath, join(skillDirectory, "outside-link"));
      stubDownloadedSkill("find-skills");

      await expect(
        installServerRegistrySkill({
          dataDir,
          packageRef: "vercel-labs/skills",
          registrySkillId: "github.com/vercel-labs/skills/find-skills",
          skillId: "find-skills",
        }),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: "skill_install_conflict" },
      });
      expect(readRegistrySkillProvenance(skillDirectory)).toBeNull();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a traversing skill id before spawning the installer", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-traversal-test-"),
    );

    try {
      await expect(
        installServerRegistrySkill({
          dataDir,
          packageRef: "vercel-labs/skills",
          registrySkillId: "github.com/vercel-labs/skills/find-skills",
          skillId: "../find-skills",
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: { code: "invalid_registry_skill" },
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed downloaded skill metadata without adopting it", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-malformed-test-"),
    );

    try {
      stubDownloadedSkill(
        "find-skills",
        `---\nname: a-different-skill\ndescription: Test skill.\n---\n`,
      );

      await expect(
        installServerRegistrySkill({
          dataDir,
          packageRef: "vercel-labs/skills",
          registrySkillId: "github.com/vercel-labs/skills/find-skills",
          skillId: "find-skills",
        }),
      ).rejects.toMatchObject({
        status: 422,
        body: { code: "registry_skill_invalid" },
      });
      expect(
        readRegistrySkillProvenance(join(dataDir, "skills", "find-skills")),
      ).toBeNull();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("reviewing a registry skill", () => {
  const source = {
    packageRef: "vercel-labs/skills",
    registrySkillId: "vercel-labs/skills/find-skills",
    skillId: "find-skills",
  };

  it("installs the staged tree and reconciles identical concurrent confirmations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-registry-review-"));

    try {
      const installer = createRegistrySkillInstaller(dataDir);
      stubDownloadedSkill(source.skillId, undefined, "Reviewed license");
      const review = await installer.stage(source);
      expect(review.licenseFiles).toEqual(["LICENSE"]);
      expect(
        await installer.readFile(
          source.registrySkillId,
          review.treeDigest,
          "LICENSE",
        ),
      ).toEqual({ path: "LICENSE", contents: "Reviewed license" });
      await expect(
        installer.readFile(
          source.registrySkillId,
          review.treeDigest,
          "../LICENSE",
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(existsSync(join(dataDir, "skills"))).toBe(false);

      stubDownloadedSkill(source.skillId, undefined, "Changed upstream");

      const [first, second] = await Promise.all([
        installer.commit(source, review.treeDigest),
        installer.commit(source, review.treeDigest),
      ]);

      expect(second).toEqual(first);
      expect(first.treeDigest).toBe(review.treeDigest);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(
        await readFile(
          join(dataDir, "skills", source.skillId, "LICENSE"),
          "utf8",
        ),
      ).toBe("Reviewed license");
      expect(await readdir(join(dataDir, "registry-skill-staging"))).toEqual(
        [],
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("removes expired drafts and refuses changed files without installing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omnyo-registry-expired-"));

    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const installer = createRegistrySkillInstaller(dataDir);
      stubDownloadedSkill(source.skillId, undefined, "First");
      const first = await installer.stage(source);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      await expect(
        installer.readFile(source.registrySkillId, first.treeDigest, "LICENSE"),
      ).rejects.toMatchObject({ body: { code: "registry_stage_expired" } });
      stubDownloadedSkill(source.skillId, undefined, "Changed");

      await expect(
        installer.commit(source, first.treeDigest),
      ).rejects.toMatchObject({
        body: {
          code: "registry_skill_changed",
          details: { treeDigest: expect.not.stringMatching(first.treeDigest) },
        },
      });
      expect(existsSync(join(dataDir, "skills"))).toBe(false);

      const second = await installer.stage(source);
      await installer.discard(source.registrySkillId, second.treeDigest);
      expect(await readdir(join(dataDir, "registry-skill-staging"))).toEqual(
        [],
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects non-data frontmatter during review", async () => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "omnyo-registry-frontmatter-"),
    );

    try {
      stubDownloadedSkill(source.skillId, "---javascript\n{}\n---\n");
      const installer = createRegistrySkillInstaller(dataDir);
      await expect(installer.stage(source)).rejects.toMatchObject({
        body: {
          code: "registry_skill_invalid",
          message: "Skill has invalid frontmatter",
        },
      });
      expect(existsSync(join(dataDir, "skills"))).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
