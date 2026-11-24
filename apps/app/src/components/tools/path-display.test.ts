import { describe, expect, it } from "vitest";
import { formatHomePathForDisplay } from "@omnyo/shared-ui/lib/utils";

describe("formatHomePathForDisplay", () => {
  it.each([
    ["/Users/you", "~"],
    ["/Users/you/.omnyo/plugins/github", "~/.omnyo/plugins/github"],
    ["/home/u/.omnyo/skills/review", "~/.omnyo/skills/review"],
    ["/root/.omnyo/automations/run.sh", "~/.omnyo/automations/run.sh"],
    ["C:\\Users\\you\\.omnyo\\plugins", "~\\.omnyo\\plugins"],
  ])("compacts a conventional home path %s", (path, expected) => {
    expect(formatHomePathForDisplay(path)).toBe(expected);
  });

  it.each([
    "/managed/plugins/github",
    "/Volumes/work/plugins/github",
    "skills.sh/example/writing-voice",
    "SKILL.md",
  ])("preserves a path outside a conventional home %s", (path) => {
    expect(formatHomePathForDisplay(path)).toBe(path);
  });
});
