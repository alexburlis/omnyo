import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  materializeRendererOperations,
  collectRendererPairs,
} from "../../../scripts/omnyo-renderer-map.mjs";

it("couples parsed CSS and renderer selectors without changing colors, layout or opaque user text", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-renderer-"));

  try {
    writeFileSync(
      join(root, "style.css"),
      ".bb-owned { --bb-ink: oklch(0.5 0.1 20); color: var(--bb-ink); margin: 4px; }",
    );
    writeFileSync(
      join(root, "entry.tsx"),
      'const savedUserText=".bb-owned"; const worktreePath="/home/person/.bb-dev/worktrees"; const element=<div data-bb-owned className="bb-owned"/>; document.querySelector(".bb-owned");',
    );

    const pairs = collectRendererPairs({
      root,
      bindings: { files: ["style.css", "entry.tsx"] },
    });

    expect(
      pairs.some((p) => p.before === "bb-dev" || p.before === ".bb-dev"),
    ).toBe(false);
    expect(pairs.some((p) => p.before === "bb-owned")).toBe(true);

    const map = materializeRendererOperations({
      root,
      owner: "fixture",
      bindings: { files: ["style.css", "entry.tsx"] },
      pairs: [
        { before: ".bb-owned", after: ".omnyo-owned" },
        { before: "bb-owned", after: "omnyo-owned" },
        { before: "--bb-ink", after: "--omnyo-ink" },
        { before: "data-bb-owned", after: "data-omnyo-owned" },
      ],
    });

    const values = {};

    for (const file of ["style.css", "entry.tsx"]) {
      let text = readFileSync(join(root, file), "utf8");

      for (const { selector: s } of map.operations
        .filter((o) => o.selector.file === file)
        .sort((a, b) => b.selector.start - a.selector.start)) {
        expect(text.slice(s.start, s.start + s.before.length)).toBe(s.before);
        text =
          text.slice(0, s.start) +
          s.after +
          text.slice(s.start + s.before.length);
      }

      values[file] = text;
    }

    expect(values["style.css"]).toBe(
      ".omnyo-owned { --omnyo-ink: oklch(0.5 0.1 20); color: var(--omnyo-ink); margin: 4px; }",
    );
    expect(values["entry.tsx"]).toContain('savedUserText=".bb-owned"');
    expect(values["entry.tsx"]).toContain(
      'data-omnyo-owned className="omnyo-owned"',
    );
    expect(values["entry.tsx"]).toContain('querySelector(".omnyo-owned")');
    expect(map.pending).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
