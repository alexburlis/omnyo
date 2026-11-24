import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, vi, describe, expect, it } from "vitest";
import {
  fetchRemoteBranches,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
} from "../src/git.js";
import {
  initDefaultBranchRemoteRepo,
  initReadGitBlobRepo,
  initSshRemoteRepo,
  pushRemoteMainCommit,
  removeTempDirs,
} from "./git-test-repos.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDirs();
});

describe("readDefaultBranchRefs", () => {
  it("reports equal local and origin defaults", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: "equal",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default behind origin", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-behind",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports a local default ahead of origin", async () => {
    const { repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "local-ahead",
      originDefaultBranch: "origin/main",
    });
  });

  it("reports diverged local and origin defaults", async () => {
    const { remotePath, repoPath } = await initDefaultBranchRemoteRepo();
    await fs.writeFile(path.join(repoPath, "local.txt"), "local\n", "utf8");
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Local edit"], { cwd: repoPath });
    await pushRemoteMainCommit(remotePath);
    await runGit(["fetch", "origin"], { cwd: repoPath });

    await expect(readDefaultBranchRefs(repoPath)).resolves.toMatchObject({
      defaultBranch: "main",
      defaultBranchRelation: "diverged",
      originDefaultBranch: "origin/main",
    });
  });

  it("omits origin defaults when no origin ref exists", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(readDefaultBranchRefs(repoPath)).resolves.toEqual({
      defaultBranch: "main",
      defaultBranchRelation: undefined,
      originDefaultBranch: undefined,
    });
  });
});

describe("fetchRemoteBranches", () => {
  it("keeps a non-interactive fetch from prompting for ssh or git credentials", async () => {
    const { repoPath, sshLogPath } = await initSshRemoteRepo();

    await expect(
      fetchRemoteBranches(repoPath, { interactive: false }),
    ).resolves.toEqual({ status: "failed" });

    const log = await fs.readFile(sshLogPath, "utf8");
    expect(log).not.toContain("BatchMode");
    expect(log).toContain("GIT_TERMINAL_PROMPT=0\n");
  });

  it("leaves an interactive fetch free to prompt", async () => {
    const { repoPath, sshLogPath } = await initSshRemoteRepo();

    await expect(
      fetchRemoteBranches(repoPath, { interactive: true }),
    ).resolves.toEqual({ status: "failed" });

    const log = await fs.readFile(sshLogPath, "utf8");
    expect(log).not.toContain("BatchMode");
    expect(log).toContain("GIT_TERMINAL_PROMPT=unset\n");
  });
});

describe("readGitBlob", () => {
  it("reads a blob at a git ref and reports the returned byte size", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "README.md", 1024);

    expect(blob.contents?.toString("utf8")).toBe("hello\n");
    expect(blob.sizeBytes).toBe(Buffer.byteLength("hello\n"));
  });

  it("returns null contents for a missing blob path", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "missing.txt", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("returns null contents for a missing ref", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "missing-ref", "README.md", 1024),
    ).resolves.toEqual({
      contents: null,
      sizeBytes: 0,
    });
  });

  it("rejects non-blob git objects instead of treating them as missing", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "docs", 1024),
    ).rejects.toMatchObject({
      code: "git_command_failed",
    });
  });

  it("allows blobs exactly at the byte cap", async () => {
    const repoPath = await initReadGitBlobRepo();

    const blob = await readGitBlob(repoPath, "HEAD", "large.txt", 11);

    expect(blob.contents?.toString("utf8")).toBe("0123456789\n");
    expect(blob.sizeBytes).toBe(11);
  });

  it("rejects oversized blobs during size preflight", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(
      readGitBlob(repoPath, "HEAD", "large.txt", 4),
    ).rejects.toMatchObject({
      code: "blob_too_large",
      message: "Blob size 11 bytes exceeds the 0 MB limit",
    });
  });
});
