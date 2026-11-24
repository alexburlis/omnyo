import { describe, expect, it } from "vitest";
import { isOmnyoManagedWorkspacePath } from "./workspace-paths.js";

const dataDir = "/home/user/.omnyo";

describe("isOmnyoManagedWorkspacePath", () => {
  it("recognises a worktree under a plugin's host data directory", () => {
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/environment-git-worktree/host-data/worktrees/thr_abc-1/repo`,
      }),
    ).toBe(true);
  });

  it("recognises a personal workspace under a plugin's host data directory", () => {
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/environment-personal-workspace/host-data/personal-workspaces/thr_abc`,
      }),
    ).toBe(true);
  });

  it("recognises the pre-plugin workspace roots", () => {
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees/env_abc/repo`,
      }),
    ).toBe(true);
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/personal-workspaces/env_abc`,
      }),
    ).toBe(true);
  });

  it("leaves plugin storage that is not process data alone", () => {
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/some-plugin/source/index.ts`,
      }),
    ).toBe(false);
    expect(
      isOmnyoManagedWorkspacePath({ dataDir, path: `${dataDir}/plugins` }),
    ).toBe(false);
  });

  it("leaves paths outside the data directory alone", () => {
    expect(
      isOmnyoManagedWorkspacePath({ dataDir, path: "/home/user/code/repo" }),
    ).toBe(false);
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: "/home/user/.omnyo-other/worktrees/env_abc",
      }),
    ).toBe(false);
  });

  it("recognises managed roots on a Windows host in any spelling", () => {
    const windowsDataDir = "C:\\Users\\me\\.omnyo";
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "c:/users/me/.omnyo/plugins/environment-git-worktree/host-data/worktrees/thr_abc-1/repo",
      }),
    ).toBe(true);
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.omnyo\\worktrees\\env_abc\\repo",
      }),
    ).toBe(true);
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.omnyo\\plugins\\some-plugin\\source\\index.ts",
      }),
    ).toBe(false);
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\code\\repo",
      }),
    ).toBe(false);
  });

  it("does not treat a sibling prefix as a managed root", () => {
    expect(
      isOmnyoManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees-backup/env_abc`,
      }),
    ).toBe(false);
  });
});
