import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside, resolveNativeRoots } from "./paths.js";

const HOME = path.resolve("/fixture/home");

describe("resolveNativeRoots", () => {
  it("defaults both stores under the home directory", () => {
    expect(
      resolveNativeRoots({ homeDir: HOME, env: {}, platform: "darwin" }),
    ).toEqual({
      homeDir: HOME,
      codexHome: path.join(HOME, ".codex"),
      claudeConfigDir: path.join(HOME, ".claude"),
    });
  });

  it("honors absolute, tilde and home-relative overrides", () => {
    const roots = resolveNativeRoots({
      homeDir: HOME,
      env: {
        CODEX_HOME: "~/state/codex",
        CLAUDE_CONFIG_DIR: "custom-claude",
      },
      platform: "linux",
    });

    expect(roots.codexHome).toBe(path.join(HOME, "state", "codex"));
    expect(roots.claudeConfigDir).toBe(path.join(HOME, "custom-claude"));
    expect(
      resolveNativeRoots({
        homeDir: HOME,
        env: { CODEX_HOME: path.resolve("/opt/codex"), CLAUDE_CONFIG_DIR: "~" },
        platform: "linux",
      }),
    ).toMatchObject({
      codexHome: path.resolve("/opt/codex"),
      claudeConfigDir: HOME,
    });
  });

  it("ignores blank overrides", () => {
    expect(
      resolveNativeRoots({
        homeDir: HOME,
        env: { CODEX_HOME: "  ", CLAUDE_CONFIG_DIR: "" },
        platform: "darwin",
      }).codexHome,
    ).toBe(path.join(HOME, ".codex"));
  });
});

describe("isPathInside", () => {
  it("accepts only strict descendants", () => {
    expect(isPathInside(HOME, path.join(HOME, "a", "b"))).toBe(true);
    expect(isPathInside(HOME, HOME)).toBe(false);
    expect(isPathInside(HOME, path.join(HOME, "..", "other"))).toBe(false);
  });
});
