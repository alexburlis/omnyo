import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  collectSourceBindings,
  materializeSymbolOperations,
} from "../../../scripts/omnyo-source-map.mjs";

function mapConsumer(module, canonicalModules) {
  const root = mkdtempSync(join(tmpdir(), "omnyo-sdk-consumer-"));

  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(
      join(root, "app.ts"),
      `import { useBbNavigate } from ${JSON.stringify(module)}; export const navigate = useBbNavigate();`,
    );

    return materializeSymbolOperations({
      root,
      owner: "fixture",
      bindings: collectSourceBindings(root),
      names: ["useBbNavigate"],
      canonicalModules,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("migrates the actual SDK export and local calls for an explicitly bound external SDK module", () => {
  const result = mapConsumer("@omnyo/plugin-sdk/app", [
    "@omnyo/plugin-sdk/app",
  ]);

  expect(result.refusals).toEqual([]);
  expect(
    result.operations.map((operation) => operation.selector.after),
  ).toEqual(["experimental_useAppNavigate", "experimental_useAppNavigate"]);
});

test("retains an unbound module export while renaming its local alias", () => {
  const result = mapConsumer("@omnyo/plugin-sdk/other", [
    "@omnyo/plugin-sdk/app",
  ]);

  expect(result.refusals).toEqual([]);
  expect(
    result.operations.map((operation) => operation.selector.after),
  ).toEqual([
    "useBbNavigate as experimental_useAppNavigate",
    "experimental_useAppNavigate",
  ]);
});

function mapAliasedSdk(target = "OmnyoSdk") {
  const root = mkdtempSync(join(tmpdir(), "omnyo-sdk-alias-"));

  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "@omnyo/sdk",
        exports: { ".": { source: "./sdk.ts" } },
      }),
    );
    writeFileSync(
      join(root, "sdk.ts"),
      "export interface OmnyoSdk { value: string }",
    );
    writeFileSync(
      join(root, "app.ts"),
      'import type { BbSdk as Stable } from "@omnyo/sdk"; export type { BbSdk as Public } from "@omnyo/sdk"; import type { BbSdk as Foreign } from "other"; const opaque = "BbSdk";',
    );

    return materializeSymbolOperations({
      root,
      owner: "fixture",
      bindings: collectSourceBindings(root),
      names: [],
      aliasedModuleMembers: { "@omnyo/sdk": { BbSdk: target } },
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("canonicalizes an aliased owned SDK export while preserving local and unbound aliases", () => {
  const result = mapAliasedSdk();

  expect(result.refusals).toEqual([]);
  expect(result.operations.map((operation) => operation.selector)).toEqual([
    expect.objectContaining({
      before: "BbSdk",
      after: "OmnyoSdk",
      context: expect.stringContaining("@omnyo/sdk"),
    }),
    expect.objectContaining({
      before: "BbSdk",
      after: "OmnyoSdk",
      context: expect.stringContaining("@omnyo/sdk"),
    }),
  ]);
});

test("refuses a canonical SDK member target absent from the resolved export table", () => {
  expect(() => mapAliasedSdk("MissingSdk")).toThrow(/export/);
});
