import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import { materializeEnvironmentOperations } from "../../../scripts/omnyo-environment-map.mjs";

function inspect(text, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "omnyo-environment-map-"));

  try {
    writeFileSync(join(root, "source.ts"), text);

    return materializeEnvironmentOperations({
      root,
      owner: "fixture",
      files: ["source.ts"],
      pairs: [["BB_DATA_DIR", "OMNYO_DATA_DIR"]],
      ...options,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("maps typed reads, writes and definitions while refusing to classify opaque values", () => {
  const result = inspect(
    'const BB_DATA_DIR_ENV = {name: "BB_DATA_DIR"}; process.env.BB_DATA_DIR = config.BB_DATA_DIR; const userValue = "BB_DATA_DIR";',
  );

  expect(result.refusals).toEqual([]);
  expect(result.operations.map((entry) => entry.selector.after)).toEqual([
    "OMNYO_DATA_DIR_ENV",
    "OMNYO_DATA_DIR",
    "OMNYO_DATA_DIR",
    "OMNYO_DATA_DIR",
  ]);
  expect(result.unresolved).toEqual([
    expect.objectContaining({
      before: "BB_DATA_DIR",
      context: "VariableDeclaration",
    }),
  ]);
});

test("refuses a renamed field colliding with a current field", () => {
  expect(
    inspect('const config = { BB_DATA_DIR: "old", OMNYO_DATA_DIR: "new" };')
      .refusals,
  ).toEqual([
    expect.objectContaining({
      reason: "Environment field collision at OMNYO_DATA_DIR",
    }),
  ]);
});

test("refuses to collapse a sanitizer's legacy and current namespace entries", () => {
  expect(
    inspect('const keys = ["BB_DATA_DIR", "OMNYO_DATA_DIR"];', {
      literalFiles: ["source.ts"],
    }).refusals,
  ).toEqual([
    expect.objectContaining({
      reason:
        "Mixed legacy/current environment list requires its versioned owner: BB_DATA_DIR",
    }),
  ]);
});

test("requires exact explicit classification for contract literals and preserves unknown names", () => {
  const result = inspect(
    'const key = "BB_DATA_DIR"; process.env.BB_USER_CONTENT;',
    { literalFiles: ["source.ts"] },
  );

  expect(result.unresolved).toEqual([]);
  expect(result.operations).toHaveLength(1);
  expect(result.operations[0].selector.after).toBe("OMNYO_DATA_DIR");
});

test("binds embedded script and regex tokens only in explicitly classified files", () => {
  const source =
    'const command = `export BB_DATA_DIR="profile"; echo BB_DATA_DIR_OTHER`; const error = /BB_DATA_DIR/u;';

  const unclassified = inspect(source);
  expect(unclassified.operations).toEqual([]);
  expect(unclassified.unresolved).toHaveLength(2);
  const classified = inspect(source, { embeddedFiles: ["source.ts"] });
  expect(classified.unresolved).toEqual([]);
  expect(
    classified.operations.map((operation) => operation.selector.before),
  ).toEqual(["BB_DATA_DIR", "BB_DATA_DIR"]);

  for (const operation of classified.operations)
    expect(
      source.slice(
        operation.selector.start,
        operation.selector.start + operation.selector.before.length,
      ),
    ).toBe("BB_DATA_DIR");
});

test("refuses ambiguous destination mappings before producing edits", () => {
  expect(() =>
    inspect("", {
      pairs: [
        ["BB_DATA_DIR", "OMNYO_DATA_DIR"],
        ["BB_OTHER", "OMNYO_DATA_DIR"],
      ],
    }),
  ).toThrow("not injective");
});
