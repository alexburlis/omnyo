import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { GitHost } from "../src/git-host";

const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sentry-host-test-"));
  scratch.push(root);
  const source = join(root, "umbrella", "client");
  const sibling = join(root, "umbrella", "server");
  await mkdir(source, { recursive: true });
  await mkdir(sibling);
  git(source, "init", "-b", "main");
  git(source, "config", "commit.gpgsign", "false");
  git(sibling, "init", "-b", "main");
  await writeFile(join(source, "source.txt"), "base\n");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", "source.txt", ".gitignore");
  git(
    source,
    "-c",
    "user.name=Sentry Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "baseline",
  );
  await writeFile(join(source, "source.txt"), "foreign edit\n");
  await writeFile(join(source, "untracked.txt"), "foreign untracked\n");
  await writeFile(join(source, "ignored.txt"), "foreign ignored\n");

  return { root, source, sibling };
}

describe("repository resource and verification boundary", () => {
  it("creates from the exact child base while preserving all canonical dirty content", async () => {
    const f = await fixture();
    const host = new GitHost();
    const info = await host.inspectRepository(f.source, "main", null);
    const path = join(f.root, "owned-worktree");
    await host.createWorktree(f.source, path, "sentry/example", info.baseSha);
    expect(await readFile(join(path, "source.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(f.source, "source.txt"), "utf8")).toBe("foreign edit\n");
    expect(await readFile(join(f.source, "untracked.txt"), "utf8")).toBe("foreign untracked\n");
    expect(await readFile(join(f.source, "ignored.txt"), "utf8")).toBe("foreign ignored\n");
    expect(git(f.sibling, "status", "--porcelain")).toBe("");
  });

  it("refuses an unknown existing worktree path and an unrelated remote", async () => {
    const f = await fixture();
    const host = new GitHost();
    await expect(host.inspectRepository(f.source, "main", "owner/other")).rejects.toThrow();
    const info = await host.inspectRepository(f.source, "main", null);
    await expect(
      host.createWorktree(f.source, f.sibling, "sentry/example", info.baseSha),
    ).rejects.toThrow();
  });

  it("requires a committed unchanged head and passing fixed verifier before success", async () => {
    const f = await fixture();
    const host = new GitHost();
    const info = await host.inspectRepository(f.source, "main", null);
    const path = join(f.root, "owned-worktree");
    await host.createWorktree(f.source, path, "sentry/example", info.baseSha);
    await writeFile(join(path, "source.txt"), "fixed\n");
    git(path, "add", "source.txt");
    git(
      path,
      "-c",
      "user.name=Sentry Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fix",
    );
    const head = git(path, "rev-parse", "HEAD");

    const checks = [
      {
        name: "real check",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 10000,
      },
    ];

    const receipt = await host.verify(path, info.baseSha, head, ["source.txt"], checks);
    expect(receipt.head).toBe(head);
    expect(receipt.checks[0]?.exitCode).toBe(0);
    await writeFile(join(path, "source.txt"), "late mutation\n");
    await expect(host.verify(path, info.baseSha, head, ["source.txt"], checks)).rejects.toThrow();
  });

  it("refuses cleanup of unique changes and preserves the run branch", async () => {
    const f = await fixture();
    const host = new GitHost();
    const info = await host.inspectRepository(f.source, "main", null);
    const path = join(f.root, "owned-worktree");
    await host.createWorktree(f.source, path, "sentry/example", info.baseSha);
    await writeFile(join(path, "unique.txt"), "unique\n");
    await expect(host.removeWorktree(f.source, path, "sentry/example")).rejects.toThrow();
    expect(await readFile(join(path, "unique.txt"), "utf8")).toBe("unique\n");
    expect(git(f.source, "show-ref", "--verify", "refs/heads/sentry/example")).toContain(
      info.baseSha,
    );
  });
});
