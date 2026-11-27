import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitHost } from "../src/git-host";
import { renderPullRequest } from "../src/report";
import { completionSchema } from "../contract";
import { incident } from "./fixtures";

function git(cwd: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("verified commit to Git ref and draft PR readback", () => {
  it("recovers a lost PR response, deduplicates a replay and refuses a changed head", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentry-publication-test-"));
    const previousPath = process.env.PATH;

    try {
      const source = join(root, "source");
      const remote = join(root, "remote.git");
      const bin = join(root, "bin");
      await mkdir(source);
      await mkdir(bin);
      git(root, "init", "--bare", remote);
      git(source, "init", "-b", "main");
      git(source, "config", "commit.gpgsign", "false");
      git(source, "config", "user.name", "Sentry Test");
      git(source, "config", "user.email", "test@example.invalid");
      await writeFile(join(source, "repair.txt"), "baseline\n");
      git(source, "add", "repair.txt");
      git(source, "commit", "-m", "baseline");
      git(source, "remote", "add", "origin", remote);
      git(source, "push", "origin", "main");
      git(source, "checkout", "-b", "sentry/run_fixture");
      await writeFile(join(source, "repair.txt"), "verified repair\n");
      git(source, "add", "repair.txt");
      git(source, "commit", "-m", "repair");
      const head = git(source, "rev-parse", "HEAD");
      const state = join(root, "fake-github.json");
      await writeFile(state, JSON.stringify({ requests: 0, pulls: [] }));
      await writeFile(
        join(bin, "git"),
        `#!${process.execPath}
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.join(" ") === "remote get-url origin") process.stdout.write("https://github.com/fixture/example.git\\n");
else { const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" }); process.exit(result.status ?? 1); }
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, "gh"),
        `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const file = ${JSON.stringify(state)};
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[1] === "list") process.stdout.write(JSON.stringify(state.pulls));
else if (args[1] === "create") {
  state.requests++;
  state.pulls.push({ number: 7, url: "https://github.com/fixture/example/pull/7", headRefName: args[args.indexOf("--head") + 1], baseRefName: args[args.indexOf("--base") + 1], headRefOid: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), isDraft: args.includes("--draft"), state: "OPEN", body: readFileSync(args[args.indexOf("--body-file") + 1], "utf8") });
  writeFileSync(file, JSON.stringify(state));
  process.exit(1);
} else process.exit(2);
`,
        { mode: 0o755 },
      );
      process.env.PATH = bin + ":" + previousPath;
      const host = new GitHost();

      const proposal = completionSchema.parse({
        outcome: "fix-ready",
        classification: "Reproduced",
        summary: "Related parser failures",
        rootCause: "Shared parser invariant",
        change: "Handle the absent field",
        commit: head,
        changedFiles: ["repair.txt"],
        reproduction: {
          command: "node --test",
          before: "Null case failed",
          after: "Null case passes; second trigger remains blocked",
          evidence: ["proof.json"],
        },
        issueFindings: [
          {
            key: "acme:101",
            outcome: "fixed",
            summary: "Null input is repaired",
            evidence: ["proof.json"],
          },
          {
            key: "acme:102",
            outcome: "blocked",
            summary: "Need the affected-release input",
            evidence: [],
          },
        ],
      });

      const body = renderPullRequest(incident(), "run_fixture", proposal, [
        incident(),
        incident("102"),
      ]);

      await expect(
        host.publish(
          source,
          "fixture/example",
          head,
          "sentry/run_fixture",
          "main",
          "run_fixture",
          "Fixture repair",
          body.replace("sentry-run:run_fixture", "sentry-run:run_fixture_other"),
        ),
      ).rejects.toThrow("Publication branch or incident marker is invalid");
      expect(JSON.parse(await readFile(state, "utf8")).requests).toBe(0);

      const first = await host.publish(
        source,
        "fixture/example",
        head,
        "sentry/run_fixture",
        "main",
        "run_fixture",
        "Fixture repair",
        body,
      );

      expect(first).toMatchObject({
        head,
        number: 7,
        url: "https://github.com/fixture/example/pull/7",
      });
      expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/sentry/run_fixture")).toBe(
        head,
      );

      const second = await host.publish(
        source,
        "fixture/example",
        head,
        "sentry/run_fixture",
        "main",
        "run_fixture",
        "Fixture repair",
        body,
      );

      expect(second).toEqual(first);
      const published = JSON.parse(await readFile(state, "utf8"));
      expect(published.requests).toBe(1);
      expect(published.pulls[0].body).toContain("https://acme.sentry.io/issues/102/");
      expect(published.pulls[0].body).toContain("blocked");
      expect(published.pulls[0].body).toContain("Need the affected-release input");
      await writeFile(join(source, "repair.txt"), "late change\n");
      await expect(
        host.publish(
          source,
          "fixture/example",
          head,
          "sentry/run_fixture",
          "main",
          "run_fixture",
          "Fixture repair",
          body,
        ),
      ).rejects.toThrow("worktree changed");
      expect(JSON.parse(await readFile(state, "utf8")).requests).toBe(1);
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
