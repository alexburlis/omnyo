import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { materializeCurrentCopyOperations } from "../../../scripts/omnyo-copy-map.mjs";

it("binds current copy and exact assertion values while preserving state, upstream, legal and unknown text", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-copy-map-"));

  try {
    const file = "apps/app/src/View.tsx";
    const test = "apps/app/src/View.test.tsx";

    const source =
      'export const view=<main title="Use bb from anywhere">Reload bb. Run bb\'s own tools. <code>bb thread list</code><a href="https://github.com/get-bb/bb">Source</a></main>; const KEY="bb.state"; const opaque="arbitrary bb content"; const title="bb is MIT licensed";';

    mkdirSync(join(root, "apps/app/src"), { recursive: true });
    writeFileSync(join(root, file), source);
    writeFileSync(
      join(root, test),
      'expect(label).toBe("Use bb from anywhere"); const userText="arbitrary bb content";',
    );

    const result = materializeCurrentCopyOperations({
      root,
      owner: "fixture",
      bindings: { files: [file, test] },
    });

    let output = readFileSync(join(root, file), "utf8");

    for (const operation of result.operations
      .filter((operation) => operation.selector.file === file)
      .sort((a, b) => b.selector.start - a.selector.start)) {
      const { start, before, after } = operation.selector;
      expect(output.slice(start, start + before.length)).toBe(before);
      output =
        output.slice(0, start) + after + output.slice(start + before.length);
    }

    expect(output).toContain('title="Use Omnyo from anywhere"');
    expect(output).toContain("Reload Omnyo.");
    expect(output).toContain("Run Omnyo's own tools.");
    expect(output).toContain("<code>omnyo thread list</code>");
    expect(output).toContain("https://github.com/get-bb/bb");
    expect(output).toContain('KEY="bb.state"');
    expect(output).toContain('opaque="arbitrary bb content"');
    expect(output).toContain('title="bb is MIT licensed"');
    expect(
      result.operations
        .filter((operation) => operation.selector.file === test)
        .map((operation) => operation.selector.after),
    ).toEqual(["Use Omnyo from anywhere"]);
    expect(
      materializeCurrentCopyOperations({
        root,
        owner: "fixture",
        bindings: { files: [file, test] },
        excludeFiles: [file],
      }).operations,
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("includes private plugin CLI output while preserving opaque input and upstream URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-cli-copy-"));
  const file = "apps/cli/src/commands/plugin.ts";
  const assertion = "apps/cli/src/__tests__/plugin-new.test.ts";

  const source =
    'command.description("Install a plugin for BB."); console.warn("Run bb plugin build"); const USER_KEY="bb.plugin-state"; const arbitrary="BB user text"; console.log("https://github.com/get-bb/bb");';

  try {
    mkdirSync(join(root, "apps/cli/src/commands"), { recursive: true });
    mkdirSync(join(root, "apps/cli/src/__tests__"), { recursive: true });
    writeFileSync(join(root, file), source);
    writeFileSync(
      join(root, assertion),
      'expect(output).toBe("Run bb plugin build");',
    );

    const result = materializeCurrentCopyOperations({
      root,
      owner: "fixture",
      bindings: { files: [file, assertion] },
    });

    let actual = source;

    for (const { selector } of result.operations
      .filter((operation) => operation.selector.file === file)
      .sort((a, b) => b.selector.start - a.selector.start)) {
      expect(
        actual.slice(selector.start, selector.start + selector.before.length),
      ).toBe(selector.before);
      actual =
        actual.slice(0, selector.start) +
        selector.after +
        actual.slice(selector.start + selector.before.length);
    }

    expect(actual).toBe(
      'command.description("Install a plugin for Omnyo."); console.warn("Run omnyo plugin build"); const USER_KEY="bb.plugin-state"; const arbitrary="BB user text"; console.log("https://github.com/get-bb/bb");',
    );
    expect(
      result.operations
        .filter((operation) => operation.selector.file === assertion)
        .map((operation) => operation.selector.after),
    ).toEqual(["Run omnyo plugin build"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("classifies CLI options, errors and returned messages without changing flags or opaque values", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-cli-contexts-"));
  const file = "apps/cli/src/commands/plugin.ts";

  const source =
    'command.option("--bb-opaque <value>", "Run bb plugin list"); throw new Error("BB plugins " + "run inside BB."); function summary(){ return "Reviewed by BB"; } const status = ready ? "Usage: bb plugin list" : "Requires newer bb"; const opaque="bb.user-value";';

  try {
    mkdirSync(join(root, "apps/cli/src/commands"), { recursive: true });
    writeFileSync(join(root, file), source);

    const result = materializeCurrentCopyOperations({
      root,
      owner: "fixture",
      bindings: { files: [file] },
    });

    let actual = source;

    for (const { selector } of [...result.operations].sort(
      (a, b) => b.selector.start - a.selector.start,
    )) {
      expect(
        actual.slice(selector.start, selector.start + selector.before.length),
      ).toBe(selector.before);
      actual =
        actual.slice(0, selector.start) +
        selector.after +
        actual.slice(selector.start + selector.before.length);
    }

    expect(actual).toBe(
      'command.option("--bb-opaque <value>", "Run omnyo plugin list"); throw new Error("Omnyo plugins " + "run inside Omnyo."); function summary(){ return "Reviewed by Omnyo"; } const status = ready ? "Usage: omnyo plugin list" : "Requires newer Omnyo"; const opaque="bb.user-value";',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps command case across interpolated Markdown code spans", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-cli-template-copy-"));
  const file = "apps/cli/src/commands/plugin.ts";

  const source =
    "console.warn(`Run \\`bb plugin install ${path}\\` first, then re-run \\`bb plugin dev\\`.`);";

  try {
    mkdirSync(join(root, "apps/cli/src/commands"), { recursive: true });
    writeFileSync(join(root, file), source);

    const result = materializeCurrentCopyOperations({
      root,
      owner: "fixture",
      bindings: { files: [file] },
    });

    let actual = source;

    for (const { selector } of [...result.operations].sort(
      (a, b) => b.selector.start - a.selector.start,
    )) {
      expect(
        actual.slice(selector.start, selector.start + selector.before.length),
      ).toBe(selector.before);
      actual =
        actual.slice(0, selector.start) +
        selector.after +
        actual.slice(selector.start + selector.before.length);
    }

    expect(actual).toBe(
      "console.warn(`Run \\`omnyo plugin install ${path}\\` first, then re-run \\`omnyo plugin dev\\`.`);",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("classifies owned comparison display fields without treating a license descriptor as upstream identity", () => {
  const root = mkdtempSync(join(tmpdir(), "omnyo-comparison-copy-"));
  const file = "apps/web/src/compare/pages/fixture.tsx";

  const source =
    'export const comparison={question:"Does bb run here?",headline:"Build with bb",sub:"bb is open-source",description:"bb is MIT-licensed"}; const display=cell("yes","Run bb on your machines"); const view=<p>bb is MIT licensed.</p>; const copyright={title:"Copyright BB contributors"}; const upstream={title:"upstream BB"}; const href="https://github.com/get-bb/bb"; const opaque="bb.user-value";';

  try {
    mkdirSync(join(root, "apps/web/src/compare/pages"), { recursive: true });
    writeFileSync(join(root, file), source);

    const result = materializeCurrentCopyOperations({
      root,
      owner: "fixture",
      bindings: { files: [file] },
    });

    let actual = source;

    for (const { selector } of [...result.operations].sort(
      (a, b) => b.selector.start - a.selector.start,
    )) {
      expect(
        actual.slice(selector.start, selector.start + selector.before.length),
      ).toBe(selector.before);
      actual =
        actual.slice(0, selector.start) +
        selector.after +
        actual.slice(selector.start + selector.before.length);
    }

    expect(actual).toContain('question:"Does Omnyo run here?"');
    expect(actual).toContain('headline:"Build with Omnyo"');
    expect(actual).toContain('sub:"Omnyo is open-source"');
    expect(actual).toContain('description:"Omnyo is MIT-licensed"');
    expect(actual).toContain('cell("yes","Run Omnyo on your machines")');
    expect(actual).toContain("<p>Omnyo is MIT licensed.</p>");
    expect(actual).toContain('title:"Copyright BB contributors"');
    expect(actual).toContain('title:"upstream BB"');
    expect(actual).toContain('href="https://github.com/get-bb/bb"');
    expect(actual).toContain('opaque="bb.user-value"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
