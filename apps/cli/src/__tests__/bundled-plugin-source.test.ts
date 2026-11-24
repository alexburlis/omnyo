import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledPluginSourceIdentity,
  readBundledPluginCandidateSource,
  requireBundledPluginOnMain,
  reviewBundledPluginReplacement,
  type BundledPluginCandidateSource,
} from "../bundled-plugin-source.js";

describe("bundled plugin replacement review", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(
      scratch
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function checkout() {
    const repository = await mkdtemp(join(tmpdir(), "omnyo-plugin-source-"));
    scratch.push(repository);
    const pluginRoot = join(repository, "plugins/fixture");
    const runtime = join(pluginRoot, ".bundled-runtime");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(repository, ".gitignore"), ".bundled-runtime\n");

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
      }).trim();

    git("init", "-q");
    git("config", "commit.gpgsign", "false");

    const edit = async (name: string, body: string) => {
      await writeFile(join(pluginRoot, name), body);
    };

    const commit = async (name: string, body: string) => {
      await edit(name, body);
      git("add", "-A");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        name,
      );

      return git("rev-parse", "HEAD");
    };

    return { repository, runtime, git, edit, commit };
  }

  const candidate = (runtime: string) =>
    readBundledPluginCandidateSource({
      directory: runtime,
      pluginName: "fixture",
    });

  async function installed(sourceCommit: string | null) {
    const rootDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-active-"));
    scratch.push(rootDir);

    if (sourceCommit !== null) {
      await mkdir(join(rootDir, "dist"));
      await writeFile(
        join(rootDir, "dist/omnyo-source.json"),
        JSON.stringify({
          schema: 1,
          sourceCommit,
          path: "plugins/fixture",
        }),
      );
    }

    return rootDir;
  }

  const review = (
    source: BundledPluginCandidateSource,
    activeRootDir: string,
    packagedSourceCommit: string | null,
    candidateVersion = "2.0.0",
  ) =>
    reviewBundledPluginReplacement({
      source,
      activeRootDir,
      installedVersion: "2.0.0",
      candidateVersion,
      readPackagedSourceCommit: async () => packagedSourceCommit,
    });

  it("records the clean commit and the plugin path", async () => {
    const f = await checkout();
    const commit = await f.commit("a.ts", "one\n");
    const source = await candidate(f.runtime);
    expect(source.kind).toBe("clean");
    expect(bundledPluginSourceIdentity(source)).toEqual({
      schema: 1,
      sourceCommit: commit,
      path: "plugins/fixture",
    });
  });

  it("refuses uncommitted plugin edits and records no identity", async () => {
    const f = await checkout();
    await f.commit("a.ts", "one\n");
    await f.edit("b.ts", "foreign work\n");
    const source = await candidate(f.runtime);
    expect(bundledPluginSourceIdentity(source)).toBeNull();
    const result = await review(source, await installed(null), null);
    expect(result.refusal).toContain("uncommitted changes");
  });

  it("warns and proceeds when the active artifact has no identity", async () => {
    const f = await checkout();
    await f.commit("a.ts", "one\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(null),
      null,
    );

    expect(result.refusal).toBeNull();
    expect(result.warning).toContain("no source identity");
  });

  it("refuses a lower candidate version", async () => {
    const f = await checkout();
    await f.commit("a.ts", "one\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(null),
      null,
      "1.9.9",
    );

    expect(result.refusal).toContain("lower than installed");
  });

  it("accepts a candidate built on the installed source", async () => {
    const f = await checkout();
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("a.ts", "two\n");
    await f.commit("b.ts", "more work\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result).toEqual({ warning: null, refusal: null });
  });

  it("refuses an older candidate and names the missing path", async () => {
    const f = await checkout();
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("b.ts", "delivered\n");
    f.git("checkout", "-q", base);

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result.refusal).toContain(`missing installed source ${overlay}`);
    expect(result.refusal).toContain("plugins/fixture/b.ts");
  });

  it("refuses a descendant that reverted the installed change", async () => {
    const f = await checkout();
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("a.ts", "two\n");
    await f.commit("a.ts", "one\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result.refusal).toContain(
      `removes work from installed source ${overlay}`,
    );
    expect(result.refusal).toContain("plugins/fixture/a.ts");
    expect(result.refusal).not.toContain("Merge that commit");
  });

  it.each([
    ["another plugin file", "b.ts"],
    ["a file outside the plugin", "../NOTES.md"],
  ])(
    "refuses a descendant revert when %s also conflicts",
    async (_label, conflicting) => {
      const f = await checkout();
      await f.edit(conflicting, "v0\n");
      const base = await f.commit("a.ts", "one\n");
      await f.edit(conflicting, "v1\n");
      const overlay = await f.commit("a.ts", "two\n");
      await f.edit(conflicting, "v2\n");
      await f.commit("a.ts", "one\n");

      const result = await review(
        await candidate(f.runtime),
        await installed(overlay),
        base,
      );

      expect(result.refusal).toContain("plugins/fixture/a.ts");
      expect(result.refusal).not.toContain("plugins/fixture/b.ts");
      expect(result.refusal).not.toContain("NOTES.md");
    },
  );

  it("refuses a descendant that deleted a file the installed source changed", async () => {
    const f = await checkout();
    await f.edit("b.ts", "v0\n");
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("b.ts", "v1\n");
    f.git("rm", "-q", "plugins/fixture/b.ts");
    await f.commit("a.ts", "two\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result.refusal).toContain("plugins/fixture/b.ts");
  });

  it("accepts a candidate with the installed work when only a file outside the plugin conflicts", async () => {
    const f = await checkout();
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    await f.edit("../NOTES.md", "v0\n");
    const base = await f.commit("a.ts", `${lines.join("\n")}\n`);
    await f.edit("../NOTES.md", "v1\n");

    const overlay = await f.commit(
      "a.ts",
      `${["A", ...lines.slice(1)].join("\n")}\n`,
    );

    f.git("checkout", "-q", base);
    await f.edit("../NOTES.md", "v2\n");
    await f.commit("a.ts", `${["A", ...lines.slice(1, 6), "G"].join("\n")}\n`);

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result.refusal).toBeNull();
  });

  it("accepts rebased work whose content matches the installed source", async () => {
    const f = await checkout();
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("a.ts", "two\n");
    f.git("checkout", "-q", base);
    await f.commit("b.ts", "unrelated\n");
    await f.commit("a.ts", "two\n");

    const result = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(result.refusal).toBeNull();
  });

  it("accepts a conflicting later edit only when the installed source is an ancestor", async () => {
    const f = await checkout();
    const base = await f.commit("a.ts", "one\n");
    const overlay = await f.commit("a.ts", "two\n");
    await f.commit("a.ts", "three\n");

    const descendant = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(descendant.refusal).toBeNull();

    f.git("checkout", "-q", base);
    await f.commit("a.ts", "divergent\n");

    const divergent = await review(
      await candidate(f.runtime),
      await installed(overlay),
      base,
    );

    expect(divergent.refusal).toContain("plugins/fixture/a.ts");
  });

  it("refuses a runtime outside a checkout while the active source is known", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnyo-plugin-outside-"));
    scratch.push(directory);
    const source = await candidate(directory);
    expect(source.kind).toBe("unknown");
    const result = await review(source, await installed("a".repeat(40)), null);
    expect(result.refusal).toContain("not inside a checkout");
    const withoutIdentity = await review(source, await installed(null), null);
    expect(withoutIdentity.refusal).toBeNull();
  });

  it("refuses an installed commit this repository does not have", async () => {
    const f = await checkout();
    await f.commit("a.ts", "one\n");

    const result = await review(
      await candidate(f.runtime),
      await installed("b".repeat(40)),
      null,
    );

    expect(result.refusal).toContain("is not in this repository");
  });

  describe("origin/main containment", () => {
    async function withOrigin(f: Awaited<ReturnType<typeof checkout>>) {
      const origin = await mkdtemp(join(tmpdir(), "omnyo-plugin-origin-"));
      scratch.push(origin);
      execFileSync("git", ["init", "-q", "--bare", origin]);
      f.git("remote", "add", "origin", origin);

      return (commit: string) =>
        f.git("push", "-q", "--force", "origin", `${commit}:refs/heads/main`);
    }

    const onMain = (source: BundledPluginCandidateSource, packaged: string) =>
      requireBundledPluginOnMain({
        source,
        readPackagedSourceCommit: async () => packaged,
      });

    it("refuses a plugin candidate whose change is not on origin/main", async () => {
      const f = await checkout();
      const publish = await withOrigin(f);
      const packaged = await f.commit("a.ts", "one\n");
      publish(await f.commit("b.ts", "landed\n"));
      f.git("checkout", "-q", packaged);
      const stray = await f.commit("a.ts", "stray\n");

      await expect(
        onMain(await candidate(f.runtime), packaged),
      ).rejects.toThrow(
        new RegExp(
          `does not contain this candidate's plugins/fixture changes from ${stray} \\(plugins/fixture/a\\.ts\\)\\. Land them on main first`,
          "u",
        ),
      );
    });

    it("accepts a task-scoped candidate on an older baseline once its change is on origin/main", async () => {
      const f = await checkout();
      const publish = await withOrigin(f);
      const packaged = await f.commit("a.ts", "one\n");
      await f.commit("b.ts", "later main work\n");
      publish(await f.commit("a.ts", "task\n"));
      f.git("checkout", "-q", packaged);
      await f.commit("a.ts", "task\n");

      await expect(
        onMain(await candidate(f.runtime), packaged),
      ).resolves.toBeUndefined();
    });

    it("checks a top-level plugin against its own repository's origin/main", async () => {
      const repository = await mkdtemp(join(tmpdir(), "omnyo-plugins-repo-"));
      scratch.push(repository);
      const runtime = join(repository, "fixture/.bundled-runtime");
      await mkdir(runtime, { recursive: true });
      await writeFile(join(repository, ".gitignore"), ".bundled-runtime\n");

      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repository, ...args], {
          encoding: "utf8",
        }).trim();

      git("init", "-q");
      git("config", "commit.gpgsign", "false");
      await writeFile(join(repository, "fixture/a.ts"), "one\n");
      git("add", "-A");
      git("-c", "user.name=T", "-c", "user.email=t@e.c", "commit", "-qm", "a");
      const origin = await mkdtemp(join(tmpdir(), "omnyo-plugin-origin-"));
      scratch.push(origin);
      execFileSync("git", ["init", "-q", "--bare", origin]);
      git("remote", "add", "origin", origin);
      git("push", "-q", "origin", "HEAD:refs/heads/main");
      const source = await candidate(runtime);
      expect(source).toMatchObject({ kind: "clean", root: "fixture" });
      await expect(onMain(source, "c".repeat(40))).resolves.toBeUndefined();
      await writeFile(join(repository, "fixture/a.ts"), "two\n");
      git("-c", "user.name=T", "-c", "user.email=t@e.c", "commit", "-qam", "b");

      await expect(
        onMain(await candidate(runtime), "c".repeat(40)),
      ).rejects.toThrow("fixture/a.ts");
    });

    it("refuses a candidate outside any checkout", async () => {
      const directory = await mkdtemp(join(tmpdir(), "omnyo-plugin-outside-"));
      scratch.push(directory);

      await expect(
        onMain(await candidate(directory), "a".repeat(40)),
      ).rejects.toThrow("cannot check that origin/main contains it");
    });
  });
});
