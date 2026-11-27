import { realpath, lstat, mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { experimental_killProcessesWithCwdUnder } from "@omnyo/plugin-sdk/host";
import { publicationSchema, type Route, type Verification } from "../contract";
import { sha as shaSchema } from "./contract-fields";
import { execute } from "./host-execution";
import { hasRunMarker } from "./publication-identity";
import { checkPassed } from "./repair-result-contract";

const pullRequests = z.array(
  z.object({
    number: z.number(),
    url: z.url(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: shaSchema,
    isDraft: z.boolean(),
    body: z.string(),
    state: z.string(),
  }),
);

const packageManagers = ["pnpm", "yarn", "bun", "npm"] as const;

const lockfiles = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
] as const;

async function packageManager(repositoryPath: string, declared: string | undefined) {
  const named = packageManagers.find((name) => declared?.split("@")[0] === name);

  if (named) return named;

  const present = await Promise.all(
    lockfiles.map(async ([file]) =>
      Boolean((await lstat(join(repositoryPath, file)).catch(() => null))?.isFile()),
    ),
  );

  return lockfiles.find((_entry, index) => present[index])?.[1] ?? "npm";
}

function githubName(remote: string) {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(remote);

  if (ssh?.[1]) return ssh[1];

  try {
    const url = new URL(remote);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;

    return url.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
  } catch {
    return null;
  }
}

function safeDiff(content: string) {
  if (
    /\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:sk|ghp|gho|ghs)[_-][A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(
      content,
    )
  ) {
    throw new Error("Potential credential material in the proposed change");
  }
}

export class GitHost {
  constructor(private signal?: AbortSignal) {}

  private async git(cwd: string, ...args: string[]) {
    const result = await execute("git", args, cwd, 60000, true, this.signal);

    if (result.exitCode !== 0)
      throw new Error("Git validation failed: " + (args[0] ?? "operation"));

    return result.output.trim();
  }

  async discoverRepositories(rootPath: string) {
    const root = await realpath(rootPath);

    const ownership = await execute(
      "git",
      ["rev-parse", "--show-toplevel"],
      root,
      15000,
      true,
      this.signal,
    );

    const isRepository =
      ownership.exitCode === 0 && (await realpath(ownership.output.trim())) === root;

    const paths = isRepository
      ? [root]
      : (await readdir(root, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
          )
          .map((entry) => join(root, entry.name));

    const repositories = [];

    for (const path of paths.sort()) {
      if (!(await lstat(join(path, ".git")).catch(() => null))) continue;
      const canonical = await realpath(path);
      const top = await realpath(await this.git(canonical, "rev-parse", "--show-toplevel"));

      if (top !== canonical) continue;
      const branch = await this.git(canonical, "symbolic-ref", "--short", "HEAD");

      const remote = await execute(
        "git",
        ["remote", "get-url", "origin"],
        canonical,
        15000,
        true,
        this.signal,
      );

      const githubRepository = remote.exitCode === 0 ? githubName(remote.output.trim()) : null;
      const checks: Route["checks"] = [];
      const manifestPath = join(canonical, "package.json");
      const manifestInfo = await lstat(manifestPath).catch(() => null);

      if (manifestInfo?.isFile() && manifestInfo.size < 100000) {
        const manifest = z
          .object({
            scripts: z.record(z.string(), z.string()).optional(),
            packageManager: z.string().optional().catch(undefined),
          })
          .parse(JSON.parse(await readFile(manifestPath, "utf8")));

        const script = ["test:unit", "test"].find((name) => manifest.scripts?.[name]);

        if (script) {
          const manager = await packageManager(canonical, manifest.packageManager);
          checks.push({
            name: "Repository tests",
            command: manager,
            args: manager === "pnpm" || manager === "yarn" ? [script] : ["run", script],
            timeoutMs: 600000,
          });
        }
      }

      const instructionPaths = [join(root, "AGENTS.md"), join(canonical, "AGENTS.md")];
      const instructions = [];

      for (const file of new Set(instructionPaths))
        if ((await lstat(file).catch(() => null))?.isFile()) instructions.push(file);
      repositories.push({
        name: basename(canonical),
        path: canonical,
        baseRef: branch,
        githubRepository,
        checks,
        instructionPaths: instructions,
      });
    }

    return repositories;
  }

  async inspectRepository(
    repositoryPath: string,
    baseRef: string,
    expectedRepository: string | null,
  ) {
    const path = await realpath(repositoryPath);
    const top = await realpath(await this.git(path, "rev-parse", "--show-toplevel"));

    if (top !== path) throw new Error("Choose the exact repository root");
    await this.git(path, "check-ref-format", "--branch", baseRef);

    const commonDirectory = await realpath(
      resolve(path, await this.git(path, "rev-parse", "--git-common-dir")),
    );

    const remote = await execute(
      "git",
      ["remote", "get-url", "origin"],
      path,
      15000,
      true,
      this.signal,
    );

    const remoteName = remote.exitCode === 0 ? githubName(remote.output.trim()) : null;

    if (expectedRepository && remoteName?.toLowerCase() !== expectedRepository.toLowerCase())
      throw new Error("Repository remote does not match the configured GitHub repository");

    if (baseRef.startsWith("origin/")) {
      const branch = baseRef.slice(7);
      await this.git(
        path,
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/" + branch + ":refs/remotes/origin/" + branch,
      );
    }

    const baseSha = shaSchema.parse(
      await this.git(path, "rev-parse", "--verify", baseRef + "^{commit}"),
    );

    const branch = await this.git(path, "symbolic-ref", "--quiet", "--short", "HEAD");

    const dirty = await this.git(
      path,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    );

    return {
      repositoryPath: path,
      commonDirectory,
      baseSha,
      branch,
      remoteUrl: remoteName,
      dirtyPaths: dirty ? dirty.split("\n") : [],
    };
  }

  async createWorktree(
    sourcePath: string,
    path: string,
    branch: string,
    baseSha: string,
    restore = false,
  ) {
    shaSchema.parse(baseSha);
    await this.git(sourcePath, "check-ref-format", "--branch", branch);

    const exists = await lstat(path).then(
      () => true,
      () => false,
    );

    if (exists) {
      if (!restore)
        throw new Error(
          "Worktree destination already exists; inspect its recorded owner before recovery",
        );

      const sourceCommon = await realpath(
        resolve(sourcePath, await this.git(sourcePath, "rev-parse", "--git-common-dir")),
      );

      const existingCommon = await realpath(
        resolve(path, await this.git(path, "rev-parse", "--git-common-dir")),
      );

      if (
        sourceCommon !== existingCommon ||
        (await this.git(path, "branch", "--show-current")) !== branch
      )
        throw new Error("Existing worktree ownership differs");
      await this.git(path, "merge-base", "--is-ancestor", baseSha, "HEAD");

      return { path: await realpath(path), baseSha, branch };
    }

    if (restore) {
      await this.git(sourcePath, "merge-base", "--is-ancestor", baseSha, "refs/heads/" + branch);
      await this.git(sourcePath, "worktree", "add", path, branch);
    } else {
      const present = await execute(
        "git",
        ["cat-file", "-e", baseSha + "^{commit}"],
        sourcePath,
        15000,
        true,
        this.signal,
      );

      if (present.exitCode !== 0)
        await this.git(sourcePath, "fetch", "--no-tags", "origin", baseSha);
      await this.git(sourcePath, "worktree", "add", "-b", branch, path, baseSha);
    }

    return { path: await realpath(path), baseSha, branch };
  }

  async verify(
    path: string,
    baseSha: string,
    reportedHead: string,
    changedFiles: string[],
    checks: Route["checks"],
    repairBranch?: string,
  ): Promise<Verification> {
    shaSchema.parse(baseSha);
    shaSchema.parse(reportedHead);
    const head = shaSchema.parse(await this.git(path, "rev-parse", "HEAD"));

    if (repairBranch && (await this.git(path, "symbolic-ref", "--short", "HEAD")) !== repairBranch)
      throw new Error("The repair worktree is on a different branch");

    if (head !== reportedHead) {
      if (!repairBranch || (await this.git(path, "show", "-s", "--format=%P", head)) !== baseSha)
        throw new Error("The proposed commit is not the worktree head");

      const proposed = await execute(
        "git",
        ["rev-parse", "--verify", "--quiet", reportedHead + "^{commit}"],
        path,
        15000,
        true,
        this.signal,
      );

      if (proposed.exitCode !== 1 || proposed.signal || proposed.termination)
        throw new Error("The proposed commit is not the worktree head");
    }

    if (await this.git(path, "status", "--porcelain", "--untracked-files=all"))
      throw new Error("Commit only owned changes before verification");
    await this.git(path, "merge-base", "--is-ancestor", baseSha, head);

    const actual = (await this.git(path, "diff", "--name-only", baseSha, head))
      .split("\n")
      .filter(Boolean);

    if (!actual.length || [...actual].sort().join("\n") !== [...changedFiles].sort().join("\n"))
      throw new Error("The committed change differs from the completion proposal");

    for (const name of actual) {
      if (
        (/^\.env(?:\.|$)/u.test(name) && !name.endsWith(".example")) ||
        /(?:^|\/)(?:id_rsa|id_ed25519)$|\.(?:p12|pfx|key)$/u.test(name)
      )
        throw new Error("Sensitive file cannot be included in an automatic repair");
    }

    safeDiff(await this.git(path, "diff", "--no-ext-diff", "--no-color", baseSha, head));
    const tree = shaSchema.parse(await this.git(path, "rev-parse", head + "^{tree}"));
    const receipts: Verification["checks"] = [];

    for (const check of checks) {
      const result = await execute(
        check.command,
        check.args,
        path,
        check.timeoutMs,
        false,
        this.signal,
      );

      const failed = !checkPassed(result);
      receipts.push({
        name: check.name,
        ...result,
        output: failed
          ? `Process exit: ${result.exitCode ?? "none"}; signal: ${result.signal ?? "none"}; termination: ${result.termination ?? "none"}; drained output: ${result.outputBytes} bytes.`
          : "",
      });

      if (failed) return { head, tree, changedFiles: actual, checks: receipts };
    }

    if (
      (await this.git(path, "rev-parse", "HEAD")) !== head ||
      (await this.git(path, "status", "--porcelain", "--untracked-files=all"))
    )
      throw new Error("The worktree changed during verification");

    return { head, tree, changedFiles: actual, checks: receipts };
  }

  async publish(
    path: string,
    repository: string,
    head: string,
    branch: string,
    baseBranch: string,
    runId: string,
    title: string,
    body: string,
  ) {
    const remote = githubName(await this.git(path, "remote", "get-url", "origin"));

    if (remote?.toLowerCase() !== repository.toLowerCase())
      throw new Error("Publication repository changed");

    if (
      (await this.git(path, "rev-parse", "HEAD")) !== head ||
      (await this.git(path, "branch", "--show-current")) !== branch ||
      (await this.git(path, "status", "--porcelain", "--untracked-files=all"))
    )
      throw new Error("Publication worktree changed");

    if (!branch.startsWith("sentry/") || branch === baseBranch || !hasRunMarker(body, runId))
      throw new Error("Publication branch or incident marker is invalid");
    safeDiff(body);

    const query = [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,url,headRefName,baseRefName,headRefOid,isDraft,body,state",
    ];

    const read = async () => {
      const result = await execute("gh", query, path, 60000, true, this.signal);

      if (result.exitCode !== 0) throw new Error("Cannot inspect existing pull requests");

      return pullRequests.parse(JSON.parse(result.output));
    };

    const existing = await read();
    const other = existing.find((item) => !hasRunMarker(item.body, runId));

    if (other) throw new Error("A different owner already has a pull request for this branch");

    if (existing.some((item) => item.state !== "OPEN"))
      throw new Error("The existing pull request was closed; owner action is required");
    await this.git(path, "push", "origin", head + ":refs/heads/" + branch);

    const remoteHead = (
      await this.git(path, "ls-remote", "--heads", "origin", "refs/heads/" + branch)
    ).split(/\s/u)[0];

    if (remoteHead !== head)
      throw new Error("The remote fix ref did not match the verified commit");

    if (!existing.length) {
      const scratch = await mkdtemp(join(tmpdir(), "omnyo-sentry-pr-"));

      try {
        const file = join(scratch, "body.md");
        await writeFile(file, body, { mode: 0o600 });

        const created = await execute(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            repository,
            "--head",
            branch,
            "--base",
            baseBranch,
            "--draft",
            "--title",
            title.slice(0, 200),
            "--body-file",
            file,
          ],
          path,
          60000,
          true,
          this.signal,
        );

        if (created.exitCode !== 0) {
          const recovered = await read();

          if (!recovered.length)
            throw new Error("Fix branch pushed; draft PR creation needs a targeted retry");
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    const pulls = await read();
    const pr = pulls.find((item) => hasRunMarker(item.body, runId));

    if (
      !pr ||
      pr.headRefOid !== head ||
      pr.headRefName !== branch ||
      pr.baseRefName !== baseBranch ||
      !pr.isDraft ||
      pr.state !== "OPEN"
    )
      throw new Error("Draft PR readback did not match the verified target");

    return publicationSchema.parse({
      url: pr.url,
      number: pr.number,
      head,
      branch,
      baseBranch,
      draft: true,
    });
  }

  async removeWorktree(sourcePath: string, path: string, branch: string) {
    const exists = await lstat(path).then(
      () => true,
      () => false,
    );

    if (!exists) return { removed: true as const, preservedSha: null };

    if ((await this.git(path, "branch", "--show-current")) !== branch)
      throw new Error("Worktree branch changed");

    if (
      await this.git(path, "status", "--porcelain", "--untracked-files=all", "--ignored=matching")
    )
      throw new Error("Worktree contains uncommitted, untracked or ignored content");
    const head = await this.git(path, "rev-parse", "HEAD");
    const retained = await this.git(sourcePath, "rev-parse", "--verify", "refs/heads/" + branch);

    if (retained !== head) throw new Error("Unique source has not been preserved and recorded");
    await experimental_killProcessesWithCwdUnder({ directories: [path] });
    await this.git(sourcePath, "worktree", "remove", path);

    if (
      await lstat(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Worktree cleanup was not confirmed");

    return { removed: true as const, preservedSha: head };
  }
}
