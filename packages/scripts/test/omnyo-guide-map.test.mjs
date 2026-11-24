import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  materializeGuideOperations,
  projectCurrentGuideParagraph,
} from "../../../scripts/omnyo-guide-map.mjs";

it("projects only current guide roles while preserving exact legacy inputs, source homes and opaque identities", () => {
  const pairs = new Map([["BB_THREAD_ID", "OMNYO_THREAD_ID"]]);

  const input =
    "BB guide. `bb thread list` uses `BB_THREAD_ID`. `bb.log` and `bb.branding.icon`, `engines.bbPluginSdk`, `@get-bb/plugin-sdk/app`. https://github.com/get-bb/bb packages/bb-app/src/index.ts /Users/developer/projects/bb-private `bb-cli` settings.bbCli BB_UNKNOWN ~/.bb/config.json";

  const output = projectCurrentGuideParagraph(input, pairs);

  expect(output).toBe(
    "Omnyo guide. `omnyo thread list` uses `OMNYO_THREAD_ID`. `api.log` and `omnyo.branding.icon`, `engines.omnyoPluginSdk`, `@omnyo/plugin-sdk/app`. https://github.com/get-bb/bb packages/bb-app/src/index.ts /Users/developer/projects/bb-private `bb-cli` settings.bbCli BB_UNKNOWN ~/.omnyo/config.json",
  );

  for (const value of [
    "The finite legacy layout importer is `omnyo plugin migrate`. It accepts recorded @get-bb/plugin-sdk and @bb/plugin-sdk.",
    "Copyright BB contributors, licensed under the MIT license.",
    'An arbitrary JSON object: {"bb": "user"}.',
  ])
    expect(projectCurrentGuideParagraph(value, pairs)).toBe(value);
});

it("projects current list items on both sides of the exact finite importer paragraph", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnyo-guide-ranges-")));
  const file = "plugins/bb-guide/skills/bb-cli/references/plugins.md";

  const legacy =
    "  - `omnyo plugin migrate`: The finite legacy layout importer is retained for @get-bb/plugin-sdk and @bb/plugin-sdk input only.";

  const before = [
    "  - BB before: `bb thread list`.",
    legacy,
    "  - BB after: `bb plugin list`.",
    "",
  ].join("\n");

  try {
    const environment = join(root, "packages/config/src/omnyo-environment.ts");
    mkdirSync(dirname(environment), { recursive: true });
    writeFileSync(environment, "export const pairs = [];\n");
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), before);

    const result = materializeGuideOperations({
      root,
      owner: "fixture",
      files: [file],
    });

    let output = before;

    for (const operation of [...result.operations].sort(
      (a, b) => b.selector.start - a.selector.start,
    )) {
      const edit = operation.selector;
      expect(output.slice(edit.start, edit.start + edit.before.length)).toBe(
        edit.before,
      );
      expect(edit.before).not.toContain(legacy);
      output =
        output.slice(0, edit.start) +
        edit.after +
        output.slice(edit.start + edit.before.length);
    }

    expect(output).toBe(
      [
        "  - Omnyo before: `omnyo thread list`.",
        legacy,
        "  - Omnyo after: `omnyo plugin list`.",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(root, file), "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
