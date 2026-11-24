import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, vi, describe, expect, it } from "vitest";
import {
  detectGitRepo,
  detectGitRepoKind,
  detectLinkedWorktree,
  getCheckoutRef,
  getWorkspaceGitOperation,
  parseNameStatusEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  parsePorcelainV2StatusZ,
  readGitBlob,
  runGit,
  runGitWithNullRecordLimit,
  summarizeNumstat,
} from "../src/git.js";
import {
  initBareWorktreeLayout,
  initConflictRepo,
  initEmptyRepo,
  initReadGitBlobRepo,
  removeTempDirs,
  trackTempDir,
} from "./git-test-repos.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDirs();
});

describe("runGit", () => {
  it("scrubs inherited Omnyo runtime env vars and node mode", async () => {
    const repoPath = await initEmptyRepo();
    vi.stubEnv("OMNYO_DATA_DIR", "/tmp/leaked-omnyo-data");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "external-secret");

    const result = await runGit(
      [
        "-c",
        `alias.env-probe=!printf '%s|%s|%s' "\${OMNYO_DATA_DIR-missing}" "\${NODE_ENV-missing}" "\${OPENAI_API_KEY-missing}"`,
        "env-probe",
      ],
      { cwd: repoPath },
    );

    expect(result.stdout).toBe("missing|missing|external-secret");
  });
});

describe("runGitWithNullRecordLimit", () => {
  it("stops an untracked path listing at the requested complete-record count", async () => {
    const repoPath = await initEmptyRepo();
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        fs.writeFile(path.join(repoPath, `file-${index}.txt`), `${index}\n`),
      ),
    );

    const result = await runGitWithNullRecordLimit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: repoPath },
      "single",
      3,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(3);
    expect(result.stdout.split("\0").filter(Boolean)).toHaveLength(3);
  });

  it("keeps rename records complete when stopping name-status output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--name-status", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "name-status",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNameStatusEntries(result.stdout)).toHaveLength(2);
  });

  it("keeps rename records complete when stopping numstat output", async () => {
    const repoPath = await initReadGitBlobRepo();
    await runGit(["mv", "README.md", "RENAMED.md"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "RENAMED.md"), "hello\nmore\n");
    await fs.writeFile(path.join(repoPath, "docs", "index.md"), "changed\n");
    await fs.rm(path.join(repoPath, "large.txt"));

    const result = await runGitWithNullRecordLimit(
      ["diff", "--numstat", "-M", "-z", "HEAD"],
      { cwd: repoPath },
      "numstat",
      2,
    );

    expect(result.recordLimitReached).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(parseNumstatEntriesZ(result.stdout)).toHaveLength(2);
    expect(parseNumstatEntriesZ(result.stdout)).toContainEqual({
      path: "RENAMED.md",
      insertions: 1,
      deletions: 0,
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not confuse a regular numstat path ending in a tab with a rename",
    async () => {
      const repoPath = await initReadGitBlobRepo();
      const unusualPath = "trailing-tab\t";
      await fs.writeFile(path.join(repoPath, unusualPath), "one\n");
      await runGit(["add", unusualPath], { cwd: repoPath });

      const result = await runGitWithNullRecordLimit(
        ["diff", "--cached", "--numstat", "-z", "HEAD"],
        { cwd: repoPath },
        "numstat",
        1,
      );

      expect(result.recordLimitReached).toBe(true);
      expect(result.recordCount).toBe(1);
      expect(parseNumstatEntriesZ(result.stdout)).toEqual([
        { path: unusualPath, insertions: 1, deletions: 0 },
      ]);
    },
  );
});

describe("detectGitRepoKind", () => {
  it("tells a bare repository root apart from its worktrees and plain directories", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();

    const plainDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "omnyo-plain-dir-"),
    );

    trackTempDir(plainDir);

    await expect(detectGitRepoKind(root)).resolves.toBe("bare");
    await expect(detectGitRepoKind(path.join(root, ".bare"))).resolves.toBe(
      "bare",
    );
    await expect(detectGitRepoKind(worktreePath)).resolves.toBe("work-tree");
    await expect(detectGitRepoKind(plainDir)).resolves.toBe("none");
  });

  it("tells a linked worktree apart from an ordinary checkout", async () => {
    const { worktreePath } = await initBareWorktreeLayout();
    const ordinaryCheckout = await initReadGitBlobRepo();

    const plainDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "omnyo-plain-wt-"),
    );

    trackTempDir(plainDir);

    await expect(detectLinkedWorktree(worktreePath)).resolves.toBe(true);
    await expect(detectLinkedWorktree(ordinaryCheckout)).resolves.toBe(false);
    await expect(detectLinkedWorktree(plainDir)).resolves.toBe(false);
  });

  it("keeps detectGitRepo scoped to work trees so bare roots get no checkout UI", async () => {
    const { root, worktreePath } = await initBareWorktreeLayout();

    await expect(detectGitRepo(root)).resolves.toBe(false);
    await expect(detectGitRepo(worktreePath)).resolves.toBe(true);
  });
});

describe("getCheckoutRef", () => {
  it("reports the HEAD branch of a bare repository root", async () => {
    const { root } = await initBareWorktreeLayout();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: root });

    await expect(getCheckoutRef(root)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports branch checkouts with HEAD sha", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "branch",
      branchName: "main",
      headSha: head.stdout.trim(),
    });
  });

  it("reports detached HEAD without pretending there is a current branch", async () => {
    const repoPath = await initReadGitBlobRepo();
    const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
    await runGit(["switch", "--detach", "HEAD"], { cwd: repoPath });

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "detached",
      headSha: head.stdout.trim(),
    });
  });

  it("reports unborn branches for empty repositories", async () => {
    const repoPath = await initEmptyRepo();

    await expect(getCheckoutRef(repoPath)).resolves.toEqual({
      kind: "unborn",
      branchName: "main",
    });
  });
});

describe("getWorkspaceGitOperation", () => {
  it("reports no operation for ordinary repositories", async () => {
    const repoPath = await initReadGitBlobRepo();

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "none",
    });
  });

  it("reports merge conflicts", async () => {
    const repoPath = await initConflictRepo();

    const merge = await runGit(["merge", "feature"], {
      cwd: repoPath,
      allowFailure: true,
    });

    expect(merge.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "merge",
      hasConflicts: true,
    });
  });

  it("reports rebase conflicts", async () => {
    const repoPath = await initConflictRepo();
    await runGit(["switch", "feature"], { cwd: repoPath });

    const rebase = await runGit(["rebase", "main"], {
      cwd: repoPath,
      allowFailure: true,
    });

    expect(rebase.exitCode).not.toBe(0);

    await expect(getWorkspaceGitOperation(repoPath)).resolves.toEqual({
      kind: "rebase",
      hasConflicts: true,
    });
  });
});

describe("command timeouts", () => {
  it("classifies git command timeouts as hard failures when allowFailure is true", async () => {
    const repoPath = await initEmptyRepo();

    await fs.writeFile(path.join(repoPath, ".git", "packed-refs.lock"), "");
    await expect(
      runGit(["-c", "core.packedRefsTimeout=10000", "pack-refs", "--all"], {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      code: "git_command_timeout",
      name: "WorkspaceError",
    });
  });
});

describe("user-shell Git resolution", () => {
  it("uses the resolved shell PATH for Git commands", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "omnyo-git-shell-path-workspace-"),
    );

    const binPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "omnyo-git-shell-path-bin-"),
    );

    trackTempDir(workspacePath, binPath);

    await fs.writeFile(
      path.join(binPath, process.platform === "win32" ? "git.cmd" : "git"),
      process.platform === "win32"
        ? "@echo off\r\necho user-shell-git\r\n"
        : "#!/bin/sh\nprintf 'user-shell-git\\n'\n",
      { mode: 0o755 },
    );

    if (process.platform === "win32") {
      await fs.writeFile(
        path.join(binPath, "git"),
        "#!/bin/sh\nprintf 'user-shell-git\\n'\n",
        { mode: 0o755 },
      );
    }

    await expect(
      runGit(["--version"], { cwd: workspacePath, shellPath: binPath }),
    ).resolves.toMatchObject({
      stdout: expect.stringMatching(/^user-shell-git\r?\n$/),
    });
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

describe("parsePorcelainV2StatusZ", () => {
  const readStatus = async (repoPath: string) =>
    parsePorcelainV2StatusZ(
      (
        await runGit(
          [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
          ],
          { cwd: repoPath },
        )
      ).stdout,
    );

  it.skipIf(process.platform === "win32")(
    "reads renames, unusual paths, and the checked-out commit",
    async () => {
      const repoPath = await initConflictRepo();
      await fs.writeFile(path.join(repoPath, "old name.txt"), "rename me\n");
      await runGit(["add", "."], { cwd: repoPath });
      await runGit(["commit", "-m", "Add file"], { cwd: repoPath });
      await runGit(["mv", "old name.txt", "new -> name.txt"], {
        cwd: repoPath,
      });
      await fs.writeFile(path.join(repoPath, "README.md"), "edited\n");
      await fs.writeFile(path.join(repoPath, "line\nbreak.txt"), "new\n");

      const head = (
        await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
      ).stdout.trim();

      const status = await readStatus(repoPath);

      expect(status.headOid).toBe(head);
      expect(status.headBranch).toBe("main");
      expect(status.entries).toEqual(
        expect.arrayContaining([
          {
            path: "README.md",
            status: "M",
            indexStatus: " ",
            worktreeStatus: "M",
          },
          {
            path: "new -> name.txt",
            status: "R",
            indexStatus: "R",
            worktreeStatus: " ",
          },
          {
            path: "line\nbreak.txt",
            status: "??",
            indexStatus: "?",
            worktreeStatus: "?",
          },
        ]),
      );
      expect(status.entries).toHaveLength(3);

      await runGit(["checkout", "--detach"], { cwd: repoPath });
      expect(await readStatus(repoPath)).toMatchObject({
        headOid: head,
        headBranch: null,
      });
    },
  );

  it("reads unmerged entries during a conflicted merge", async () => {
    const repoPath = await initConflictRepo();
    await runGit(["merge", "feature"], { cwd: repoPath, allowFailure: true });

    expect((await readStatus(repoPath)).entries).toEqual([
      {
        path: "README.md",
        status: "UU",
        indexStatus: "U",
        worktreeStatus: "U",
      },
    ]);
  });

  it("reports an unborn branch without a commit", async () => {
    const repoPath = await initEmptyRepo();
    expect(await readStatus(repoPath)).toEqual({
      entries: [],
      headOid: null,
      headBranch: "main",
    });
  });
});

describe("parsePorcelainEntries", () => {
  it("parses ordinary entries and renamed targets", () => {
    expect(
      parsePorcelainEntries(
        [
          " M README.md",
          "R  old-name.ts -> new-name.ts",
          "D  removed.txt",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "README.md",
        status: "M",
        indexStatus: " ",
        worktreeStatus: "M",
      },
      {
        path: "new-name.ts",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
      {
        path: "removed.txt",
        status: "D",
        indexStatus: "D",
        worktreeStatus: " ",
      },
    ]);
  });

  it("decodes quoted git paths and octal escapes", () => {
    expect(
      parsePorcelainEntries(
        [
          '?? "a b.txt"',
          '?? "quote\\\\and\\\"slash.txt"',
          'R  "old\\040name.txt" -> "new\\040name.txt"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "a b.txt",
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: 'quote\\and"slash.txt',
        status: "??",
        indexStatus: "?",
        worktreeStatus: "?",
      },
      {
        path: "new name.txt",
        status: "R",
        indexStatus: "R",
        worktreeStatus: " ",
      },
    ]);
  });
});

describe("parseNameStatusEntries", () => {
  it("parses add, modify, and delete entries", () => {
    const output = [
      "A",
      "src/new.ts",
      "M",
      "src/existing.ts",
      "D",
      "src/old.ts",
      "",
    ].join("\0");

    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "src/existing.ts", status: "M" },
      { path: "src/old.ts", status: "D" },
    ]);
  });

  it("takes the new path for rename and copy entries", () => {
    const output = [
      "R100",
      "src/old.ts",
      "src/new.ts",
      "C75",
      "src/base.ts",
      "src/copy.ts",
      "",
    ].join("\0");

    expect(parseNameStatusEntries(output)).toEqual([
      { path: "src/new.ts", status: "R" },
      { path: "src/copy.ts", status: "C" },
    ]);
  });

  it("skips truncated trailing entries without throwing", () => {
    expect(parseNameStatusEntries("M\0")).toEqual([]);
    expect(parseNameStatusEntries("R100\0src/old.ts\0")).toEqual([]);
  });
});

describe("summarizeNumstat", () => {
  it("totals changed files, insertions, and deletions", () => {
    expect(
      summarizeNumstat(
        ["10\t4\tREADME.md", "-\t-\tbinary.dat", "2\t0\tsrc/app.ts"].join("\n"),
      ),
    ).toEqual({
      changedFiles: 3,
      insertions: 12,
      deletions: 4,
    });
  });
});

describe("parseNumstatEntriesZ", () => {
  it("parses normal and binary entries from NUL-delimited output", () => {
    const output =
      "10\t4\tREADME.md\0" + "-\t-\tbinary.dat\0" + "2\t0\tsrc/app.ts\0";

    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "README.md", insertions: 10, deletions: 4 },
      { path: "binary.dat", insertions: null, deletions: null },
      { path: "src/app.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("takes the new path for rename entries", () => {
    const output = "3\t1\t\0src/old.ts\0src/new.ts\0" + "5\t2\tsrc/app.ts\0";
    expect(parseNumstatEntriesZ(output)).toEqual([
      { path: "src/new.ts", insertions: 3, deletions: 1 },
      { path: "src/app.ts", insertions: 5, deletions: 2 },
    ]);
  });
});
