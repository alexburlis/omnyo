import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  access,
  realpath,
  mkdir,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectRepo as inspectFullRepo,
  inspectCleanupRepo,
  inspectSidebarRepo,
  purgeWorktree,
  deleteBranch,
  fileDiff,
  discover,
} from "../git.js";
import { runCleanup } from "../cleanup.js";
import { planCleanup } from "../cleanup-plan.js";

let eligibilityComparisons = 0;

async function inspectRepo(
  path: string,
  protectedPaths: string[],
  includeStorage = true,
) {
  const full = await inspectFullRepo(path, protectedPaths, includeStorage);
  const cleanup = await inspectCleanupRepo(path, protectedPaths);

  const plan = (repo: typeof full) =>
    planCleanup([{ projectId: "fixture", projectName: "Fixture", repo }]).map(
      (item) => ({
        kind: item.kind,
        target: item.target,
        head: item.head,
        base: item.base,
      }),
    );

  assert.deepEqual(
    plan(cleanup),
    plan(full),
    "Cleanup inspection preserves full safety eligibility",
  );
  eligibilityComparisons++;

  return full;
}

const root = await realpath(
  await mkdtemp(join(tmpdir(), "local-worktrees-proof-")),
);

const repo = join(root, "repo");

const evidenceDirectory = process.env.LOCAL_WORKTREES_EVIDENCE ?? "evidence";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "file.txt"), "original\n");
  await writeFile(join(repo, ".gitignore"), "ignored\n");
  await writeFile(join(repo, "rename-me.txt"), "tracked\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const wt = join(root, "feature");
  git(repo, "worktree", "add", "-b", "feature", wt);
  let state = await inspectRepo(repo, []);
  assert.equal(state.worktrees.find((w) => w.path === wt)?.purgeReady, true);
  assert.equal(state.worktrees[0].purgeReady, false);
  await writeFile(join(wt, "ignored"), "irreplaceable");
  state = await inspectRepo(repo, []);
  assert.equal(state.worktrees.find((w) => w.path === wt)?.purgeReady, false);
  await assert.rejects(() =>
    purgeWorktree(repo, wt, git(wt, "rev-parse", "HEAD"), []),
  );
  const next = join(root, "next");
  git(repo, "worktree", "add", "-b", "next", next);
  await writeFile(join(next, "file.txt"), "changed\n");
  state = await inspectRepo(repo, []);
  assert.equal(state.worktrees.find((w) => w.path === next)?.dirty, true);
  assert.match(
    (await fileDiff(repo, next, "main", "working", "file.txt")).patch,
    /\+changed/,
  );
  git(next, "mv", "rename-me.txt", "renamed.txt");
  await mkdir(join(next, "new-folder"));
  await writeFile(join(next, "new-folder", "one.txt"), "one");
  await writeFile(join(next, "new-folder", "two\nlines.txt"), "two");

  const editedFiles = (await inspectRepo(repo, [])).worktrees.find(
    (w) => w.path === next,
  )!.dirtyFiles;

  assert.deepEqual(
    [...editedFiles].sort(),
    [
      "file.txt",
      "renamed.txt",
      "new-folder/one.txt",
      "new-folder/two\nlines.txt",
    ].sort(),
  );
  const payloadBytes = 256 * 1024;
  await writeFile(join(next, "payload.bin"), Buffer.alloc(payloadBytes, 1));
  git(next, "add", ".");
  git(next, "commit", "-m", "unique");
  state = await inspectRepo(repo, []);
  assert.equal(state.branches.find((b) => b.name === "next")?.ahead, 1);
  assert.equal(state.worktrees.find((w) => w.path === next)?.purgeReady, false);
  git(repo, "merge", "--ff-only", "next");
  state = await inspectRepo(repo, [next]);
  assert.equal(state.worktrees.find((w) => w.path === next)?.purgeReady, false);
  git(repo, "worktree", "lock", next);
  assert.equal(
    (await inspectRepo(repo, [])).worktrees.find((w) => w.path === next)
      ?.purgeReady,
    false,
  );
  git(repo, "worktree", "unlock", next);
  await assert.rejects(() => purgeWorktree(repo, next, "stale", []));
  const head = git(next, "rev-parse", "HEAD");
  const purged = await purgeWorktree(repo, next, head, []);
  assert.ok(
    purged.freedBytes !== null && purged.freedBytes >= payloadBytes,
    `Folder removal reports the measured space it freed: ${purged.freedBytes}`,
  );
  await assert.rejects(() => access(next));
  assert.equal(git(repo, "rev-parse", "next"), head);
  await writeFile(
    join(root, ".git"),
    "gitdir: /nonexistent-local-worktree-fixture\n",
  );
  assert.ok(
    (await discover([root])).repos.some(
      (path) =>
        git(path, "rev-parse", "--path-format=absolute", "--git-common-dir") ===
        join(repo, ".git"),
    ),
    "Broken outer Git metadata must not hide nested repos",
  );
  git(repo, "update-index", "--assume-unchanged", "file.txt");
  const guarded = join(root, "guarded");
  git(repo, "worktree", "add", "-b", "guarded", guarded);
  git(guarded, "update-index", "--assume-unchanged", "file.txt");
  await writeFile(join(guarded, "file.txt"), "hidden edit\n");
  assert.equal(
    (await inspectRepo(repo, [])).worktrees.find((w) => w.path === guarded)
      ?.purgeReady,
    false,
  );
  const nested = join(repo, "nested", "child");
  await mkdir(nested, { recursive: true });
  execFileSync("git", ["init", "-b", "main", nested]);
  const discovered = await discover([repo, wt]);
  assert.equal(discovered.repos.length, 2);
  assert.ok(discovered.repos.includes(nested));
  assert.ok((await discover([wt, repo])).repos.includes(nested));
  git(repo, "tag", "main");
  assert.ok(
    (await inspectRepo(repo, [])).branches.some(
      (branch) => branch.name === "main",
    ),
    "Same-named tag must not change branch identity",
  );

  for (const cache of [".pnpm-store", "uv-cache", ".uv-cache"]) {
    const store = join(repo, cache, "not-a-project");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, ".git"), "gitdir: /missing-package-cache\n");
    assert.ok(
      !(await discover([repo])).errors.some((error) => error.includes(store)),
      `${cache} package Git metadata must stay outside the repository inventory`,
    );
  }

  for (let i = 0; i < 30; i++)
    git(repo, "branch", `same-tip-${i}`, "refs/heads/main");
  assert.ok(
    (await inspectRepo(repo, [])).branches.every(
      (branch) => branch.ahead === 0,
    ),
  );
  const branchState = await inspectRepo(repo, []);
  assert.equal(
    branchState.branches.find((b) => b.name === "main")?.deleteReady,
    false,
  );
  assert.equal(
    branchState.branches.find((b) => b.name === "feature")?.deleteReady,
    false,
  );
  assert.equal(
    branchState.branches.find((b) => b.name === "next")?.deleteReady,
    true,
  );
  await assert.rejects(() => deleteBranch(repo, "next", "stale"));
  await assert.rejects(() => deleteBranch(repo, "main", head));
  await assert.rejects(() =>
    deleteBranch(repo, "feature", git(repo, "rev-parse", "feature")),
  );
  await deleteBranch(repo, "next", head);
  assert.equal(git(repo, "branch", "--list", "next"), "");
  assert.equal(git(repo, "rev-parse", "refs/heads/main"), head);
  await access(join(wt, "ignored"));

  const unique = git(
    repo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "unmerged fixture",
  );

  git(repo, "branch", "unique", unique);
  await assert.rejects(() => deleteBranch(repo, "unique", unique));
  git(repo, "update-ref", "refs/remotes/origin/main", unique);
  git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  assert.equal(
    (await inspectRepo(repo, [])).branches.find((b) => b.name === "unique")
      ?.deleteReady,
    false,
  );
  git(repo, "branch", "upstream-behind", "refs/heads/main");
  git(repo, "config", "branch.upstream-behind.remote", ".");
  git(repo, "config", "branch.upstream-behind.merge", "refs/heads/feature");
  assert.equal(
    (await inspectRepo(repo, [])).branches.find(
      (b) => b.name === "upstream-behind",
    )?.deleteReady,
    false,
  );
  await assert.rejects(() => deleteBranch(repo, "upstream-behind", head));
  git(repo, "branch", "keeper", unique);
  git(repo, "branch", "retired=web", unique);
  git(repo, "branch", "retired-web-batch", unique);
  git(repo, "branch", "private-release/closed", unique);
  git(repo, "branch", "storage-keepers/release", unique);
  assert.equal(
    (await inspectRepo(repo, [])).branches.find(
      (branch) => branch.name === "retired=web",
    )?.deleteReady,
    true,
  );
  await deleteBranch(repo, "retired=web", unique, "keeper");

  const staleCheckoutPlan = planCleanup([
    {
      projectId: "fixture",
      projectName: "Fixture",
      repo: await inspectRepo(repo, []),
    },
  ]);

  assert.ok(
    !staleCheckoutPlan.some((item) => item.target === "private-release/closed"),
  );
  assert.ok(
    !staleCheckoutPlan.some(
      (item) => item.target === "storage-keepers/release",
    ),
  );

  const deleted = await runCleanup(
    staleCheckoutPlan.filter((item) => item.target === "retired-web-batch"),
    async () => [],
    () => {},
  );

  assert.deepEqual(
    deleted.removed.map((item) => item.target),
    ["retired-web-batch"],
  );
  assert.equal(
    git(repo, "branch", "--list", "retired=web", "retired-web-batch"),
    "",
  );
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "rev-parse", "refs/heads/keeper"), unique);
  const activeFolder = join(root, "thr_fixture--manual-checkout");
  const activeRef = "tasks/thr-fixture-followup";
  git(
    repo,
    "worktree",
    "add",
    "-b",
    "zzz-chat-checkout",
    activeFolder,
    "keeper",
  );
  git(repo, "branch", activeRef, "keeper");
  const targets = new Set(["thr_fixture"]);

  const beforeChat = planCleanup([
    {
      projectId: "fixture",
      projectName: "Fixture",
      repo: await inspectCleanupRepo(repo, []),
    },
  ]).filter(
    (item) => item.target === activeFolder || item.target === activeRef,
  );

  assert.equal(beforeChat.length, 2);
  const current = await inspectCleanupRepo(repo, [], targets);
  assert.equal(
    current.worktrees.find((w) => w.path === activeFolder)?.purgeReady,
    false,
  );
  assert.equal(
    current.branches.find((b) => b.name === activeRef)?.deleteReady,
    false,
  );

  const held = await runCleanup(
    beforeChat,
    async () => [],
    () => {},
    targets,
  );

  assert.equal(held.removed.length, 0);
  assert.equal(held.skipped.length, 2);
  await access(activeFolder);
  assert.equal(git(repo, "rev-parse", `refs/heads/${activeRef}`), unique);
  git(activeFolder, "switch", "--detach");
  git(repo, "branch", "retired-alias", "keeper");
  assert.equal(
    (await inspectCleanupRepo(repo, [], targets)).branches.find(
      (b) => b.name === "retired-alias",
    )?.deleteReady,
    false,
  );
  git(repo, "worktree", "remove", activeFolder);
  const reused = join(root, "reused");
  git(repo, "worktree", "add", reused, "same-tip-0");
  await assert.rejects(() => deleteBranch(repo, "same-tip-0", head));
  const bulkRepo = join(root, "bulk");
  execFileSync("git", ["init", "-b", "main", bulkRepo]);
  git(bulkRepo, "config", "user.email", "fixture@example.invalid");
  git(bulkRepo, "config", "user.name", "Fixture");
  git(bulkRepo, "config", "commit.gpgsign", "false");
  await writeFile(join(bulkRepo, "tracked"), "base\n");
  git(bulkRepo, "add", ".");
  git(bulkRepo, "commit", "-m", "base");
  const bulkHead = git(bulkRepo, "rev-parse", "HEAD");

  const folders = ["finished", "became-dirty", "became-protected"].map((name) =>
    join(root, name),
  );

  for (const path of folders)
    git(bulkRepo, "worktree", "add", "-b", path.split("/").at(-1)!, path);
  git(bulkRepo, "branch", "moved");
  git(bulkRepo, "branch", "standalone");
  git(bulkRepo, "branch", "rewound");

  const featureTip = git(
    bulkRepo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "feature",
  );

  const keeperTip = git(
    bulkRepo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    featureTip,
    "-m",
    "keeper",
  );

  git(bulkRepo, "branch", "keeper", keeperTip);
  git(bulkRepo, "branch", "merged-feature", featureTip);
  git(bulkRepo, "config", "branch.merged-feature.remote", ".");
  git(bulkRepo, "config", "branch.merged-feature.merge", "refs/heads/keeper");
  const featureFolder = join(root, "feature-folder");
  git(bulkRepo, "worktree", "add", featureFolder, "merged-feature");
  const bulkState = await inspectRepo(bulkRepo, []);
  assert.equal(
    bulkState.worktrees.find((w) => w.path === featureFolder)?.purgeReady,
    true,
  );

  const plan = planCleanup([
    { projectId: "fixture", projectName: "Fixture", repo: bulkState },
  ]);

  assert.ok(
    plan.some((item) => item.kind === "folder" && item.target === folders[0]),
  );
  assert.ok(
    plan.some((item) => item.kind === "branch" && item.target === "finished"),
  );
  assert.ok(
    plan.some(
      (item) =>
        item.kind === "branch" &&
        item.target === "merged-feature" &&
        item.base === "keeper",
    ),
  );
  assert.ok(!plan.some((item) => ["main", "keeper"].includes(item.target)));
  await writeFile(join(folders[1], "untracked"), "preserve me");
  git(bulkRepo, "update-ref", "refs/heads/moved", keeperTip, bulkHead);

  const rewoundTip = git(
    bulkRepo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    bulkHead,
    "-m",
    "rewound",
  );

  git(bulkRepo, "update-ref", "refs/heads/rewound", rewoundTip, bulkHead);
  git(bulkRepo, "update-ref", "refs/heads/rewound", bulkHead, rewoundTip);
  git(bulkRepo, "branch", "added-after-review");
  const progress: number[] = [];
  let keeperAdded = false;

  const result = await runCleanup(
    plan,
    async (item) => {
      if (item.kind === "branch" && !keeperAdded) {
        keeperAdded = true;

        const newerKeeperTip = git(
          bulkRepo,
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          keeperTip,
          "-m",
          "new keeper",
        );

        git(bulkRepo, "branch", "newer-keeper", newerKeeperTip);
      }

      return [folders[2]];
    },
    (done) => progress.push(done),
  );

  assert.equal(
    result.removed.filter((item) => item.kind === "folder").length,
    2,
  );
  assert.equal(
    result.removed.filter((item) => item.kind === "branch").length,
    3,
  );
  assert.ok(
    result.removed.every((item) =>
      item.kind === "folder"
        ? (item.freedBytes ?? 0) > 0
        : item.freedBytes === null,
    ),
    "Removed folders report measured space; branch names report none",
  );
  assert.equal(result.skipped.length, 6);
  assert.equal(progress.at(-1), plan.length);
  await assert.rejects(() => access(folders[0]));
  await assert.rejects(() => access(featureFolder));
  assert.equal(
    git(
      bulkRepo,
      "branch",
      "--list",
      "finished",
      "standalone",
      "merged-feature",
    ),
    "",
  );
  assert.equal(git(bulkRepo, "rev-parse", "refs/heads/keeper"), keeperTip);
  assert.equal(git(bulkRepo, "rev-parse", "refs/heads/main"), bulkHead);
  assert.equal(
    git(bulkRepo, "rev-parse", "refs/heads/added-after-review"),
    bulkHead,
  );
  assert.equal(git(bulkRepo, "rev-parse", "refs/heads/moved"), keeperTip);
  assert.equal(git(bulkRepo, "rev-parse", "refs/heads/rewound"), bulkHead);
  assert.match(
    git(bulkRepo, "reflog", "show", "--format=%H", "rewound"),
    new RegExp(rewoundTip),
  );
  await access(join(folders[1], "untracked"));
  await access(folders[2]);
  assert.ok(result.skipped.every((item) => item.reason.length > 0));
  const privateFolder = join(root, "private-refs");
  git(bulkRepo, "worktree", "add", "-b", "private-refs", privateFolder);

  const privateTip = git(
    bulkRepo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "private work",
  );

  for (const ref of [
    "refs/worktree/backup",
    "refs/rewritten/backup",
    "refs/bisect/good",
  ]) {
    git(privateFolder, "update-ref", ref, privateTip);
    const privateState = await inspectRepo(bulkRepo, []);
    assert.equal(
      privateState.worktrees.find((w) => w.path === privateFolder)?.purgeReady,
      false,
      `${ref} must survive safe cleanup`,
    );
    assert.ok(
      !planCleanup([
        { projectId: "fixture", projectName: "Fixture", repo: privateState },
      ]).some(
        (item) => item.kind === "folder" && item.target === privateFolder,
      ),
    );
    await assert.rejects(() =>
      purgeWorktree(bulkRepo, privateFolder, bulkHead, []),
    );
    await access(privateFolder);
    assert.equal(git(privateFolder, "rev-parse", "--verify", ref), privateTip);
    git(privateFolder, "update-ref", "-d", ref, privateTip);
  }

  git(bulkRepo, "branch", "rewound-history");

  const branchHistoryTip = git(
    bulkRepo,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "rewritten branch work",
  );

  git(
    bulkRepo,
    "update-ref",
    "refs/heads/rewound-history",
    branchHistoryTip,
    bulkHead,
  );
  git(
    bulkRepo,
    "update-ref",
    "refs/heads/rewound-history",
    bulkHead,
    branchHistoryTip,
  );
  git(bulkRepo, "reflog", "delete", "refs/heads/rewound-history@{1}");
  assert.equal(
    (await inspectRepo(bulkRepo, [])).branches.find(
      (b) => b.name === "rewound-history",
    )?.deleteReady,
    false,
    "Unique branch reflog history must survive safe cleanup",
  );
  await assert.rejects(() =>
    deleteBranch(bulkRepo, "rewound-history", bulkHead, "main"),
  );
  assert.equal(
    git(bulkRepo, "rev-parse", "refs/heads/rewound-history"),
    bulkHead,
  );
  assert.ok(
    !git(
      bulkRepo,
      "reflog",
      "show",
      "--format=%H",
      "refs/heads/rewound-history",
    ).includes(branchHistoryTip),
  );
  assert.ok(
    (
      await readFile(
        join(bulkRepo, ".git", "logs", "refs", "heads", "rewound-history"),
        "utf8",
      )
    )
      .split("\n")
      .some((line) => line.split(" ")[0] === branchHistoryTip),
  );
  git(bulkRepo, "branch", "preserved-branch-history", branchHistoryTip);
  assert.equal(
    (await inspectRepo(bulkRepo, [])).branches.find(
      (b) => b.name === "rewound-history",
    )?.deleteReady,
    true,
  );
  await deleteBranch(bulkRepo, "rewound-history", bulkHead, "main");
  assert.equal(git(bulkRepo, "branch", "--list", "rewound-history"), "");
  assert.equal(
    git(bulkRepo, "rev-parse", "refs/heads/preserved-branch-history"),
    branchHistoryTip,
  );
  const historyFolder = join(root, "orphan-head-history");
  git(bulkRepo, "worktree", "add", "-b", "orphan-head-history", historyFolder);
  git(historyFolder, "checkout", "--detach");
  await writeFile(
    join(historyFolder, "tracked"),
    "unique source in detached history\n",
  );
  git(historyFolder, "add", "tracked");
  git(historyFolder, "commit", "-m", "unbranched work");
  const historyTip = git(historyFolder, "rev-parse", "HEAD");
  git(historyFolder, "checkout", "orphan-head-history");
  git(historyFolder, "reflog", "delete", "HEAD@{1}");
  const historyState = await inspectRepo(bulkRepo, []);
  assert.equal(
    historyState.worktrees.find((w) => w.path === historyFolder)?.purgeReady,
    false,
    "Unique HEAD reflog history must survive safe cleanup",
  );
  assert.ok(
    !planCleanup([
      { projectId: "fixture", projectName: "Fixture", repo: historyState },
    ]).some((item) => item.kind === "folder" && item.target === historyFolder),
  );
  await assert.rejects(() =>
    purgeWorktree(bulkRepo, historyFolder, bulkHead, []),
  );
  assert.ok(
    !git(historyFolder, "reflog", "show", "HEAD", "--format=%H").includes(
      historyTip,
    ),
  );
  assert.ok(
    (
      await readFile(
        git(historyFolder, "rev-parse", "--git-path", "logs/HEAD"),
        "utf8",
      )
    )
      .split("\n")
      .some((line) => line.split(" ")[0] === historyTip),
  );
  await access(historyFolder);
  git(bulkRepo, "branch", "preserved-head-history", historyTip);
  assert.equal(
    (await inspectRepo(bulkRepo, [])).worktrees.find(
      (w) => w.path === historyFolder,
    )?.purgeReady,
    true,
  );
  await purgeWorktree(bulkRepo, historyFolder, bulkHead, []);
  await assert.rejects(() => access(historyFolder));
  assert.equal(
    git(bulkRepo, "rev-parse", "refs/heads/preserved-head-history"),
    historyTip,
  );
  const recoveryFolder = join(root, "recovery-source");
  git(bulkRepo, "worktree", "add", "-b", "recovery-source", recoveryFolder);
  await writeFile(
    join(recoveryFolder, "tracked"),
    "source preserved by reset recovery\n",
  );
  git(recoveryFolder, "add", "tracked");
  git(recoveryFolder, "commit", "-m", "reset recovery source");
  const recoveryTip = git(recoveryFolder, "rev-parse", "HEAD");
  git(recoveryFolder, "reset", "--hard", "main");
  git(
    recoveryFolder,
    "reflog",
    "expire",
    "--expire=now",
    "--expire-unreachable=now",
    "HEAD",
    "refs/heads/recovery-source",
  );
  assert.equal(git(recoveryFolder, "rev-parse", "ORIG_HEAD"), recoveryTip);
  assert.ok(
    git(
      recoveryFolder,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "ORIG_HEAD",
    ).includes("/worktrees/"),
  );
  assert.equal(
    git(recoveryFolder, "reflog", "show", "HEAD", "--format=%H"),
    "",
  );

  for (const recoveryRef of ["ORIG_HEAD", "FETCH_HEAD"]) {
    if (recoveryRef === "FETCH_HEAD") {
      await writeFile(
        git(recoveryFolder, "rev-parse", "--git-path", "FETCH_HEAD"),
        `${recoveryTip}\t\tfixture branch\n`,
      );
      git(recoveryFolder, "update-ref", "-d", "ORIG_HEAD", recoveryTip);
    }

    assert.equal(
      (await inspectRepo(bulkRepo, [])).worktrees.find(
        (w) => w.path === recoveryFolder,
      )?.purgeReady,
      false,
      `${recoveryRef} recovery source must survive safe cleanup`,
    );
    await assert.rejects(() =>
      purgeWorktree(bulkRepo, recoveryFolder, bulkHead, []),
    );
    assert.equal(git(recoveryFolder, "rev-parse", recoveryRef), recoveryTip);
    await access(recoveryFolder);
  }

  git(bulkRepo, "branch", "preserved-recovery-source", recoveryTip);
  assert.equal(
    (await inspectRepo(bulkRepo, [])).worktrees.find(
      (w) => w.path === recoveryFolder,
    )?.purgeReady,
    true,
  );
  await purgeWorktree(bulkRepo, recoveryFolder, bulkHead, []);
  await assert.rejects(() => access(recoveryFolder));
  assert.equal(
    git(bulkRepo, "rev-parse", "refs/heads/preserved-recovery-source"),
    recoveryTip,
  );
  const separate = join(root, "separate-source");
  const separateMetadata = join(root, "separate-metadata");
  execFileSync("git", [
    "init",
    "-b",
    "main",
    `--separate-git-dir=${separateMetadata}`,
    separate,
  ]);
  git(separate, "config", "user.email", "fixture@example.invalid");
  git(separate, "config", "user.name", "Fixture");
  git(separate, "config", "commit.gpgsign", "false");
  git(separate, "config", "core.worktree", separate);
  await writeFile(join(separate, "source"), "tracked source\n");
  git(separate, "add", ".");
  git(separate, "commit", "-m", "separate Git directory source");
  await writeFile(
    join(separateMetadata, "large-object-proof"),
    Buffer.alloc(2 * 1024 * 1024),
  );
  const separateLinked = join(root, "separate-linked");
  git(separate, "worktree", "add", "-b", "feature", separateLinked);
  await writeFile(join(separate, "source"), "changed source\n");

  for (const caller of [separate, separateLinked]) {
    const separateState = await inspectRepo(caller, []);
    assert.equal(
      separateState.worktrees[0].path,
      separate,
      "Primary checkout must use source path",
    );
    assert.deepEqual(separateState.worktrees[0].dirtyFiles, ["source"]);
    assert.equal(separateState.worktrees[0].purgeReady, false);
    assert.ok(separateState.worktrees[0].storage.allocatedBytes! < 1024 * 1024);
    assert.ok(
      separateState.worktrees.some(
        (worktree) => worktree.path === separateLinked,
      ),
    );
    assert.equal(
      (await inspectSidebarRepo(caller)).worktrees[0].path,
      separate,
    );
  }

  const submoduleSource = join(bulkRepo, "absorbed-source");
  git(
    bulkRepo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    separate,
    "absorbed-source",
  );
  const submoduleState = await inspectRepo(submoduleSource, []);
  assert.equal(submoduleState.worktrees[0].path, submoduleSource);
  assert.equal(submoduleState.worktrees[0].purgeReady, false);
  assert.equal(
    (await inspectSidebarRepo(submoduleSource)).worktrees[0].path,
    submoduleSource,
  );
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    join(evidenceDirectory, "git.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "dirty diff",
          "ignored preservation",
          "unmerged preservation",
          "primary protection",
          "environment protection",
          "locked protection",
          "stale confirmation",
          "confirmed removal preserves branch",
          "safe branch deletion and default/checked-out/unmerged/stale/upstream guards",
          "bulk folder-then-branch cleanup, retained feature anchors, fresh dirty/protected/stale skips, fixed confirmation scope",
          "nested repositories survive stale outer metadata",
          "pnpm and uv dependency cache Git metadata stays outside repository discovery",
          "assume-unchanged edit protection",
          "worktree-private ref preservation across worktree, rewritten and bisect namespaces",
          "unique HEAD reflog history preserved until retained local branch owns committed source",
          "old and new reflog OIDs protected after Git selectively deletes an earlier entry",
          "unique branch reflog history blocks reviewed branch deletion until retained local branch preserves it",
          "ORIG_HEAD and FETCH_HEAD source survives expired reflogs until retained local branch preserves it",
          "separate Git directory and absorbed submodule primary checkout paths, dirt and storage use source folders",
        ],
        root,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ cleanupEligibilityComparisons: eligibilityComparisons }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await assert.rejects(() => access(root));
}

console.log(`PASS: ${join(evidenceDirectory, "git.json")}`);
