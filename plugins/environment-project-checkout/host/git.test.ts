import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { getWorkspaceGitOperation } from "./git.js";

vi.mock("omnyo-environment-provider-host/git", () => ({
  runGit: async (args: string[]) => ({
    stdout: args[0] === "rev-parse" ? "/repo/.git\n" : "UU conflict.txt\n",
    exitCode: 0,
  }),
}));

afterEach(() => vi.restoreAllMocks());

it("checks independent operation markers together and preserves operation precedence", async () => {
  const pending = new Map<string, () => void>();
  vi.spyOn(fs, "access").mockImplementation(
    (target) =>
      new Promise<void>((resolve, reject) => {
        const name = String(target).split("/").at(-1)!;
        pending.set(name, () => {
          if (name === "rebase-apply" || name === "MERGE_HEAD") resolve();
          else reject(new Error("ENOENT"));
        });
      }),
  );
  const operation = getWorkspaceGitOperation("/repo");
  await vi.waitFor(() => expect(pending.size).toBe(5), { timeout: 100 });

  for (const release of [...pending.values()].reverse()) release();
  await expect(operation).resolves.toEqual({
    kind: "rebase",
    hasConflicts: true,
  });
});
