import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createHostWatcher, type WatchPathRootArgs } from "@omnyo/host-watcher";
import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
} from "@omnyo/domain";
import { CommandMetadataCatalog } from "./command-metadata.js";

it("discovers and refreshes skills while unrelated provider state keeps changing", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-command-metadata-churn-")),
  );

  const providerHome = path.join(root, ".codex");
  const skills = path.join(providerHome, "skills");
  const state = path.join(providerHome, "state.sqlite-wal");
  const config = path.join(providerHome, "config.toml");
  const changed = vi.fn();
  const watched: WatchPathRootArgs[] = [];

  const catalog = new CommandMetadataCatalog(
    {
      ...createHostWatcher(),
      watchPathRoot(args) {
        watched.push(args);
        queueMicrotask(args.onReady);

        return () => undefined;
      },
    },
    changed,
  );

  const command = {
    type: "host.list_command_metadata",
    providerId: "test",
    cwd: root,
    nativeRoots: {
      skills: {
        user: [
          { path: skills, recursive: false, ancestors: false, namePrefix: "" },
        ],
        project: [],
      },
      commands: EMPTY_PROVIDER_NATIVE_ROOTS,
      resolved: {
        ...EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
        watchPaths: [config, path.join(providerHome, "plugins", "cache")],
      },
    },
    sharedSkillRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
    projectSkillRead: {
      limit: 1000,
      maxFileBytes: 10 * 1024 * 1024,
      excludeNames: [],
    },
  } satisfies Parameters<CommandMetadataCatalog["list"]>[0];

  let writing = true;
  let writer: Promise<void> | undefined;
  let writes = 0;

  try {
    await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const skill = path.join(skills, `skill-${index}`);
        await fs.mkdir(skill, { recursive: true });
        await fs.writeFile(
          path.join(skill, "SKILL.md"),
          `---\nname: skill-${index}\ndescription: Original description\n---\n`,
        );
      }),
    );
    await fs.writeFile(state, "initial state");
    writer = (async () => {
      while (writing) {
        await fs.writeFile(state, String(++writes));

        for (const watch of watched)
          watch.onChange([{ path: state, type: "update" }]);
        await setImmediate();
      }
    })();

    const first = await catalog.list(command);
    expect(first.commands).toHaveLength(32);
    expect(writes).toBeGreaterThan(1);
    expect(changed).not.toHaveBeenCalled();
    await fs.writeFile(config, "[plugins]\n");

    for (const watch of watched)
      watch.onChange([{ path: config, type: "create" }]);
    await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
    const changedSkill = path.join(skills, "skill-0", "SKILL.md");
    await fs.writeFile(
      changedSkill,
      "---\nname: skill-0\ndescription: Updated description\n---\n",
    );
    const refreshed = await catalog.list(command);
    expect(
      refreshed.commands.find((skill) => skill.name === "skill-0"),
    ).toMatchObject({ description: "Updated description" });
  } finally {
    writing = false;
    await writer;
    await catalog.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function linkedSkillFixture(
  run: (args: {
    root: string;
    skills: string;
    watched: WatchPathRootArgs[];
    stopped: ReturnType<typeof vi.fn>;
    changed: ReturnType<typeof vi.fn>;
    catalog: CommandMetadataCatalog;
    command: Parameters<CommandMetadataCatalog["list"]>[0];
  }) => Promise<void>,
  observationOnly = false,
): Promise<void> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-command-metadata-linked-")),
  );

  const skills = path.join(root, ".claude", "skills");
  const changed = vi.fn();
  const watched: WatchPathRootArgs[] = [];
  const stopped = vi.fn();

  const catalog = observationOnly
    ? new CommandMetadataCatalog({ mode: "observation-only" })
    : new CommandMetadataCatalog(
        {
          ...createHostWatcher(),
          watchPathRoot(args) {
            watched.push(args);
            queueMicrotask(args.onReady);

            return stopped;
          },
        },
        changed,
      );

  try {
    await fs.mkdir(skills, { recursive: true });
    await run({
      root,
      skills,
      watched,
      stopped,
      changed,
      catalog,
      command: {
        type: "host.list_command_metadata",
        providerId: "test",
        cwd: root,
        nativeRoots: {
          skills: {
            user: [
              {
                path: skills,
                recursive: false,
                ancestors: false,
                namePrefix: "",
              },
            ],
            project: [],
          },
          commands: EMPTY_PROVIDER_NATIVE_ROOTS,
          resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
        },
        sharedSkillRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
        projectSkillRead: {
          limit: 1000,
          maxFileBytes: 10 * 1024 * 1024,
          excludeNames: [],
        },
      },
    });
  } finally {
    await catalog.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeLinkedSkill(
  collection: string,
  skills: string,
  name: string,
): Promise<void> {
  const skill = path.join(collection, name);
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(
    path.join(skill, "SKILL.md"),
    `---\nname: ${name}\ndescription: Original description\n---\n`,
  );
  await fs.symlink(skill, path.join(skills, name));
}

it("uses one filesystem watch for skills linked from one collection", async () => {
  await linkedSkillFixture(
    async ({ root, skills, watched, changed, catalog, command }) => {
      const collection = path.join(root, "shared", "skills");

      for (let index = 0; index < 24; index += 1)
        await writeLinkedSkill(collection, skills, `skill-${index}`);

      const first = await catalog.list(command);
      expect(first.commands).toHaveLength(24);
      expect(
        watched
          .map((watch) => watch.rootPath)
          .filter((rootPath) => rootPath.startsWith(path.join(root, "shared"))),
      ).toEqual([collection]);

      const physicalSkillFile = path.join(collection, "skill-7", "SKILL.md");
      await fs.writeFile(
        physicalSkillFile,
        "---\nname: skill-7\ndescription: Updated description\n---\n",
      );

      for (const watch of watched)
        watch.onChange([{ path: physicalSkillFile, type: "update" }]);
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);

      const refreshed = await catalog.list(command);
      expect(
        refreshed.commands.find((skill) => skill.name === "skill-7"),
      ).toMatchObject({ description: "Updated description" });
    },
  );
});

it("retains direct catalog interests by the actual workspace and provider scope", async () => {
  await linkedSkillFixture(
    async ({ root, catalog, command, watched, stopped }) => {
      await catalog.list(command);
      const firstSubscriptions = watched.length;
      expect(firstSubscriptions).toBeGreaterThan(0);
      await catalog.retain([{ cwd: root, providerId: command.providerId }]);
      expect(stopped).not.toHaveBeenCalled();
      await catalog.retain([{ cwd: root, providerId: "different-provider" }]);
      expect(stopped).toHaveBeenCalledTimes(firstSubscriptions);
      await catalog.list(command);
      expect(watched.length).toBeGreaterThan(firstSubscriptions);
      await catalog.retain([]);
      expect(stopped).toHaveBeenCalledTimes(watched.length);
    },
  );
});

it("returns isolated observation snapshots and validates edits without native subscriptions", async () => {
  await linkedSkillFixture(
    async ({ root, skills, watched, catalog, command }) => {
      const collection = path.join(root, "shared", "skills");
      await writeLinkedSkill(collection, skills, "review");
      const first = await catalog.listSnapshot(command);
      expect(watched).toEqual([]);
      expect(first.result.commands).toMatchObject([
        { name: "review", description: "Original description" },
      ]);
      expect(first.watches.flatMap((watch) => watch.targets)).toEqual(
        expect.arrayContaining([
          { path: path.join(collection, "review", "SKILL.md"), shallow: false },
          { path: path.join(skills, "review", "SKILL.md"), shallow: false },
        ]),
      );
      await fs.writeFile(
        path.join(collection, "review", "SKILL.md"),
        "---\nname: review\ndescription: Updated while unsubscribed\n---\n",
      );
      const second = await catalog.listSnapshot(command);
      expect(second.result.commands).toMatchObject([
        { name: "review", description: "Updated while unsubscribed" },
      ]);
      expect(first.result.commands).toMatchObject([
        { name: "review", description: "Original description" },
      ]);
      expect(watched).toEqual([]);
    },
    true,
  );
});

it("does not widen a watch to a folder mostly unrelated to its linked skills", async () => {
  await linkedSkillFixture(
    async ({ root, skills, watched, catalog, command }) => {
      const projects = path.join(root, "projects");

      for (let index = 0; index < 6; index += 1)
        await fs.mkdir(path.join(projects, `unrelated-${index}`), {
          recursive: true,
        });

      await writeLinkedSkill(projects, skills, "linked-a");
      await writeLinkedSkill(projects, skills, "linked-b");

      const listed = await catalog.list(command);
      expect(listed.commands).toHaveLength(2);

      const rootPaths = watched.map((watch) => watch.rootPath);
      expect(rootPaths).not.toContain(projects);
      expect(rootPaths).toEqual(
        expect.arrayContaining([
          path.join(projects, "linked-a"),
          path.join(projects, "linked-b"),
        ]),
      );
    },
  );
});

it("refreshes project metadata from real files even when native events are missed", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "omnyo-command-metadata-")),
  );

  const catalog = new CommandMetadataCatalog(
    createHostWatcher(),
    () => undefined,
  );

  const skill = path.join(root, ".omnyo", "skills", "review");

  const command = {
    type: "host.list_command_metadata" as const,
    providerId: "test",
    cwd: root,
    nativeRoots: {
      skills: EMPTY_PROVIDER_NATIVE_ROOTS,
      commands: {
        user: [],
        project: [
          {
            path: ".claude/commands",
            recursive: true,
            ancestors: false,
            namePrefix: "",
          },
        ],
      },
      resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
    },
    sharedSkillRoots: EMPTY_PROVIDER_NATIVE_ROOTS,
    projectSkillRead: {
      limit: 1000,
      maxFileBytes: 10 * 1024 * 1024,
      excludeNames: [],
    },
  };

  try {
    expect((await catalog.list(command)).projectSkills).toEqual([]);
    await fs.mkdir(skill, { recursive: true });
    expect((await catalog.list(command)).projectSkills).toEqual([]);
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n" +
        "body".repeat(10000),
    );
    const metadata = await catalog.list(command);
    expect(metadata).toEqual({
      commands: [],
      sharedSkills: [],
      projectSkills: [
        { name: "review", description: "Review code", sourceRootPath: skill },
      ],
    });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Updated review\n---\nBody",
    );
    expect((await catalog.list(command)).projectSkills[0]?.description).toBe(
      "Updated review",
    );
    await fs.unlink(path.join(skill, "SKILL.md"));
    expect((await catalog.list(command)).projectSkills).toEqual([]);
    const nested = path.join(root, ".claude", "commands", "group");
    await fs.mkdir(nested, { recursive: true });
    expect((await catalog.list(command)).commands).toEqual([]);
    await fs.writeFile(
      path.join(nested, "audit.md"),
      "---\ndescription: Nested audit\n---\nBody",
    );
    expect((await catalog.list(command)).commands).toEqual([
      {
        name: "group:audit",
        source: "command",
        origin: "project",
        description: "Nested audit",
        argumentHint: null,
      },
    ]);
    await fs.mkdir(path.join(root, ".bb"));
    await expect(catalog.list(command)).rejects.toThrow(/identity collision/u);
  } finally {
    await catalog.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
