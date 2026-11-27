import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { GitHost } from "../src/git-host";

it("discovers exact immediate child repositories with current branches and useful checks, excluding symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentry-discovery-test-"));

  try {
    const umbrella = join(root, "app");
    await mkdir(umbrella);

    for (const name of ["ios", "landing"]) {
      const path = join(umbrella, name);
      await mkdir(path);
      execFileSync("git", ["init", "-b", "2.0"], { cwd: path });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ scripts: { "test:unit": "node --test" } }),
      );

      if (name === "ios") await writeFile(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      execFileSync("git", ["add", "."], { cwd: path });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "base",
        ],
        { cwd: path },
      );
    }

    await symlink(join(umbrella, "ios"), join(umbrella, "alias"));
    const found = await new GitHost().discoverRepositories(umbrella);
    expect(found.map((r) => r.name)).toEqual(["ios", "landing"]);
    expect(found.every((r) => r.baseRef === "2.0")).toBe(true);
    expect(found[0]!.checks).toMatchObject([{ command: "pnpm", args: ["test:unit"] }]);
    expect(found[1]!.checks).toMatchObject([{ command: "npm", args: ["run", "test:unit"] }]);
    expect((await new GitHost().discoverRepositories(join(umbrella, "landing")))[0]!.path).toBe(
      await realpath(join(umbrella, "landing")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("runs discovered test scripts with the repository's declared or locked package manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentry-discovery-manager-test-"));

  try {
    const fixtures = [
      { name: "bun-app", manifest: { scripts: { test: "bun test" } }, lockfile: "bun.lock" },
      {
        name: "declared",
        manifest: { packageManager: "yarn@4.6.0", scripts: { test: "vitest" } },
        lockfile: "package-lock.json",
      },
      { name: "npm-app", manifest: { scripts: { test: "node --test" } }, lockfile: null },
    ];

    for (const fixture of fixtures) {
      const path = join(root, fixture.name);
      await mkdir(path);
      execFileSync("git", ["init", "-b", "main"], { cwd: path });
      await writeFile(join(path, "package.json"), JSON.stringify(fixture.manifest));

      if (fixture.lockfile) await writeFile(join(path, fixture.lockfile), "");
    }

    const found = await new GitHost().discoverRepositories(root);
    expect(found.map((repository) => [repository.name, repository.checks])).toMatchObject([
      ["bun-app", [{ command: "bun", args: ["run", "test"] }]],
      ["declared", [{ command: "yarn", args: ["test"] }]],
      ["npm-app", [{ command: "npm", args: ["run", "test"] }]],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
