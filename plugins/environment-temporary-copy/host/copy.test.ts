import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendChunk,
  applyCopyBack,
  applyOriginPack,
  confirmCopyBack,
  copiesRoot,
  digestFile,
  insideRoot,
  listCopyRefs,
  listSideRefShas,
  materializeCopy,
  prepareOriginCheckout,
  readOriginCheckout,
  readChunk,
  recordUnsavedWork,
  relayRoot,
  removeCopy,
  removeOriginCheckout,
  resolveBaseCommit,
  sideRefName,
  sweepRelay,
  writeCopyBackPack,
  writeOriginPack,
  writeSnapshotPack,
} from "./copy.js";

const THREAD = "thr_copytest";

const BRANCH = "omnyo/plan-the-week-thr_copytest";

const BASE_REF = `omnyo-base/${THREAD}`;

const CHUNK = 64;

let root: string;

const savedEnv: Record<string, string | undefined> = {};

const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "init.defaultBranch",
  GIT_CONFIG_VALUE_1: "main",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitEnv },
  }).trim();
}

beforeEach(async () => {
  for (const [key, value] of Object.entries(gitEnv)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  root = await realpath(await mkdtemp(join(tmpdir(), "omnyo-temporary-copy-")));
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  await rm(root, { recursive: true, force: true });
});

async function origin(): Promise<string> {
  const path = join(root, "origin");
  run(root, "init", "-q", path);
  await writeFile(join(path, "a.txt"), "one\n");
  run(path, "add", "a.txt");
  run(path, "commit", "-qm", "first");
  await writeFile(join(path, "b.txt"), "two\n");
  run(path, "add", "b.txt");
  run(path, "commit", "-qm", "second");

  return path;
}

async function relay(from: string, to: string): Promise<void> {
  const { size } = await stat(from);

  for (let offset = 0; offset < Math.max(size, 1); offset += CHUNK) {
    const chunk = await readChunk(from, offset, CHUNK);
    await appendChunk({ file: to, offset, ...chunk });
  }
}

async function copyOf(source: string) {
  const baseCommit = await resolveBaseCommit(source, { kind: "default" });
  const snapshot = join(root, "relay-origin", "snap.pack");

  const digest = await writeSnapshotPack({
    sourcePath: source,
    commit: baseCommit,
    packFile: snapshot,
  });

  const received = join(root, "relay-target", "snap.pack");
  await relay(snapshot, received);
  const copyPath = join(copiesRoot(join(root, "target")), "key-1");

  await materializeCopy({
    packFile: received,
    digest,
    copyPath,
    branch: BRANCH,
    baseRef: BASE_REF,
    baseCommit,
  });

  return { baseCommit, copyPath };
}

async function keepFiles(repo: string): Promise<string[]> {
  const entries = await readdir(join(repo, ".git", "objects", "pack"));

  return entries.filter((entry) => entry.endsWith(".keep"));
}

async function packObjectCount(file: string): Promise<number> {
  return (await readFile(file)).readUInt32BE(8);
}

async function copyBack(source: string, copyPath: string, baseCommit: string) {
  const refs = await listCopyRefs(copyPath, BASE_REF, baseCommit);
  const haves = await listSideRefShas({ sourcePath: source, threadId: THREAD });
  const outgoing = join(root, "relay-target", "back.pack");

  const digest = await writeCopyBackPack({
    copyPath,
    baseCommit,
    refs,
    haves,
    packFile: outgoing,
  });

  const objects = await packObjectCount(outgoing);
  const incoming = join(root, "relay-origin", "back.pack");
  await relay(outgoing, incoming);

  const result = await applyCopyBack({
    sourcePath: source,
    packFile: incoming,
    digest,
    threadId: THREAD,
    branch: BRANCH,
    baseCommit,
    refs,
  });

  return { refs, result, objects };
}

describe("temporary copy", () => {
  it("recreates the exact base commit on the target as a shallow copy", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);

    expect(baseCommit).toBe(run(source, "rev-parse", "HEAD"));
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(run(copyPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(run(copyPath, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await readFile(join(copyPath, "b.txt"), "utf8")).toBe("two\n");
    expect(run(copyPath, "status", "--porcelain")).toBe("");
  });

  it("refuses a corrupted chunk", async () => {
    const file = join(root, "x.pack");

    await expect(
      appendChunk({
        file,
        offset: 0,
        dataBase64: Buffer.from("abc").toString("base64"),
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/checksum/u);
  });

  it("copies commits, HEAD and unsaved work back without touching the origin working tree", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");
    await writeFile(join(copyPath, "draft.txt"), "unsaved\n");

    expect(await recordUnsavedWork(copyPath)).not.toBeNull();

    const { refs, result } = await copyBack(source, copyPath, baseCommit);
    const tip = run(copyPath, "rev-parse", "HEAD");

    expect(result.branchUpdated).toBe(true);
    expect(run(source, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
    expect(run(source, "rev-parse", sideRefName(THREAD, "HEAD"))).toBe(tip);
    expect(
      run(
        source,
        "show",
        `${sideRefName(THREAD, "refs/omnyo/unsaved")}:draft.txt`,
      ),
    ).toBe("unsaved");
    expect(run(source, "status", "--porcelain")).toBe("");
    expect(run(source, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await expect(keepFiles(source)).resolves.toEqual([]);
    await expect(keepFiles(copyPath)).resolves.toEqual([]);
    await expect(
      confirmCopyBack({
        sourcePath: source,
        threadId: THREAD,
        baseCommit,
        refs,
      }),
    ).resolves.toBe(true);
  });

  it("preserves a detached HEAD and a stash", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "a.txt"), "stashed\n");
    run(copyPath, "stash", "-q");
    const stash = run(copyPath, "rev-parse", "refs/stash");
    run(copyPath, "checkout", "-q", "--detach");
    await writeFile(join(copyPath, "d.txt"), "detached\n");
    run(copyPath, "add", "d.txt");
    run(copyPath, "commit", "-qm", "detached work");
    const detached = run(copyPath, "rev-parse", "HEAD");

    const { refs } = await copyBack(source, copyPath, baseCommit);

    expect(run(source, "rev-parse", sideRefName(THREAD, "HEAD"))).toBe(
      detached,
    );
    expect(run(source, "rev-parse", sideRefName(THREAD, "refs/stash"))).toBe(
      stash,
    );
    expect(
      run(source, "show", `${sideRefName(THREAD, "refs/stash")}:a.txt`),
    ).toBe("stashed");
    await expect(
      confirmCopyBack({
        sourcePath: source,
        threadId: THREAD,
        baseCommit,
        refs,
      }),
    ).resolves.toBe(true);
  });

  it("syncs a copy with nothing new", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);

    const first = await copyBack(source, copyPath, baseCommit);
    const second = await copyBack(source, copyPath, baseCommit);

    expect(first.result.branchUpdated).toBe(true);
    expect(second.result.branchUpdated).toBe(true);
    expect(run(source, "rev-parse", `refs/heads/${BRANCH}`)).toBe(baseCommit);
    await expect(keepFiles(source)).resolves.toEqual([]);
  });

  it("keeps a rewritten branch on a side ref instead of moving the origin branch", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");
    await copyBack(source, copyPath, baseCommit);
    const first = run(source, "rev-parse", `refs/heads/${BRANCH}`);

    run(copyPath, "commit", "--amend", "-qm", "third, rewritten");
    const { result } = await copyBack(source, copyPath, baseCommit);
    const rewritten = run(copyPath, "rev-parse", "HEAD");

    expect(result.branchUpdated).toBe(false);
    expect(run(source, "rev-parse", `refs/heads/${BRANCH}`)).toBe(first);
    expect(
      run(source, "rev-parse", sideRefName(THREAD, `refs/heads/${BRANCH}`)),
    ).toBe(rewritten);
    expect(
      run(
        source,
        "rev-parse",
        `${sideRefName(THREAD, `refs/heads/${BRANCH}`)}@${first.slice(0, 12)}`,
      ),
    ).toBe(first);
  });

  it("leaves a branch alone when an origin worktree has it checked out", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    run(
      source,
      "worktree",
      "add",
      "-q",
      "-b",
      BRANCH,
      join(root, "busy"),
      baseCommit,
    );
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");

    const { result } = await copyBack(source, copyPath, baseCommit);

    expect(result.branchUpdated).toBe(false);
    expect(run(source, "rev-parse", `refs/heads/${BRANCH}`)).toBe(baseCommit);
    expect(run(source, "rev-parse", sideRefName(THREAD, "HEAD"))).toBe(
      run(copyPath, "rev-parse", "HEAD"),
    );
  });

  it("removes only paths inside the copies directory", async () => {
    const dataDir = join(root, "target");

    await expect(
      removeCopy({ dataDir, path: join(root, "origin") }),
    ).rejects.toThrow(/not a temporary copy/u);

    const inside = join(copiesRoot(dataDir), "key-2");
    await writeFile(join(root, "marker"), "x");
    await removeCopy({ dataDir, path: inside });
    await expect(digestFile(join(root, "marker"))).resolves.toMatchObject({
      size: 1,
    });
  });
});

describe("temporary copy safety", () => {
  it("preserves every stash entry, not only the newest", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "a.txt"), "first stash\n");
    run(copyPath, "stash", "-q");
    const older = run(copyPath, "rev-parse", "refs/stash");
    await writeFile(join(copyPath, "a.txt"), "second stash\n");
    run(copyPath, "stash", "-q");

    const { refs } = await copyBack(source, copyPath, baseCommit);

    expect(
      run(
        source,
        "show",
        `${sideRefName(THREAD, `refs/omnyo/stash-entry/${older}`)}:a.txt`,
      ),
    ).toBe("first stash");
    await expect(
      confirmCopyBack({
        sourcePath: source,
        threadId: THREAD,
        baseCommit,
        refs,
      }),
    ).resolves.toBe(true);
  });

  it("keeps syncing after a branch is replaced by a nested branch name", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    run(copyPath, "branch", "fix");
    await copyBack(source, copyPath, baseCommit);
    run(copyPath, "branch", "-D", "fix");
    run(copyPath, "branch", "fix/login");

    await copyBack(source, copyPath, baseCommit);

    expect(
      run(source, "rev-parse", sideRefName(THREAD, "refs/heads/fix/login")),
    ).toBe(baseCommit);
  });

  it("sends only objects the original machine does not have yet", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");

    const first = await copyBack(source, copyPath, baseCommit);
    const second = await copyBack(source, copyPath, baseCommit);

    expect(first.objects).toBeGreaterThan(0);
    expect(second.objects).toBe(0);
    expect(second.result.branchUpdated).toBe(true);
  });

  it("refuses to record unsaved work that sits in a nested repository", async () => {
    const source = await origin();
    const { copyPath } = await copyOf(source);
    const nested = join(copyPath, "vendor", "lib");
    run(copyPath, "init", "-q", nested);
    await writeFile(join(nested, "x.txt"), "nested\n");
    run(nested, "add", "x.txt");
    run(nested, "commit", "-qm", "nested");

    await expect(recordUnsavedWork(copyPath)).rejects.toThrow(/vendor\/lib/u);
  });

  it("keeps commits made on the base branch", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    run(copyPath, "checkout", "-q", BASE_REF);
    await writeFile(join(copyPath, "d.txt"), "on base\n");
    run(copyPath, "add", "d.txt");
    run(copyPath, "commit", "-qm", "on base");
    const moved = run(copyPath, "rev-parse", "HEAD");
    run(copyPath, "checkout", "-q", BRANCH);

    await expect(
      listCopyRefs(copyPath, BASE_REF, baseCommit),
    ).resolves.toContainEqual({ name: `refs/heads/${BASE_REF}`, sha: moved });
    await expect(
      listCopyRefs(copyPath, BASE_REF, moved),
    ).resolves.not.toContainEqual({
      name: `refs/heads/${BASE_REF}`,
      sha: moved,
    });
  });

  it("ignores relay files that vanish during a sweep", async () => {
    const dataDir = join(root, "sweep");
    await mkdir(relayRoot(dataDir), { recursive: true });
    await symlink(join(root, "missing"), join(relayRoot(dataDir), "gone.pack"));

    await expect(sweepRelay(dataDir, 0, Date.now())).resolves.toBeUndefined();
  });

  it("recovers from an index lock a crashed attempt left behind", async () => {
    const source = await origin();
    const { copyPath } = await copyOf(source);
    await writeFile(join(copyPath, ".git", "omnyo-unsaved-index.lock"), "");
    await writeFile(join(copyPath, "draft.txt"), "unsaved\n");

    await expect(recordUnsavedWork(copyPath)).resolves.not.toBeNull();
  });

  it("records the same unsaved work as the same commit", async () => {
    const source = await origin();
    const { copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "draft.txt"), "unsaved\n");

    const first = await recordUnsavedWork(copyPath);
    await delay(1100);

    await expect(recordUnsavedWork(copyPath)).resolves.toBe(first);
  });

  it("removes keep files an interrupted sync left behind and no others", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    const packs = join(source, ".git", "objects", "pack");
    const stale = `pack-${"0".repeat(40)}.keep`;
    const foreign = `pack-${"1".repeat(40)}.keep`;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await mkdir(packs, { recursive: true });
    await writeFile(join(packs, stale), "omnyo-temporary-copy\n");
    await writeFile(join(packs, foreign), "kept by the owner\n");
    await utimes(join(packs, stale), old, old);
    await utimes(join(packs, foreign), old, old);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");

    await copyBack(source, copyPath, baseCommit);

    await expect(keepFiles(source)).resolves.toEqual([foreign]);
  });

  it("leaves a branch alone while an origin worktree is rebasing it", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    const busy = join(root, "busy");
    run(source, "worktree", "add", "-q", "-b", BRANCH, busy, baseCommit);
    run(busy, "checkout", "-q", "--detach");
    const gitDir = run(busy, "rev-parse", "--absolute-git-dir");
    await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
    await writeFile(
      join(gitDir, "rebase-merge", "head-name"),
      `refs/heads/${BRANCH}\n`,
    );
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");

    const { result } = await copyBack(source, copyPath, baseCommit);

    expect(result.branchUpdated).toBe(false);
    expect(run(source, "rev-parse", `refs/heads/${BRANCH}`)).toBe(baseCommit);
  });

  it("treats only real descendants as inside the copies directory", () => {
    const base = join(root, "copies");

    expect(insideRoot(base, join(base, "key-1"))).toBe(true);
    expect(insideRoot(base, base)).toBe(false);
    expect(insideRoot(base, join(root, "elsewhere"))).toBe(false);
  });
});

describe("original-machine checkout", () => {
  const ORIGIN_DATA = () => join(root, "origin-data");

  async function syncedCopy() {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");
    await writeFile(join(copyPath, "a.txt"), "edited in the copy\n");
    await writeFile(join(copyPath, "untracked.txt"), "new file\n");
    const unsaved = await recordUnsavedWork(copyPath);
    await copyBack(source, copyPath, baseCommit);
    const head = run(copyPath, "rev-parse", "HEAD");

    return { source, copyPath, baseCommit, head, unsaved };
  }

  it("checks out the copy's commits and uncommitted work on the original machine", async () => {
    const { source, head, unsaved } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    expect(run(path, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(
      "edited in the copy\n",
    );
    expect(
      run(path, "status", "--porcelain")
        .split("\n")
        .map((line) => line.trim())
        .sort(),
    ).toEqual(["?? untracked.txt", "M a.txt"]);
    expect(run(source, "worktree", "list", "--porcelain")).toContain(path);
    expect(run(source, "status", "--porcelain")).toBe("");
  });

  it("resets a reused checkout to the copy's latest state", async () => {
    const { source, copyPath, baseCommit, head, unsaved } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    await writeFile(join(path, "stray.txt"), "left by a command\n");
    run(copyPath, "checkout", "-q", "--", "a.txt");
    await rm(join(copyPath, "untracked.txt"));
    await writeFile(join(copyPath, "d.txt"), "four\n");
    run(copyPath, "add", "d.txt");
    run(copyPath, "commit", "-qm", "fourth");
    await copyBack(source, copyPath, baseCommit);
    const next = run(copyPath, "rev-parse", "HEAD");

    await expect(
      prepareOriginCheckout({
        dataDir,
        sourcePath: source,
        threadId: THREAD,
        head: next,
        unsaved: null,
      }),
    ).resolves.toMatchObject({ path });
    expect(run(path, "rev-parse", "HEAD")).toBe(next);
    expect(run(path, "status", "--porcelain")).toBe("");
  });

  async function originCommit(path: string, file: string, text: string) {
    await writeFile(join(path, file), text);
    run(path, "add", file);
    run(path, "commit", "-qm", `origin ${file}`);

    return run(path, "rev-parse", "HEAD");
  }

  async function pull(
    source: string,
    copyPath: string,
    tip: string,
    base: string,
  ) {
    const outgoing = join(root, "relay-origin", "pull.pack");

    const digest = await writeOriginPack({
      sourcePath: source,
      tip,
      base,
      packFile: outgoing,
    });

    const incoming = join(root, "relay-target", "pull.pack");
    await relay(outgoing, incoming);

    return applyOriginPack({
      copyPath,
      packFile: incoming,
      digest,
      tip,
      expectedHead: base,
    });
  }

  it("brings a commit made on the original machine back into the copy", async () => {
    const { source, copyPath, head } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const tip = await originCommit(path, "o.txt", "from the original\n");

    await expect(
      readOriginCheckout({
        dataDir: ORIGIN_DATA(),
        sourcePath: source,
        threadId: THREAD,
        base: head,
      }),
    ).resolves.toEqual({
      head: tip,
      changes: [],
      newCommits: true,
      keptAt: ORIGIN_HEAD,
    });
    await expect(pull(source, copyPath, tip, head)).resolves.toEqual({
      fastForwarded: true,
    });
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(tip);
    expect(await readFile(join(copyPath, "o.txt"), "utf8")).toBe(
      "from the original\n",
    );
    expect(await readFile(join(copyPath, "a.txt"), "utf8")).toBe(
      "edited in the copy\n",
    );
  });

  it("lists only the uncommitted changes a command left, not the copy's own", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "c.txt"), "three\n");
    run(copyPath, "add", "c.txt");
    run(copyPath, "commit", "-qm", "third");
    await writeFile(join(copyPath, "a.txt"), "edited in the copy\n");
    await rm(join(copyPath, "b.txt"));
    await writeFile(join(copyPath, "untracked.txt"), "new file\n");
    const unsaved = await recordUnsavedWork(copyPath);
    await copyBack(source, copyPath, baseCommit);
    const head = run(copyPath, "rev-parse", "HEAD");
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    await expect(
      readOriginCheckout({
        dataDir,
        sourcePath: source,
        threadId: THREAD,
        base: head,
      }),
    ).resolves.toEqual({
      head,
      changes: [],
      newCommits: false,
      keptAt: null,
    });

    await writeFile(join(path, "a.txt"), "changed by a command\n");
    await rm(join(path, "c.txt"));
    await writeFile(join(path, "untracked.txt"), "changed by a command\n");
    await mkdir(join(path, "build"));
    await writeFile(join(path, "build", "out.txt"), "output\n");
    const tip = await originCommit(path, "o.txt", "committed by a command\n");

    const after = await readOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      base: head,
    });

    expect(after?.head).toBe(tip);
    expect(after?.changes.sort()).toEqual([
      "a.txt",
      "build/",
      "c.txt",
      "untracked.txt",
    ]);
  });

  it("still reads a checkout that a command left in a conflicted merge", async () => {
    const { source, head } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const side = await originCommit(path, "c.txt", "side\n");
    run(path, "checkout", "-q", "--detach", head);
    const tip = await originCommit(path, "c.txt", "main\n");
    expect(() => run(path, "merge", "-q", side)).toThrow();

    await expect(
      readOriginCheckout({
        dataDir,
        sourcePath: source,
        threadId: THREAD,
        base: head,
      }),
    ).resolves.toEqual({
      head: tip,
      changes: ["c.txt"],
      newCommits: true,
      keptAt: ORIGIN_HEAD,
    });
  });

  it("lists every uncommitted change when the checkout has no record of what was sent", async () => {
    const { source, head, unsaved } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    run(path, "update-ref", "-d", "refs/worktree/omnyo-sent");

    const result = await readOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      base: head,
    });

    expect(result?.changes.sort()).toEqual(["a.txt", "untracked.txt"]);
  });

  it("keeps a commit it cannot fast-forward to on a side ref", async () => {
    const { source, copyPath, head } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const tip = await originCommit(path, "a.txt", "changed on the original\n");

    await expect(pull(source, copyPath, tip, head)).resolves.toEqual({
      fastForwarded: false,
    });
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(head);
    expect(run(copyPath, "rev-parse", "refs/omnyo/from-origin")).toBe(tip);
    expect(await readFile(join(copyPath, "a.txt"), "utf8")).toBe(
      "edited in the copy\n",
    );
  });

  const ORIGIN_HEAD = `refs/omnyo/temporary-copy/${THREAD}/origin-HEAD`;

  async function mergeOfOldHistory(path: string, head: string) {
    const first = run(path, "rev-list", "--max-parents=0", "HEAD");
    run(path, "checkout", "-q", "--detach", first);
    await writeFile(join(path, "old.txt"), "built on old history\n");
    run(path, "add", "old.txt");
    run(path, "commit", "-qm", "old branch");
    const old = run(path, "rev-parse", "HEAD");
    run(path, "checkout", "-q", "--detach", head);
    run(path, "merge", "-q", "--no-ff", "-m", "merge old branch", old);

    return run(path, "rev-parse", "HEAD");
  }

  it("keeps commits a step made when its checkout is removed before they came back", async () => {
    const { source, head } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const tip = await originCommit(path, "o.txt", "made by a detached step\n");

    await removeOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
    });

    expect(run(source, "rev-parse", ORIGIN_HEAD)).toBe(tip);
  });

  it("keeps commits an earlier step made when a new run resets the checkout", async () => {
    const { source, head } = await syncedCopy();

    const args = {
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    };

    const { path } = await prepareOriginCheckout(args);
    const tip = await originCommit(path, "o.txt", "never pulled\n");

    await prepareOriginCheckout(args);

    expect(run(path, "rev-parse", "HEAD")).toBe(head);
    expect(run(source, "rev-parse", ORIGIN_HEAD)).toBe(tip);
  });

  it("refuses commits whose history this shallow copy lacks instead of reporting a fast-forward", async () => {
    const { source, copyPath, head } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const tip = await mergeOfOldHistory(path, head);

    await expect(pull(source, copyPath, tip, head)).rejects.toThrow(
      /history this copy does not have/u,
    );
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(head);
  });

  it("keeps copy-back working when a step's commits cannot come back", async () => {
    const { source, copyPath, baseCommit, head } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    const tip = await mergeOfOldHistory(path, head);
    await writeFile(join(copyPath, "d.txt"), "four\n");
    run(copyPath, "add", "d.txt");
    run(copyPath, "commit", "-qm", "fourth");

    await expect(pull(source, copyPath, tip, head)).rejects.toThrow(
      /history this copy does not have/u,
    );
    expect(() =>
      run(copyPath, "rev-parse", "--verify", "-q", "refs/omnyo/from-origin"),
    ).toThrow();
    await expect(copyBack(source, copyPath, baseCommit)).resolves.toMatchObject(
      { result: { branchUpdated: true } },
    );
  });

  it("clears a rebase a step left stopped, so the chat branch moves again", async () => {
    const { source, copyPath, baseCommit, head } = await syncedCopy();

    const args = {
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    };

    const { path } = await prepareOriginCheckout(args);
    run(path, "checkout", "-q", "--detach", baseCommit);
    await writeFile(join(path, "c.txt"), "conflicting\n");
    run(path, "add", "c.txt");
    run(path, "commit", "-qm", "conflicting c");
    const onto = run(path, "rev-parse", "HEAD");
    run(path, "checkout", "-q", BRANCH);
    expect(() => run(path, "rebase", "-q", onto)).toThrow();

    await prepareOriginCheckout(args);
    await writeFile(join(copyPath, "d.txt"), "four\n");
    run(copyPath, "add", "d.txt");
    run(copyPath, "commit", "-qm", "fourth");
    const { result } = await copyBack(source, copyPath, baseCommit);

    expect(result.branchUpdated).toBe(true);
    expect(run(path, "status")).not.toContain("rebase in progress");
  });

  it("locks its checkout so storage cleanup leaves it alone", async () => {
    const { source, head } = await syncedCopy();

    await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    expect(run(source, "worktree", "list", "--porcelain")).toContain(
      `locked omnyo temporary copy ${THREAD}`,
    );
  });

  it("removes the registration of a checkout whose folder is already gone", async () => {
    const { source, head } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    await rm(path, { recursive: true, force: true });
    await removeOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
    });

    expect(run(source, "worktree", "list", "--porcelain")).not.toContain(
      "origin-checkouts",
    );
  });

  it("fast-forwards the copy when a step commits exactly the changes it was sent", async () => {
    const { source, copyPath, head, unsaved } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    run(path, "add", "-A");
    run(path, "commit", "-qm", "commit the sent work");
    const tip = run(path, "rev-parse", "HEAD");

    await expect(pull(source, copyPath, tip, head)).resolves.toEqual({
      fastForwarded: true,
    });
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(tip);
    expect(run(copyPath, "status", "--porcelain")).toBe("");
  });

  it("replaces the unsaved-work snapshot instead of keeping each earlier one", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await writeFile(join(copyPath, "a.txt"), "first edit\n");
    await recordUnsavedWork(copyPath);
    await copyBack(source, copyPath, baseCommit);
    await writeFile(join(copyPath, "a.txt"), "second edit\n");
    const second = await recordUnsavedWork(copyPath);
    await copyBack(source, copyPath, baseCommit);

    const names = run(
      source,
      "for-each-ref",
      "--format=%(refname)",
      `refs/omnyo/temporary-copy/${THREAD}/`,
    ).split("\n");

    expect(names.filter((name) => name.includes("unsaved"))).toEqual([
      `refs/omnyo/temporary-copy/${THREAD}/unsaved`,
    ]);
    expect(
      run(source, "rev-parse", `refs/omnyo/temporary-copy/${THREAD}/unsaved`),
    ).toBe(second);
  });

  it("keeps such a commit on a side ref when the copy changed after the run started", async () => {
    const { source, copyPath, head, unsaved } = await syncedCopy();

    const { path } = await prepareOriginCheckout({
      dataDir: ORIGIN_DATA(),
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved,
    });

    run(path, "add", "-A");
    run(path, "commit", "-qm", "commit the sent work");
    const tip = run(path, "rev-parse", "HEAD");
    await writeFile(join(copyPath, "a.txt"), "edited again in the copy\n");

    await expect(pull(source, copyPath, tip, head)).resolves.toEqual({
      fastForwarded: false,
    });
    expect(run(copyPath, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(copyPath, "a.txt"), "utf8")).toBe(
      "edited again in the copy\n",
    );
    expect(run(copyPath, "rev-parse", "refs/omnyo/from-origin")).toBe(tip);
  });

  it("removes only its own checkouts", async () => {
    const { source, head } = await syncedCopy();
    const dataDir = ORIGIN_DATA();

    const { path } = await prepareOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    });

    await writeFile(join(path, "stray.txt"), "left by a command\n");

    await expect(
      removeOriginCheckout({
        dataDir,
        sourcePath: source,
        threadId: "../escape",
      }),
    ).rejects.toThrow(/Invalid temporary-copy ref owner/u);
    await removeOriginCheckout({
      dataDir,
      sourcePath: source,
      threadId: THREAD,
    });

    await expect(stat(path)).rejects.toThrow();
    expect(run(source, "worktree", "list", "--porcelain")).not.toContain(
      "origin-checkouts",
    );
  });
});

describe("original-machine checkout recovery", () => {
  it("re-creates a checkout whose folder was deleted while git still lists it", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await copyBack(source, copyPath, baseCommit);
    const head = run(copyPath, "rev-parse", "HEAD");
    const dataDir = join(root, "origin-data");

    const args = {
      dataDir,
      sourcePath: source,
      threadId: THREAD,
      head,
      unsaved: null,
    };

    const { path } = await prepareOriginCheckout(args);
    await rm(path, { recursive: true, force: true });

    await expect(prepareOriginCheckout(args)).resolves.toMatchObject({
      path,
    });
    expect(run(path, "rev-parse", "HEAD")).toBe(head);
  });

  it("keeps an earlier commit it could not fast-forward to", async () => {
    const source = await origin();
    const { baseCommit, copyPath } = await copyOf(source);
    await copyBack(source, copyPath, baseCommit);
    const head = run(copyPath, "rev-parse", "HEAD");
    const dataDir = join(root, "origin-data");
    await writeFile(join(copyPath, "a.txt"), "edited in the copy\n");

    const tips: string[] = [];

    for (const text of ["first origin edit\n", "second origin edit\n"]) {
      const { path } = await prepareOriginCheckout({
        dataDir,
        sourcePath: source,
        threadId: THREAD,
        head,
        unsaved: null,
      });

      await writeFile(join(path, "a.txt"), text);
      run(path, "commit", "-qam", text.trim());
      const tip = run(path, "rev-parse", "HEAD");
      tips.push(tip);
      const outgoing = join(root, "relay-origin", "pull.pack");

      const digest = await writeOriginPack({
        sourcePath: source,
        tip,
        base: head,
        packFile: outgoing,
      });

      const incoming = join(root, "relay-target", "pull.pack");
      await relay(outgoing, incoming);

      await expect(
        applyOriginPack({
          copyPath,
          packFile: incoming,
          digest,
          tip,
          expectedHead: head,
        }),
      ).resolves.toEqual({ fastForwarded: false });
    }

    const [first = "", second = ""] = tips;

    expect(run(copyPath, "rev-parse", "refs/omnyo/from-origin")).toBe(second);
    expect(
      run(
        copyPath,
        "rev-parse",
        `refs/omnyo/from-origin@${first.slice(0, 12)}`,
      ),
    ).toBe(first);
  });
});

describe("owned ref namespace", () => {
  function refs(path: string): string {
    return run(
      path,
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
    );
  }

  it("lists refs from an old namespace as foreign refs without touching them", async () => {
    const path = await origin();
    const head = run(path, "rev-parse", "HEAD");
    run(path, "update-ref", "refs/old-namespace/unsaved", head);
    const before = refs(path);
    const result = await listCopyRefs(path, "main", head);
    expect(result).toContainEqual({
      name: "refs/old-namespace/unsaved",
      sha: head,
    });
    expect(refs(path)).toBe(before);
  });

  it("names side refs from canonical owned refs and opaque foreign refs", () => {
    expect(sideRefName(THREAD, "refs/heads/omnyo/plan")).toBe(
      `refs/omnyo/temporary-copy/${THREAD}/heads%2Fomnyo%2Fplan`,
    );
    expect(sideRefName(THREAD, "refs/old-namespace/foreign")).toBe(
      `refs/omnyo/temporary-copy/${THREAD}/old-namespace%2Fforeign`,
    );
    expect(sideRefName(THREAD, "refs/omnyo/unsaved")).toBe(
      `refs/omnyo/temporary-copy/${THREAD}/unsaved`,
    );
  });

  it.each(["symbolic", "malformed"])(
    "refuses %s owned refs before reading them",
    async (kind) => {
      const path = await origin();
      const head = run(path, "rev-parse", "HEAD");

      if (kind === "symbolic")
        run(path, "symbolic-ref", "refs/omnyo/unsaved", "refs/heads/main");
      else
        run(
          path,
          "update-ref",
          "refs/omnyo/stash-entry/not-an-object-id",
          head,
        );
      const before = refs(path);
      await expect(listCopyRefs(path, "main", head)).rejects.toThrow(
        /owned ref|symbolic|invalid.*ref/iu,
      );
      expect(refs(path)).toBe(before);
    },
  );

  it("reads only the requested thread's side refs", async () => {
    const path = await origin();
    const head = run(path, "rev-parse", "HEAD");
    const older = run(path, "rev-parse", "HEAD~1");
    run(path, "update-ref", `refs/omnyo/temporary-copy/${THREAD}/leaf`, head);
    run(
      path,
      "update-ref",
      "refs/omnyo/temporary-copy/thr_foreign/leaf",
      older,
    );
    await expect(
      listSideRefShas({ sourcePath: path, threadId: THREAD }),
    ).resolves.toEqual([head]);
  });
});
