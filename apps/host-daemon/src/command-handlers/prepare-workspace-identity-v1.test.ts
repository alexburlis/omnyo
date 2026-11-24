import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RuntimeManager } from "../runtime-manager.js";
import { prepareWorkspaceIdentityV1 } from "./prepare-workspace-identity-v1.js";
import { assertCanonicalWorkspaceStateV1 } from "@omnyo/config/skill-storage-paths";
import { resolveSkillScanRoots } from "./list-skills.js";
import { discoverSkills } from "../command-discovery.js";
import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
} from "@omnyo/domain";
import type { HostWorkspace } from "@omnyo/host-workspace";
import { createDeferredPromise } from "@omnyo/test-helpers";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "omnyo-workspace-identity-")),
  );

  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const dataDir = path.join(root, "host");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(path.join(workspacePath, ".bb", "skills", "review"), {
    recursive: true,
  });
  await writeFile(
    path.join(workspacePath, ".bb", "AGENTS.md"),
    "owned user instructions",
  );
  await writeFile(
    path.join(workspacePath, ".bb", "opaque-π"),
    "unknown user bytes",
  );
  await chmod(path.join(workspacePath, ".bb", "opaque-π"), 0o640);
  await writeFile(
    path.join(workspacePath, ".bb", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Preserve user skill.\n---\n",
  );

  await chmod(path.join(workspacePath, ".bb"), 0o750);
  await mkdir(path.join(workspacePath, ".bb", "opaque-tree"), { mode: 0o710 });

  if (process.platform !== "win32")
    await symlink("opaque-π", path.join(workspacePath, ".bb", "opaque-link"));

  return { root, workspacePath, dataDir, admission: new RuntimeManager() };
}

test("explicit preparation preserves the whole tree and stable skill IDs while reads remain pure", async () => {
  const f = await fixture();

  const before = await lstat(path.join(f.workspacePath, ".bb"), {
    bigint: true,
  });

  await expect(
    assertCanonicalWorkspaceStateV1(f.workspacePath),
  ).rejects.toThrow(/explicit preparation/u);
  expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(true);

  const prepare = () =>
    prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f });

  expect((await prepare()).status).toBe("adopted");
  expect((await prepare()).status).toBe("adopted");
  expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(false);
  expect(
    (await lstat(path.join(f.workspacePath, ".omnyo"), { bigint: true })).ino,
  ).toBe(before.ino);
  expect(
    await readFile(path.join(f.workspacePath, ".omnyo", "opaque-π"), "utf8"),
  ).toBe("unknown user bytes");
  expect(
    (await stat(path.join(f.workspacePath, ".omnyo", "opaque-π"))).mode & 0o777,
  ).toBe(0o640);

  if (process.platform !== "win32") {
    expect(
      await readlink(path.join(f.workspacePath, ".omnyo", "opaque-link")),
    ).toBe("opaque-π");
    expect(
      (await stat(path.join(f.workspacePath, ".omnyo", "opaque-tree"))).mode &
        0o777,
    ).toBe(0o710);
    expect(
      (await stat(path.join(f.workspacePath, ".omnyo"))).mode & 0o777,
    ).toBe(0o750);
  }

  await assertCanonicalWorkspaceStateV1(f.workspacePath);

  const roots = await resolveSkillScanRoots({
    cwd: f.workspacePath,
    homeDir: f.root,
    providerId: "fixture",
    nativeRoots: {
      skills: EMPTY_PROVIDER_NATIVE_ROOTS,
      commands: EMPTY_PROVIDER_NATIVE_ROOTS,
      resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
    },
  });

  const skills = await discoverSkills({ roots });
  expect(skills).toEqual([
    expect.objectContaining({
      rootKind: "omnyo-project",
      id:
        "skill_" +
        createHash("sha256")
          .update("bb-project\0review/SKILL.md")
          .digest("hex"),
    }),
  ]);
});

test("collision and active writer refusal leave source and destination unchanged", async () => {
  const f = await fixture();
  await mkdir(path.join(f.workspacePath, ".omnyo"));
  await expect(
    prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
  ).rejects.toThrow(/collision/u);
  expect(await readdir(path.join(f.workspacePath, ".omnyo"))).toEqual([]);
  await rm(path.join(f.workspacePath, ".omnyo"), { recursive: true });
  let entered!: () => void;
  let release!: () => void;

  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const writer = f.admission.runWorkspaceCommand(
    { paths: [f.workspacePath], unscopedWriter: false },
    async () => {
      entered();
      await blocked;
    },
  );

  await ready;

  try {
    await expect(
      prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
    ).rejects.toThrow(/commands are still active/u);
    expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(true);
  } finally {
    release();
    await writer;
  }

  await prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f });
});

function blockedWork() {
  let entered!: () => void;
  let release!: () => void;

  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    ready,
    release,
    work: async () => {
      entered();
      await blocked;
    },
  };
}

test("identity preparation waits for an in-flight unscoped plugin call and then adopts", async () => {
  const f = await fixture();
  const plugin = blockedWork();

  const writer = f.admission.runWorkspaceCommand(
    { paths: [], unscopedWriter: true },
    plugin.work,
  );

  await plugin.ready;

  const prepared = prepareWorkspaceIdentityV1({
    rootPath: f.workspacePath,
    ...f,
  });

  setTimeout(plugin.release, 20);

  await expect(prepared).resolves.toMatchObject({ status: "adopted" });
  await writer;
  expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(false);
  expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(true);
});

test("identity preparation waits for an unrelated environment provision and then adopts", async () => {
  const f = await fixture();
  const provision = createDeferredPromise<HostWorkspace>();
  const provisionStarted = createDeferredPromise<void>();

  const admission = new RuntimeManager({
    provisionWorkspace: () => {
      provisionStarted.resolve();

      return provision.promise;
    },
  });

  const unrelated = admission.ensureEnvironment({
    environmentId: "env-unrelated-provision",
    workspacePath: path.join(f.root, "unrelated"),
  });

  const settled = unrelated.then(
    () => null,
    (error: unknown) => error,
  );

  await provisionStarted.promise;

  const prepared = prepareWorkspaceIdentityV1({
    rootPath: f.workspacePath,
    dataDir: f.dataDir,
    admission,
  });

  setTimeout(
    () => provision.reject(new Error("unrelated provision ended")),
    20,
  );

  await expect(prepared).resolves.toMatchObject({ status: "adopted" });
  expect(await settled).toBeInstanceOf(Error);
  expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(true);
  await admission.shutdownAll();
});

test("identity preparation refuses unscoped plugin work that outlasts its drain bound", async () => {
  const f = await fixture();
  const admission = new RuntimeManager({ workspaceIdentityDrainTimeoutMs: 50 });
  const plugin = blockedWork();

  const writer = admission.runWorkspaceCommand(
    { paths: [], unscopedWriter: true },
    plugin.work,
  );

  await plugin.ready;

  try {
    await expect(
      prepareWorkspaceIdentityV1({
        rootPath: f.workspacePath,
        dataDir: f.dataDir,
        admission,
      }),
    ).rejects.toThrow(/Unscoped plugin work/u);
    expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(true);
    expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(false);
  } finally {
    plugin.release();
    await writer;
  }
});

test.skipIf(process.platform === "win32")(
  "recovers actual owner-produced journal faults before and after the atomic rename",
  async () => {
    const f = await fixture();
    const key = createHash("sha256").update(f.workspacePath).digest("hex");
    const jobs = path.join(f.dataDir, "workspace-identity-v1");
    const journal = path.join(jobs, key + ".json");

    try {
      await chmod(f.workspacePath, 0o500);
      await expect(
        prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe(
        "prepared",
      );
      expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(true);
      expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(false);
      await chmod(f.workspacePath, 0o700);
      await chmod(jobs, 0o500);
      await expect(
        prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe(
        "prepared",
      );
      expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(false);
      expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(true);
      await chmod(jobs, 0o700);
      await prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f });
      expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("adopted");
      expect(
        await readFile(
          path.join(f.workspacePath, ".omnyo", "opaque-π"),
          "utf8",
        ),
      ).toBe("unknown user bytes");
    } finally {
      await chmod(f.workspacePath, 0o700);

      if (existsSync(jobs)) await chmod(jobs, 0o700);
    }
  },
);

test("workspace admission excludes new rooted writes while preserving unrelated workspace work", async () => {
  const f = await fixture();
  await f.admission.withWorkspaceIdentityAdmission(
    f.workspacePath,
    async () => {
      await expect(
        f.admission.runWorkspaceCommand(
          {
            paths: [path.join(f.workspacePath, "file")],
            unscopedWriter: false,
          },
          async () => "forbidden",
        ),
      ).rejects.toThrow(/closed writer admission/u);
      expect(
        await f.admission.runWorkspaceCommand(
          { paths: [path.join(f.root, "unrelated")], unscopedWriter: false },
          async () => "allowed",
        ),
      ).toBe("allowed");
      await expect(
        f.admission.runWorkspaceCommand(
          { paths: [], unscopedWriter: true },
          async () => "forbidden",
        ),
      ).rejects.toThrow(/closed writer admission/u);
    },
  );
});

test("foreign journal-root links stop before any workspace mutation", async () => {
  const f = await fixture();
  const foreign = path.join(f.root, "foreign-journals");
  await mkdir(foreign);
  await symlink(foreign, path.join(f.dataDir, "workspace-identity-v1"), "dir");
  await expect(
    prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
  ).rejects.toThrow(/linked/u);
  expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(true);
  expect(existsSync(path.join(f.workspacePath, ".omnyo"))).toBe(false);
  expect(await readdir(foreign)).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a symlinked workspace alias prepares its real workspace once",
  async () => {
    const f = await fixture();
    const alias = path.join(f.root, "workspace-alias");
    await symlink(f.workspacePath, alias, "dir");

    expect(await prepareWorkspaceIdentityV1({ ...f, rootPath: alias })).toEqual(
      {
        status: "adopted",
        rootPath: path.join(f.workspacePath, ".omnyo"),
      },
    );
    expect(existsSync(path.join(f.workspacePath, ".bb"))).toBe(false);
    expect(
      (await prepareWorkspaceIdentityV1({ ...f, rootPath: f.workspacePath }))
        .status,
    ).toBe("adopted");
    expect(
      (await prepareWorkspaceIdentityV1({ ...f, rootPath: alias })).status,
    ).toBe("adopted");
    expect(
      (await readdir(path.join(f.dataDir, "workspace-identity-v1"))).filter(
        (name) => name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  },
);

test("a completed adoption stays current when the volume device number changes after a reboot", async () => {
  const f = await fixture();
  const key = createHash("sha256").update(f.workspacePath).digest("hex");
  const journal = path.join(f.dataDir, "workspace-identity-v1", key + ".json");

  await prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f });
  const adopted = JSON.parse(await readFile(journal, "utf8"));
  await writeFile(
    journal,
    JSON.stringify({
      ...adopted,
      source: { ...adopted.source, device: adopted.source.device + "1" },
    }),
  );

  expect(
    await prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f }),
  ).toEqual({
    status: "adopted",
    rootPath: path.join(f.workspacePath, ".omnyo"),
  });
});

test("a completed adoption stays current after the owner removes or replaces its state root", async () => {
  const f = await fixture();

  const prepare = () =>
    prepareWorkspaceIdentityV1({ rootPath: f.workspacePath, ...f });

  await prepare();
  await rm(path.join(f.workspacePath, ".omnyo"), { recursive: true });
  expect((await prepare()).status).toBe("adopted");
  await mkdir(path.join(f.workspacePath, ".omnyo"));
  expect((await prepare()).status).toBe("adopted");
});
