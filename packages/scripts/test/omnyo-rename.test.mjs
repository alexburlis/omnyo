import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRenamePlan,
  checkRenamePlan,
  createRenamePlan,
} from "../../../scripts/omnyo-rename.mjs";

import { brandedCandidates } from "../../../scripts/omnyo-rename/selectors.mjs";

const roots = [];

let nextRule = 0;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "omnyo-transform-"));
  roots.push(root);

  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
  }

  return root;
}

function rule(selector, extra = {}) {
  return {
    id: `test-rule-${nextRule++}`,
    rule_id: "R04",
    ledger_ids: ["PKG-010"],
    proof_ids: ["V01-source-transform"],
    migration_ids: ["S07"],
    owner: "fixture",
    selector,
    ...extra,
  };
}

function manifest(root, operations) {
  return { schema: 1, candidate: { root, owner: "fixture" }, operations };
}

function plan(root, operations) {
  return createRenamePlan({ root, manifest: manifest(root, operations) });
}

function journal(root) {
  return join(root, "..", `${root.split("/").at(-1)}.json`);
}

function apply(root, result, extras = {}) {
  const path = journal(root);
  roots.push(path, `${path}.staging`);

  return applyRenamePlan({ root, plan: result, journalPath: path, ...extras });
}

function text(root, path) {
  return readFileSync(join(root, path), "utf8");
}

describe("Omnyo source transformer", () => {
  it("binds declarations semantically and preserves serialized shorthand names", () => {
    const source =
      'export function first(bb: number) { return { bb, value: bb }; }\nexport function other(bb: number) { return bb; }\nconst literal = "bb";\n';

    const root = fixture({ "entry.ts": source });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "entry.ts",
        position: source.indexOf("bb:"),
        before: "bb",
        after: "api",
      }),
      rule({
        kind: "preserve",
        file: "entry.ts",
        before: source.slice(source.indexOf("export function other")),
        reason: "opaque-checksum-encoded-bytes-or-user-content",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    apply(root, result);
    expect(text(root, "entry.ts")).toContain(
      "first(api: number) { return { bb: api, value: api }; }",
    );
    expect(text(root, "entry.ts")).toContain(
      "other(bb: number) { return bb; }",
    );
    expect(text(root, "entry.ts")).toContain('literal = "bb"');
  });

  it("renames exported declarations and reexports through the language service", () => {
    const root = fixture({
      "api.ts": "export function createBbSdk() { return 1; }\n",
      "consumer.ts":
        'import { createBbSdk } from "./api";\nexport { createBbSdk };\ncreateBbSdk();\n',
    });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "api.ts",
        position: 16,
        before: "createBbSdk",
        after: "createOmnyoSdk",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    apply(root, result);
    expect(text(root, "consumer.ts")).not.toContain("createBbSdk");
    expect(text(root, "consumer.ts")).toContain("createOmnyoSdk");
  });

  it("renames owned module members reached through an awaited dynamic import", () => {
    const root = fixture({
      "api.ts": "export function createNodeBbSdk() { return 1; }",
      "consumer.ts":
        'export async function run() { const nodeEntry = await import("./api.js"); return nodeEntry.createNodeBbSdk(); }',
    });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "api.ts",
        position: 16,
        before: "createNodeBbSdk",
        after: "createNodeOmnyoSdk",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "consumer.ts")).toContain(
      "nodeEntry.createNodeOmnyoSdk()",
    );
  });

  it("refuses destination identifiers already in lexical scope", () => {
    const source = "function run(bb: number, api: number) { return bb + api; }";
    const root = fixture({ "entry.ts": source });
    expect(
      plan(root, [
        rule({
          kind: "symbol",
          file: "entry.ts",
          position: source.indexOf("bb:"),
          before: "bb",
          after: "api",
        }),
      ]).conflicts[0].message,
    ).toMatch(/collision/);
  });

  it("selects module literals without changing equal user strings", () => {
    const root = fixture({
      "entry.ts":
        'import type { PluginApi } from "@get-bb/plugin-sdk";\nconst user = "@get-bb/plugin-sdk";\n',
    });

    const result = plan(root, [
      rule({
        kind: "moduleSpecifier",
        file: "entry.ts",
        before: "@get-bb/plugin-sdk",
        after: "@omnyo/plugin-sdk",
      }),
      rule({
        kind: "preserve",
        file: "entry.ts",
        before: 'const user = "@get-bb/plugin-sdk";',
        reason: "opaque-checksum-encoded-bytes-or-user-content",
      }),
    ]);

    apply(root, result);
    expect(text(root, "entry.ts")).toContain('from "@omnyo/plugin-sdk"');
    expect(text(root, "entry.ts")).toContain('user = "@get-bb/plugin-sdk"');
  });

  it("edits exact JSON paths and refuses convergent package dependency keys", () => {
    const root = fixture({
      "package.json":
        '{"name":"bb-plugin-bb--account-usage","dependencies":{"@bb/plugin-sdk":"workspace:*","@get-bb/plugin-sdk":"workspace:*"}}',
    });

    const result = plan(root, [
      rule({
        kind: "jsonPath",
        file: "package.json",
        path: ["dependencies", "@bb/plugin-sdk"],
        field: "key",
        before: "@bb/plugin-sdk",
        after: "@omnyo/plugin-sdk",
      }),
      rule(
        {
          kind: "jsonPath",
          file: "package.json",
          path: ["dependencies", "@get-bb/plugin-sdk"],
          field: "key",
          before: "@get-bb/plugin-sdk",
          after: "@omnyo/plugin-sdk",
        },
        { id: "sdk-special" },
      ),
    ]);

    expect(result.conflicts.some((c) => /collision/.test(c.message))).toBe(
      true,
    );
  });

  it("computes exact package names once without cascaded prefix replacement", () => {
    const root = fixture({
      "package.json": '{"name":"bb-plugin-bb--account-usage"}',
    });

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb-plugin-bb--account-usage",
        after: "omnyo-plugin-omnyo--account-usage",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    apply(root, result);
    expect(JSON.parse(text(root, "package.json")).name).toBe(
      "omnyo-plugin-omnyo--account-usage",
    );
  });

  it("produces identical plans and refuses an unclassified complete-universe candidate", () => {
    const root = fixture({
      "entry.ts": 'const display = "BB";',
      "plain.ts": "export const count = 2;",
    });

    const a = plan(root, []);
    expect(a).toEqual(plan(root, []));
    expect(a.universe.map((f) => f.path)).toEqual(["entry.ts", "plain.ts"]);
    expect(a.unresolved).toHaveLength(1);
    expect(() => apply(root, a)).toThrow(/unresolved/);
  });

  it("freezes exact legal/upstream text before transformation", () => {
    const source = 'const upstream = "get-bb/bb"; const product = "BB";';
    const root = fixture({ "entry.ts": source });

    const result = plan(root, [
      rule({
        kind: "preserve",
        file: "entry.ts",
        before: "get-bb/bb",
        reason: "real-upstream-reference",
      }),
      rule({
        kind: "literal",
        file: "entry.ts",
        before: "BB",
        after: "Omnyo",
        context: "string",
      }),
    ]);

    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "entry.ts")).toContain('"get-bb/bb"');
    expect(text(root, "entry.ts")).toContain('"Omnyo"');
  });

  it("refuses selected preserve-range edits and unused exceptions", () => {
    const root = fixture({ "entry.ts": 'const name = "BB";' });

    const result = plan(root, [
      rule({
        kind: "preserve",
        file: "entry.ts",
        before: "BB",
        reason: "third-party-identity",
      }),
      rule({
        kind: "literal",
        file: "entry.ts",
        before: "BB",
        after: "Omnyo",
        context: "string",
      }),
    ]);

    expect(result.conflicts.some((c) => /preserv/.test(c.message))).toBe(true);
    expect(
      plan(root, [
        rule({
          kind: "preserve",
          file: "entry.ts",
          before: "missing",
          reason: "third-party-identity",
        }),
      ]).conflicts[0].message,
    ).toMatch(/no match/);
  });

  it("moves nested paths from original paths and supports repeated resume", () => {
    const root = fixture({
      "packages/bb-app/bb.ts": "export const value = 1;",
    });

    const result = plan(root, [
      rule({
        kind: "path",
        file: "packages/bb-app",
        target: "packages/omnyo-app",
      }),
      rule(
        {
          kind: "path",
          file: "packages/bb-app/bb.ts",
          target: "packages/bb-app/omnyo.ts",
        },
        { id: "child" },
      ),
    ]);

    expect(result.conflicts).toEqual([]);
    apply(root, result);
    expect(text(root, "packages/omnyo-app/omnyo.ts")).toContain("value = 1");
    apply(root, result, { resume: true });
    apply(root, result, { resume: true });
  });

  it("refuses stale source digests before any product file write", () => {
    const root = fixture({
      "package.json": '{"name":"bb"}',
      "foreign.ts": "export const value = 1;",
    });

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
    ]);

    writeFileSync(join(root, "foreign.ts"), "export const value = 2;");
    expect(() => apply(root, result)).toThrow(/drift/);
    expect(JSON.parse(text(root, "package.json")).name).toBe("bb");
  });

  it("refuses case-fold collisions, escapes and symlink traversal", () => {
    const root = fixture({
      "source.ts": "export const a = 1;",
      "target.ts": "export const b = 2;",
    });

    expect(
      plan(root, [
        rule({ kind: "path", file: "source.ts", target: "TARGET.ts" }),
      ]).conflicts[0].message,
    ).toMatch(/collision/);
    expect(
      plan(root, [
        rule({ kind: "path", file: "source.ts", target: "../outside.ts" }),
      ]).conflicts[0].message,
    ).toMatch(/unsafe/);
    symlinkSync(join(root, "target.ts"), join(root, "link.ts"));
    expect(
      plan(root, [
        rule({ kind: "path", file: "link.ts", target: "copy.ts" }),
      ]).conflicts.some((c) => /symlink/.test(c.message)),
    ).toBe(true);
  });

  it.each(["after-stage", "after-edit", "after-publish"])(
    "recovers interrupted files at %s without duplicating edits",
    (boundary) => {
      const root = fixture({ "package.json": '{"name":"bb"}' });

      const result = plan(root, [
        rule({
          kind: "packageName",
          file: "package.json",
          before: "bb",
          after: "omnyo",
        }),
      ]);

      expect(() =>
        apply(root, result, {
          fault(point) {
            if (point === boundary) throw new Error("interrupted");
          },
        }),
      ).toThrow("interrupted");
      apply(root, result, { resume: true });
      expect(JSON.parse(text(root, "package.json")).name).toBe("omnyo");
      expect(checkRenamePlan({ root, plan: result }).ok).toBe(true);
    },
  );

  it("refuses a third digest after interruption without replacing foreign bytes", () => {
    const root = fixture({ "package.json": '{"name":"bb"}' });

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
    ]);

    expect(() =>
      apply(root, result, {
        fault(point) {
          if (point === "after-publish") throw new Error("interrupted");
        },
      }),
    ).toThrow();
    writeFileSync(join(root, "package.json"), '{"name":"foreign"}');
    expect(() => apply(root, result, { resume: true })).toThrow(/drift/);
    expect(JSON.parse(text(root, "package.json")).name).toBe("foreign");
  });

  it("requires migration IDs for serialized-field edits", () => {
    const root = fixture({
      "entry.ts": 'const manifest = { bb: { title: "test" } };',
    });

    const result = plan(root, [
      rule(
        {
          kind: "literal",
          file: "entry.ts",
          before: "bb",
          after: "omnyo",
          context: "property",
        },
        { migration_ids: [] },
      ),
    ]);

    expect(result.conflicts[0].message).toMatch(/migration/);
  });
  it("refuses an after digest without its durable apply journal", () => {
    const root = fixture({ "package.json": '{"name":"bb"}' });

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
    ]);

    writeFileSync(join(root, "package.json"), '{"name":"omnyo"}');
    expect(() => apply(root, result)).toThrow(/drift/);
  });

  it("refuses cross-file rename collisions in an import consumer", () => {
    const root = fixture({
      "api.ts": "export function createBbSdk() { return 1; }",
      "consumer.ts":
        'import { createBbSdk } from "./api"; const createOmnyoSdk = 2; createBbSdk();',
    });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "api.ts",
        position: 16,
        before: "createBbSdk",
        after: "createOmnyoSdk",
      }),
    ]);

    expect(
      result.conflicts.some((conflict) => /collision/.test(conflict.message)),
    ).toBe(true);
  });

  it("resolves source export package aliases in the semantic source graph", () => {
    const root = fixture({
      "packages/sdk/package.json":
        '{"name":"@bb/sdk","exports":{".":{"source":"./src/index.ts"}}}',
      "packages/sdk/src/index.ts":
        "export function createBbSdk() { return 1; }",
      "consumer.ts": 'import { createBbSdk } from "@bb/sdk"; createBbSdk();',
    });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "packages/sdk/src/index.ts",
        position: 16,
        before: "createBbSdk",
        after: "createOmnyoSdk",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(
      result.files.find((file) => file.input_path === "consumer.ts").edits,
    ).toHaveLength(2);
  });

  it("resumes a case-only file move from the same inode", () => {
    const root = fixture({ "source.ts": "export const value = 1;" });

    const result = plan(root, [
      rule({ kind: "path", file: "source.ts", target: "Source.ts" }),
    ]);

    expect(result.conflicts).toEqual([]);
    apply(root, result);
    apply(root, result, { resume: true });
    expect(checkRenamePlan({ root, plan: result }).ok).toBe(true);
  });

  it("independently reports old serialized keys retained by semantic shorthand rename", () => {
    const source = "function run(bb: number) { return { bb }; }";
    const root = fixture({ "entry.ts": source });

    const result = plan(root, [
      rule({
        kind: "symbol",
        file: "entry.ts",
        position: source.indexOf("bb:"),
        before: "bb",
        after: "api",
      }),
    ]);

    apply(root, result);
    const checked = checkRenamePlan({ root, plan: result });
    expect(checked.ok).toBe(false);
    expect(checked.unresolved).toHaveLength(1);
    expect(text(root, "entry.ts")).toContain("bb: api");
  });

  it("reports branded opaque asset paths instead of silently closing them", () => {
    const root = fixture({ "bb-icon.png": Buffer.from([137, 80, 78, 71, 0]) });
    const result = plan(root, []);
    expect(result.unresolved).toContainEqual({
      file: "bb-icon.png",
      context: "path",
    });
  });

  it("requires explicit protected owners before any source write around database and credential files", () => {
    const root = fixture({
      ".env": "synthetic fixture",
      "app.db": "synthetic fixture",
    });

    const result = plan(root, []);
    expect(result.conflicts).toEqual([]);
    expect(
      result.unresolved.filter(({ context }) => context === "protected-owner"),
    ).toHaveLength(2);
    expect(() => apply(root, result)).toThrow(/unresolved/);
  });
  it("allows a bounded wave with exact deferred files but never reports final closure", () => {
    const root = fixture({
      "package.json": '{"name":"bb"}',
      "later.ts": 'export const name = "BB";',
    });

    const digest = createHash("sha256")
      .update(text(root, "later.ts"))
      .digest("hex");

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
      rule({
        kind: "defer",
        file: "later.ts",
        digest,
        phase: "P3",
        reason: "Later source wave retains ownership",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.deferred_candidates).toHaveLength(1);
    apply(root, result);
    expect(text(root, "later.ts")).toBe('export const name = "BB";');
    expect(JSON.parse(text(root, "package.json")).name).toBe("omnyo");
    const checked = checkRenamePlan({ root, plan: result });
    expect(checked.ok).toBe(false);
    expect(checked.deferred).toHaveLength(1);
  });

  it("refuses writes to deferred files and refuses deferrals without exact evidence", () => {
    const root = fixture({ "package.json": '{"name":"bb"}' });

    const digest = createHash("sha256")
      .update(text(root, "package.json"))
      .digest("hex");

    const result = plan(root, [
      rule({
        kind: "defer",
        file: "package.json",
        digest,
        phase: "P3",
        reason: "Later source wave",
      }),
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
    ]);

    expect(
      result.conflicts.some((conflict) =>
        /Deferred file/.test(conflict.message),
      ),
    ).toBe(true);
    expect(() => apply(root, result)).toThrow();
    expect(
      plan(root, [
        rule({
          kind: "defer",
          file: "package.json",
          phase: "P3",
          reason: "Later source wave",
        }),
      ]).conflicts,
    ).toHaveLength(1);
  });

  it("protects a foreign edit in an explicitly deferred file before any selected write", () => {
    const root = fixture({
      "package.json": '{"name":"bb"}',
      "later.ts": 'export const name = "BB";',
    });

    const digest = createHash("sha256")
      .update(text(root, "later.ts"))
      .digest("hex");

    const result = plan(root, [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
      rule({
        kind: "defer",
        file: "later.ts",
        digest,
        phase: "P3",
        reason: "Later source wave",
      }),
    ]);

    writeFileSync(join(root, "later.ts"), "export const foreign = 2;");
    expect(() => apply(root, result)).toThrow(/drift/);
    expect(JSON.parse(text(root, "package.json")).name).toBe("bb");
  });

  it("permits a disjoint bound edit while retaining a pending serialized range", () => {
    const source =
      'import { x } from "@bb/config";\nconst pending = "BB_STATE";';

    const root = fixture({ "entry.ts": source });
    const start = source.indexOf("BB_STATE");

    const result = plan(root, [
      rule({
        kind: "moduleSpecifier",
        file: "entry.ts",
        before: "@bb/config",
        after: "@omnyo/config",
      }),
      rule({
        kind: "defer",
        file: "entry.ts",
        digest: createHash("sha256").update(source).digest("hex"),
        start,
        length: "BB_STATE".length,
        phase: "P3",
        reason: "S06 emitter awaits its migration owner",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "entry.ts")).toBe(
      source.replace("@bb/config", "@omnyo/config"),
    );
    expect(checkRenamePlan({ root, plan: result }).ok).toBe(false);
  });

  it("refuses a poisoned range that overlaps a selected edit before any write", () => {
    const source = 'import { x } from "@bb/config";';
    const root = fixture({ "entry.ts": source });

    const result = plan(root, [
      rule({
        kind: "moduleSpecifier",
        file: "entry.ts",
        before: "@bb/config",
        after: "@omnyo/config",
      }),
      rule({
        kind: "defer",
        file: "entry.ts",
        digest: createHash("sha256").update(source).digest("hex"),
        start: source.indexOf("@bb/config"),
        length: 4,
        phase: "P3",
        reason: "Poisoned overlapping pending token",
      }),
    ]);

    expect(
      result.conflicts.some(({ message }) => /overlapping edits/.test(message)),
    ).toBe(true);
    expect(() => apply(root, result)).toThrow();
    expect(text(root, "entry.ts")).toBe(source);
  });

  it("refuses incomplete and invalid range evidence without hiding unknown bytes", () => {
    const source = 'export const pending = "BB_STATE";';
    const root = fixture({ "entry.ts": source });
    const digest = createHash("sha256").update(source).digest("hex");

    const short = plan(root, [
      rule({
        kind: "defer",
        file: "entry.ts",
        digest,
        start: source.indexOf("BB_STATE"),
        length: 1,
        phase: "P3",
        reason: "Incomplete token",
      }),
    ]);

    expect(short.unresolved).toHaveLength(1);

    const invalid = plan(root, [
      rule({
        kind: "defer",
        file: "entry.ts",
        digest,
        start: source.length,
        length: 1,
        phase: "P3",
        reason: "Outside source",
      }),
    ]);

    expect(
      invalid.conflicts.some(({ message }) => /exact text range/.test(message)),
    ).toBe(true);
  });

  it("defers only a pathname while permitting bound source edits without hiding source tokens", () => {
    const source = 'export function createBbSdk() { return "BB_STATE"; }';
    const root = fixture({ "bb-entry.ts": source });
    const digest = createHash("sha256").update(source).digest("hex");

    const operations = [
      rule({
        kind: "span",
        file: "bb-entry.ts",
        start: source.indexOf("createBbSdk"),
        before: "createBbSdk",
        after: "createOmnyoSdk",
        context: "Exact fixture declaration",
      }),
      rule({
        kind: "defer",
        file: "bb-entry.ts",
        digest,
        pathOnly: true,
        phase: "P3",
        reason: "R15 source path wave follows symbol wave",
      }),
    ];

    const unknown = plan(root, operations);
    expect(unknown.unresolved).toHaveLength(1);

    const result = plan(root, [
      ...operations,
      rule({
        kind: "defer",
        file: "bb-entry.ts",
        digest,
        start: source.indexOf("BB_STATE"),
        length: 8,
        phase: "P3",
        reason: "S06 emitter waits for its owner",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "bb-entry.ts")).toBe(
      source.replace("createBbSdk", "createOmnyoSdk"),
    );
    expect(checkRenamePlan({ root, plan: result }).ok).toBe(false);
  });

  it("runs the existing PostCSS owner against selector, declaration and value edits", () => {
    const root = fixture({
      "entry.css": ":root{--bb-ink:black}.bb-panel{color:var(--bb-ink)}",
      "apps/mobile/package.json": "{}",
    });

    symlinkSync(
      fileURLToPath(
        new URL("../../../apps/mobile/node_modules", import.meta.url),
      ),
      join(root, "apps/mobile/node_modules"),
    );

    const result = plan(root, [
      rule({
        kind: "format",
        format: "css",
        context: "selector",
        file: "entry.css",
        before: ".bb-panel",
        after: ".omnyo-panel",
      }),
      rule({
        kind: "format",
        format: "css",
        context: "property",
        file: "entry.css",
        before: "--bb-ink",
        after: "--omnyo-ink",
      }),
      rule({
        kind: "format",
        format: "css",
        context: "value",
        file: "entry.css",
        before: "var(--bb-ink)",
        after: "var(--omnyo-ink)",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "entry.css")).toBe(
      ":root{--omnyo-ink:black}.omnyo-panel{color:var(--omnyo-ink)}",
    );
  });

  it("runs the existing parse5 owner against quoted HTML attribute values", () => {
    const root = fixture({
      "entry.html": '<img alt="BB" src="/bb-logo.svg">',
      "apps/server/package.json": "{}",
    });

    symlinkSync(
      fileURLToPath(
        new URL("../../../apps/server/node_modules", import.meta.url),
      ),
      join(root, "apps/server/node_modules"),
    );

    const result = plan(root, [
      rule({
        kind: "format",
        format: "html",
        context: "attribute",
        attribute: "alt",
        file: "entry.html",
        before: "BB",
        after: "Omnyo",
      }),
      rule({
        kind: "format",
        format: "html",
        context: "attribute",
        attribute: "src",
        file: "entry.html",
        before: "/bb-logo.svg",
        after: "/omnyo-logo.svg",
      }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    apply(root, result);
    expect(text(root, "entry.html")).toBe(
      '<img alt="Omnyo" src="/omnyo-logo.svg">',
    );
  });

  it("binds protected files by measurement only and blocks their edits and foreign drift", () => {
    const source = "synthetic fixture bytes";

    const root = fixture({
      "package.json": '{"name":"bb"}',
      ".env.fixture": source,
    });

    const operations = [
      rule({
        kind: "packageName",
        file: "package.json",
        before: "bb",
        after: "omnyo",
      }),
      rule({
        kind: "defer",
        file: ".env.fixture",
        digest: createHash("sha256").update(source).digest("hex"),
        phase: "P3",
        reason: "Protected owner retains this exact fixture",
      }),
    ];

    const result = plan(root, operations);
    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(
      result.universe.find(({ path }) => path === ".env.fixture").format,
    ).toBe("protected");

    const poisoned = plan(root, [
      ...operations,
      rule({
        kind: "span",
        file: ".env.fixture",
        start: 0,
        before: source,
        after: "changed",
        context: "Forbidden protected edit",
      }),
    ]);

    expect(
      poisoned.conflicts.some(({ message }) =>
        /Protected input refused/.test(message),
      ),
    ).toBe(true);
    writeFileSync(join(root, ".env.fixture"), "foreign fixture bytes");
    expect(() => apply(root, result)).toThrow(/drift/);
    expect(JSON.parse(text(root, "package.json")).name).toBe("bb");
  });
});

it("classifies valid UTF8 source with an unlisted extension for independent residual scanning", () => {
  const root = fixture({ "native.patch": "+window.bb.native();\n" });
  const result = plan(root, []);

  expect(
    result.universe.find((entry) => entry.path === "native.patch").format,
  ).toBe("text");
  expect(result.unresolved.some((entry) => entry.file === "native.patch")).toBe(
    true,
  );
});

it("binds escaped literals, JSX entities and interpolated template candidates to raw source", () => {
  const value =
    'const text = "first\\nBB_TRACE"; const node = <div title="&amp;BB_LABEL">&amp;BB_BODY</div>; const template = `before\\n${value} BB_AFTER`;';

  const candidates = brandedCandidates("entry.tsx", value);

  for (const token of ["BB_TRACE", "BB_LABEL", "BB_BODY", "BB_AFTER"])
    expect(candidates).toContainEqual({
      start: value.indexOf(token),
      length: token.length,
      context: expect.any(String),
    });
});

it("keeps encoded brand tokens unresolved and prevents a poisoned defer from authorizing partial writes", () => {
  const raw = String.raw`\u0042B_FLAG`;
  const value = `export const value = "${raw}";`;
  const start = value.indexOf(raw);
  const root = fixture({ "entry.ts": value });

  expect(brandedCandidates("entry.ts", value)).toContainEqual({
    start,
    length: raw.length,
    context: "encoded-source-token",
  });
  expect(plan(root, []).unresolved).toContainEqual(
    expect.objectContaining({ file: "entry.ts", start, length: raw.length }),
  );

  const poisoned = plan(root, [
    rule({
      kind: "defer",
      file: "entry.ts",
      digest: createHash("sha256").update(value).digest("hex"),
      start,
      length: raw.length,
      phase: "P3",
      reason: "Encoded token remains pending",
    }),
    rule({
      kind: "span",
      file: "entry.ts",
      start: start + raw.length - 4,
      before: "FLAG",
      after: "VALUE",
      context: "Forbidden edit inside deferred encoded token",
    }),
  ]);

  expect(
    poisoned.conflicts.some(({ message }) => /overlapping edits/.test(message)),
  ).toBe(true);
  expect(() => apply(root, poisoned)).toThrow();
  expect(text(root, "entry.ts")).toBe(value);
});

it("continues bound waves after a tracked source move and refuses resurrection of the absent path", () => {
  const root = fixture({
    "old.ts": "export const value = 1;",
    "other.ts": "export const count = 1;",
  });

  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "old.ts", "other.ts"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);

  const move = plan(root, [
    rule({ kind: "path", file: "old.ts", target: "new.ts" }),
  ]);

  apply(root, move);

  const next = plan(root, [
    rule({
      kind: "span",
      file: "other.ts",
      start: 0,
      before: "export const count = 1;",
      after: "export const count = 2;",
      context: "Next owned source unit",
    }),
  ]);

  expect(next.conflicts).toEqual([]);
  expect(next.universe.map((entry) => entry.path)).toEqual([
    "new.ts",
    "other.ts",
  ]);
  writeFileSync(join(root, "old.ts"), "foreign resurrection");
  const nextJournal = `${journal(root)}.next`;
  roots.push(nextJournal, `${nextJournal}.staging`);
  expect(() =>
    applyRenamePlan({ root, plan: next, journalPath: nextJournal }),
  ).toThrow(/drift|universe/i);
  expect(text(root, "other.ts")).toBe("export const count = 1;");
});

it("keeps raw comment and regex brand candidates in the independent source census", () => {
  const value = "// BB current owner\nconst pattern = /BB_SOURCE/;";
  const candidates = brandedCandidates("entry.ts", value);

  for (const token of ["BB", "BB_SOURCE"])
    expect(candidates).toContainEqual(
      expect.objectContaining({
        start: value.indexOf(token),
        length: token.length,
      }),
    );
});

it("unifies overlapping raw and cooked token coverage without allowing an edit inside the pending union", () => {
  const value = 'const text = "\\nBbSdk";';
  const root = fixture({ "entry.ts": value });
  const candidates = brandedCandidates("entry.ts", value);

  const operations = candidates.map((candidate) =>
    rule({
      kind: "defer",
      file: "entry.ts",
      digest: createHash("sha256").update(value).digest("hex"),
      start: candidate.start,
      length: candidate.length,
      phase: "P3",
      reason: "Exact raw and cooked branded source remains pending",
    }),
  );

  const pending = plan(root, operations);

  expect(pending.conflicts).toEqual([]);
  expect(pending.unresolved).toEqual([]);

  const poisoned = plan(root, [
    ...operations,
    rule({
      kind: "span",
      file: "entry.ts",
      start: value.indexOf("BbSdk"),
      before: "BbSdk",
      after: "OmnyoSdk",
      context: "Partial edit inside deferred token union",
    }),
  ]);

  expect(
    poisoned.conflicts.some(({ message }) => /overlapping edits/.test(message)),
  ).toBe(true);
  expect(() => apply(root, poisoned)).toThrow();
  expect(text(root, "entry.ts")).toBe(value);
});
