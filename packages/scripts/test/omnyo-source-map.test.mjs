import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  bindUntouchedFileDeferrals,
  collectSourceBindings,
  collectPackageReferenceResiduals,
  deferRemainingCandidates,
  materializePackageModuleOperations,
  materializePackageConsumerOperations,
  materializePathOperations,
  materializeSymbolOperations,
  moduleTarget,
  packageTarget,
  pathTarget,
} from "../../../scripts/omnyo-source-map.mjs";
import {
  applyRenamePlan,
  createRenamePlan,
} from "../../../scripts/omnyo-rename.mjs";

import { materializeRuntimeOutputOperations } from "../../../scripts/omnyo-runtime-path-map.mjs";

const roots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "omnyo-map-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);

  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), value);
  }

  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("maps owned package identities once without collapsing reserved plugin IDs", () => {
  expect(packageTarget("bb-plugin-bb--account-usage")).toBe(
    "omnyo-plugin-omnyo--account-usage",
  );
  expect(packageTarget("bb-plugin-account-usage")).toBe(
    "omnyo-plugin-account-usage",
  );
  expect(packageTarget("@get-bb/plugin-sdk")).toBe("@omnyo/plugin-sdk");
  expect(packageTarget("tinyglobby")).toBeUndefined();
  const packages = new Map([["@get-bb/plugin-sdk", "@omnyo/plugin-sdk"]]);
  expect(moduleTarget("@get-bb/plugin-sdk/app", packages)).toBe(
    "@omnyo/plugin-sdk/app",
  );
  expect(moduleTarget("@get-bb/plugin-sdk-foreign", packages)).toBeUndefined();
});

test("materializes package and AST import edits while retaining opaque literal context", () => {
  const source =
    'import { value } from "@bb/config"; const saved = "@bb/config";';

  const root = fixture({
    "package.json":
      '{"name":"@bb/config","scripts":{"check":"turbo run typecheck --filter=@bb/config"}}',
    "entry.ts": source,
  });

  const bindings = collectSourceBindings(root);

  const manifest = materializePackageModuleOperations({
    root,
    owner: "fixture",
    bindings,
  });

  const initial = createRenamePlan({ root, manifest });
  expect(initial.conflicts).toEqual([]);
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });
  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe(
    'import { value } from "@omnyo/config"; const saved = "@bb/config";',
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg).toEqual({
    name: "@omnyo/config",
    private: true,
    scripts: { check: "turbo run typecheck --filter=@omnyo/config" },
  });
});

test("detects target package convergence before any source writes", () => {
  const root = fixture({
    "one/package.json": '{"name":"@bb/plugin-sdk"}',
    "two/package.json": '{"name":"@get-bb/plugin-sdk"}',
  });

  const report = collectSourceBindings(root);
  expect(report.collisions).toEqual([
    {
      target: "@omnyo/plugin-sdk",
      files: ["one/package.json", "two/package.json"],
    },
  ]);
  expect(readFileSync(join(root, "one/package.json"), "utf8")).toBe(
    '{"name":"@bb/plugin-sdk"}',
  );
});

test("separates declaration proposals from serialized fields and preserves third-party symbol names", () => {
  const root = fixture({
    "entry.ts":
      "export function getBbTurnId(bb: number) { const bbeditIcon = 1; return bb + bbeditIcon; }\nexport interface Wire { bbVersion: string }",
  });

  const report = collectSourceBindings(root);
  expect(
    report.declarations.find((item) => item.before === "getBbTurnId"),
  ).toMatchObject({ proposed: "getAppTurnId", serialized: false });
  expect(
    report.declarations.find((item) => item.before === "bbVersion"),
  ).toMatchObject({
    proposed: "coreVersion",
    serialized: true,
    treatment: "await-existing-state-owner",
  });
  expect(
    report.declarations.find((item) => item.before === "bbeditIcon"),
  ).toMatchObject({ proposed: null, treatment: "third-party-identity" });
});

test("maps explicit owned path families while retaining applied SQL and historical proof paths", () => {
  expect(pathTarget("packages/bb-app/src/launcher.ts")).toBe(
    "packages/omnyo-app/src/launcher.ts",
  );
  expect(pathTarget("apps/desktop/src/bb-process.ts")).toBe(
    "apps/desktop/src/app-process.ts",
  );
  expect(
    pathTarget("apps/app/src/assets/workspace-open-target-icons/bbedit.png"),
  ).toBeUndefined();
  expect(
    pathTarget("packages/db/drizzle/0063_broken_robbie_robertson.sql"),
  ).toBeUndefined();
  expect(pathTarget("docs/evidence/bb-stability/old-bb.png")).toBeUndefined();
});

test("couples both owned script-bin tokens and outputs while retaining legacy input paths", () => {
  const source = "export const operation = 1;\n";

  const root = fixture({
    "packages/scripts/package.json": JSON.stringify({
      name: "@omnyo/scripts",
      private: true,
      bin: {
        "bb-script-archive-codex-tmp-bb-sessions":
          "./dist/commands/archive-codex-tmp-bb-sessions.js",
        "bb-script-reset-bb-data": "./dist/commands/reset-bb-data.js",
      },
      legacyInput: "./history/reset-bb-data.js",
    }),
    "packages/scripts/src/commands/archive-codex-tmp-bb-sessions.ts": source,
    "packages/scripts/src/commands/reset-bb-data.ts": source,
  });

  const bindings = collectSourceBindings(root);

  const metadata = materializePackageModuleOperations({
    root,
    owner: "fixture",
    bindings,
  });

  const paths = materializePathOperations({ root, owner: "fixture", bindings });

  const manifest = {
    schema: 1,
    candidate: { root, owner: "fixture" },
    operations: [...metadata.operations, ...paths.operations],
  };

  const initial = createRenamePlan({ root, manifest });
  expect(initial.conflicts).toEqual([]);
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });
  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });

  const pkg = JSON.parse(
    readFileSync(join(root, "packages/scripts/package.json"), "utf8"),
  );

  expect(pkg.bin).toEqual({
    "omnyo-script-archive-codex-tmp-omnyo-sessions":
      "./dist/commands/archive-codex-tmp-omnyo-sessions.js",
    "omnyo-script-reset-omnyo-data": "./dist/commands/reset-omnyo-data.js",
  });
  expect(pkg.legacyInput).toBe("./history/reset-bb-data.js");

  for (const [before, after] of [
    ["archive-codex-tmp-bb-sessions", "archive-codex-tmp-omnyo-sessions"],
    ["reset-bb-data", "reset-omnyo-data"],
  ]) {
    expect(
      existsSync(join(root, `packages/scripts/src/commands/${before}.ts`)),
    ).toBe(false);
    expect(
      readFileSync(
        join(root, `packages/scripts/src/commands/${after}.ts`),
        "utf8",
      ),
    ).toBe(source);
  }
});

test.each([
  ["createBbSdk", "createOmnyoSdk"],
  ["RESERVED_BB_CLI_COMMANDS", "RESERVED_CORE_CLI_COMMANDS"],
  ["DEFAULT_BB_REQUEST_TIMEOUT_MS", "DEFAULT_CORE_REQUEST_TIMEOUT_MS"],
])(
  "materializes semantic references for %s while preserving opaque literals",
  (before, after) => {
    const root = fixture({
      "entry.ts": `export const ${before} = 1;\nconst saved = "${before}";`,
      "consumer.ts": `import {${before}} from "./entry"; const selected = ${before};`,
    });

    const report = materializeSymbolOperations({
      root,
      owner: "fixture",
      names: [before],
    });

    expect(report.refusals).toEqual([]);
    expect(report.operations).toHaveLength(3);
    const initial = createRenamePlan({ root, manifest: report });
    expect(initial.unresolved).toHaveLength(1);

    const bounded = deferRemainingCandidates({
      root,
      manifest: report,
      plan: initial,
    });

    const plan = createRenamePlan({ root, manifest: bounded });
    expect(plan.conflicts).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
    roots.push(journal, `${journal}.staging`);
    applyRenamePlan({ root, plan, journalPath: journal });
    expect(readFileSync(join(root, "consumer.ts"), "utf8")).toBe(
      `import {${after}} from "./entry"; const selected = ${after};`,
    );
    expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe(
      `export const ${after} = 1;\nconst saved = "${before}";`,
    );
  },
);

test("reports a semantic target collision rather than generating unsafe source writes", () => {
  const root = fixture({
    "entry.ts":
      "export function go(bb: number, api: number) { return bb + api; }",
  });

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    names: ["bb"],
  });

  expect(report.operations).toEqual([]);
  expect(report.refusals).toHaveLength(1);
  expect(report.refusals[0].reason).toMatch(/collision/i);
});

test("moves the exact source and updates relative imports and public export subpaths together", () => {
  const root = fixture({
    "packages/config/package.json":
      '{"name":"@bb/config","private":true,"exports":{"./bb-app-managed-config":{"source":"./src/bb-app-managed-config.ts"}}}',
    "packages/config/src/bb-app-managed-config.ts": "export const value = 1;",
    "entry.ts":
      'import {value} from "./packages/config/src/bb-app-managed-config.js"; export {value} from "@bb/config/bb-app-managed-config";',
  });

  const bindings = collectSourceBindings(root);

  const metadata = materializePackageModuleOperations({
    root,
    owner: "fixture",
    bindings,
  });

  const paths = materializePathOperations({ root, owner: "fixture", bindings });

  const manifest = {
    ...metadata,
    operations: [...metadata.operations, ...paths.operations],
  };

  const plan = createRenamePlan({ root, manifest });
  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe(
    'import {value} from "./packages/config/src/managed-app-config.js"; export {value} from "@omnyo/config/managed-app-config";',
  );
  expect(
    JSON.parse(readFileSync(join(root, "packages/config/package.json"), "utf8"))
      .exports,
  ).toEqual({
    "./managed-app-config": { source: "./src/managed-app-config.ts" },
  });
  expect(
    readFileSync(
      join(root, "packages/config/src/managed-app-config.ts"),
      "utf8",
    ),
  ).toBe("export const value = 1;");
});

test("blocks an unowned SDK registry pin until the existing pack owner supplies the private tarball", () => {
  const root = fixture({
    "plugin/package.json":
      '{"name":"bb-plugin-example","private":true,"devDependencies":{"@get-bb/plugin-sdk":"0.6.44"}}',
  });

  const missing = materializePackageModuleOperations({
    root,
    owner: "fixture",
  });

  expect(
    missing.operations.find(
      (operation) => operation.selector.before === "@get-bb/plugin-sdk",
    ).disposition,
  ).toBe("blocked");

  const mapped = materializePackageModuleOperations({
    root,
    owner: "fixture",
    sdkTarball: "vendor/omnyo-plugin-sdk-0.6.44.tgz",
  });

  const pin = mapped.operations.find(
    (operation) => operation.selector.before === "0.6.44",
  );

  expect(pin.selector.after).toBe("file:../vendor/omnyo-plugin-sdk-0.6.44.tgz");
  expect(pin.disposition).toBe("blocked");
  expect(readFileSync(join(root, "plugin/package.json"), "utf8")).toContain(
    '"@get-bb/plugin-sdk":"0.6.44"',
  );
});

test("maps parsed build tasks and module-resolution constants while retaining arbitrary source strings", () => {
  const root = fixture({
    "package.json": '{"name":"@bb/config","private":true}',
    "scripts/build.mjs":
      'const sdkPackage = "@bb/config"; const tasks = ["@bb/config#build", "--filter=@bb/config..."];',
    "turbo.json":
      '{"tasks":{"@bb/config#build":{"dependsOn":["@bb/config#typecheck"]}}}',
    "entry.ts": 'export const savedUserValue = "@bb/config";',
  });

  const bindings = collectSourceBindings(root);

  const packages = materializePackageModuleOperations({
    root,
    owner: "fixture",
    bindings,
    includePaths: false,
  });

  const consumers = materializePackageConsumerOperations({
    root,
    owner: "fixture",
    bindings,
  });

  expect(
    consumers.operations.some(
      (operation) => operation.selector.file === "entry.ts",
    ),
  ).toBe(false);

  const manifest = {
    ...packages,
    operations: [...packages.operations, ...consumers.operations],
  };

  const initial = createRenamePlan({ root, manifest });
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });
  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  expect(readFileSync(join(root, "scripts/build.mjs"), "utf8")).toBe(
    'const sdkPackage = "@omnyo/config"; const tasks = ["@omnyo/config#build", "--filter=@omnyo/config..."];',
  );
  expect(
    JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")).tasks,
  ).toHaveProperty("@omnyo/config#build");
  expect(readFileSync(join(root, "entry.ts"), "utf8")).toContain(
    '"@bb/config"',
  );
});

test("renames app source aliases and reexport contracts together", () => {
  const root = fixture({
    "apps/app/tsconfig.json":
      '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    "apps/app/src/api.ts": "export class BbHttpError extends Error {}",
    "apps/app/src/barrel.ts": 'export { BbHttpError } from "@/api";',
    "apps/app/src/consumer.ts":
      'import { BbHttpError } from "@/barrel"; export const current = BbHttpError;',
  });

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    names: ["BbHttpError"],
  });

  expect(report.refusals).toEqual([]);
  const initial = createRenamePlan({ root, manifest: report });

  const bounded = deferRemainingCandidates({
    root,
    manifest: report,
    plan: initial,
  });

  const result = createRenamePlan({ root, manifest: bounded });

  expect(result.conflicts).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan: result, journalPath: journal });
  expect(readFileSync(join(root, "apps/app/src/barrel.ts"), "utf8")).toBe(
    'export { OmnyoHttpError } from "@/api";',
  );
  expect(readFileSync(join(root, "apps/app/src/consumer.ts"), "utf8")).toBe(
    'import { OmnyoHttpError } from "@/barrel"; export const current = OmnyoHttpError;',
  );
});

test("renames shared app hook member keys without treating a lexical hook as a sibling", () => {
  const root = fixture({
    "api.ts":
      "export interface PluginApp { useBbNavigate(): void } export function experimental_useAppNavigate() {} export const app: PluginApp = { useBbNavigate: experimental_useAppNavigate }; app.useBbNavigate();",
  });

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    names: ["useBbNavigate"],
    includeSerialized: true,
  });

  expect(report.refusals).toEqual([]);
  expect(report.operations).toHaveLength(3);
});

test("binds one selected package and every declared consumer without changing unrelated package owners", () => {
  const root = fixture({
    "packages/config/package.json": '{"name":"@bb/config","private":true}',
    "packages/other/package.json":
      '{"name":"@bb/other","dependencies":{"@bb/config":"workspace:*","@get-bb/plugin-sdk":"workspace:*"}}',
    "consumer.ts":
      'import "@bb/config"; import "@bb/other"; import "@get-bb/plugin-sdk";',
  });

  const report = materializePackageModuleOperations({
    root,
    owner: "fixture",
    selectedPackages: ["@bb/config"],
    includePaths: false,
  });

  expect(report.operations.map((item) => item.selector.before)).toEqual([
    "@bb/config",
    "@bb/config",
    "@bb/config",
  ]);
  expect(report.operations.some((item) => item.disposition === "blocked")).toBe(
    false,
  );
});

test("finds owned camel-case brand suffix declarations without matching unrelated words", () => {
  const root = fixture({
    "package.json": '{"name":"@omnyo/suffix-fixture","private":true}',
    "entry.ts":
      'export function fakeBb() { return 42; } const github = "upstream"; const rabbit = "user text"; export const result = fakeBb(); export const saved = "fakeBb";',
  });

  const bindings = collectSourceBindings(root);
  expect(
    bindings.declarations.find((item) => item.before === "fakeBb"),
  ).toMatchObject({
    file: "entry.ts",
    proposed: "fakeOmnyo",
    serialized: false,
  });
  expect(
    bindings.declarations.some(
      (item) => item.before === "github" || item.before === "rabbit",
    ),
  ).toBe(false);

  const unbound = createRenamePlan({
    root,
    manifest: {
      schema: 1,
      candidate: { root, owner: "fixture" },
      inputs: [],
      operations: [],
    },
  });

  expect(
    unbound.unresolved.filter((item) => item.context === "Identifier"),
  ).toHaveLength(2);

  const manifest = materializeSymbolOperations({
    root,
    owner: "fixture",
    bindings,
    names: ["fakeBb"],
  });

  expect(manifest.refusals).toEqual([]);
  const initial = createRenamePlan({ root, manifest });
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });
  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);

  const journal = join(
    root,
    "..",
    `${root.split("/").at(-1)}.suffix.journal.json`,
  );

  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  const output = readFileSync(join(root, "entry.ts"), "utf8");
  expect(output).toContain("function fakeOmnyo()");
  expect(output).toContain("result = fakeOmnyo()");
  expect(output).toContain('const github = "upstream"');
  expect(output).toContain('const rabbit = "user text"');
  expect(output).toContain('saved = "fakeBb"');
});

test("binds uppercase SDK facade factories as owned declarations", () => {
  const root = fixture({
    "entry.ts":
      "export class BBSdk {} export function createBBSdk() { return new BBSdk(); }",
  });

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    names: ["BBSdk", "createBBSdk"],
  });

  expect(report.refusals).toEqual([]);
  expect(report.operations.map((item) => item.selector.after)).toEqual([
    "OmnyoSdk",
    "OmnyoSdk",
    "createOmnyoSdk",
  ]);
});

test("composes one shorthand property and its local binding when both owners rename", () => {
  const root = fixture({
    "entry.ts":
      "interface Info { bbAppVersion: string } export function make(bbAppVersion: string): Info { return { bbAppVersion }; }",
  });

  const bindings = collectSourceBindings(root);
  bindings.declarations = bindings.declarations.map((item) => ({
    ...item,
    proposed: "coreVersion",
  }));

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    bindings,
    names: ["bbAppVersion"],
    includeSerialized: true,
  });

  expect(report.refusals).toEqual([]);
  expect(report.operations.map((item) => item.selector.after)).toEqual([
    "coreVersion",
    "coreVersion",
    "coreVersion",
  ]);
});

test("refuses differing targets for the same exact declaration even when pending ranges are deferred", () => {
  const root = fixture({ "entry.ts": "export const bbThreadId = 1;" });
  const bindings = collectSourceBindings(root);
  bindings.declarations.push({
    ...bindings.declarations[0],
    proposed: "otherThreadId",
  });

  const report = materializeSymbolOperations({
    root,
    owner: "fixture",
    bindings,
  });

  expect(report.refusals).toHaveLength(1);
  const result = createRenamePlan({ root, manifest: report });

  expect(
    result.conflicts.some((item) => item.message.includes("semantic refusals")),
  ).toBe(true);
});

test("migrates dependency consumers whose own package was already renamed", () => {
  const root = fixture({
    "packages/config/package.json": '{"name":"@bb/config","private":true}',
    "packages/plugin-sdk/package.json":
      '{"name":"@omnyo/plugin-sdk","private":true,"devDependencies":{"@bb/config":"workspace:*"}}',
    "docs/omnyo-migration/execution-package-identities.json": JSON.stringify({
      schema: 1,
      packages: [
        {
          file: "packages/config/package.json",
          before: "@bb/config",
          after: "@omnyo/config",
        },
        {
          file: "packages/plugin-sdk/package.json",
          before: "@get-bb/plugin-sdk",
          after: "@omnyo/plugin-sdk",
        },
      ],
    }),
  });

  const report = materializePackageModuleOperations({
    root,
    owner: "fixture",
    selectedPackages: ["@bb/config"],
    includePaths: false,
  });

  expect(
    report.operations.some(
      (item) =>
        item.selector.file === "packages/plugin-sdk/package.json" &&
        item.selector.kind === "jsonPath" &&
        item.selector.path.join("/") === "devDependencies/@bb/config",
    ),
  ).toBe(true);
  expect(
    collectPackageReferenceResiduals({
      root,
      selectedPackages: ["@bb/config"],
    }),
  ).toContainEqual({
    file: "packages/plugin-sdk/package.json",
    kind: "dependency-key",
    field: "devDependencies",
    before: "@bb/config",
  });
});

test("couples canonical runtime bins, physical sources and exact artifact consumers while retaining finite legacy input", () => {
  const root = fixture({
    "packages/bb-app/package.json": JSON.stringify({
      name: "omnyo-app",
      bin: { "bb-app": "dist/bb-app.js", bb: "dist/bb.js" },
      exports: { "./dist/bb-app.js": "./dist/bb-app.js" },
    }),
    "apps/cli/package.json": JSON.stringify({
      name: "@omnyo/cli",
      bin: { bb: "./bin/bb" },
    }),
    "packages/bb-app/scripts/build.mjs":
      'const entrypoints = [["omnyo-app", "bb-app.js"], ["bb", "bb.js"]];',
    "packages/bb-app/src/bin/bb-app.ts": "export const value = 1;",
    "packages/bb-app/src/bin/bb.ts": "export const value = 2;",
    "apps/cli/bin/bb": "#!/bin/sh\nexit 0\n",
    "consumer.ts":
      'import "omnyo-app/dist/bb-app.js"; const path = "./bb-chunks/chunk-X.js";',
    "legacy-runtime-v1.ts": 'export const legacyRuntimeV1 = "dist/bb-app.js";',
  });

  const manifest = materializeRuntimeOutputOperations({
    root,
    owner: "fixture",
  });

  const initial = createRenamePlan({ root, manifest });
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });

  expect(plan.conflicts).toEqual([]);
  expect(plan.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  expect(
    JSON.parse(readFileSync(join(root, "packages/bb-app/package.json"), "utf8"))
      .bin,
  ).toEqual({ "omnyo-app": "dist/omnyo-app.js", omnyo: "dist/omnyo.js" });
  expect(
    readFileSync(join(root, "packages/bb-app/src/bin/omnyo-app.ts"), "utf8"),
  ).toContain("value = 1");
  expect(readFileSync(join(root, "consumer.ts"), "utf8")).toBe(
    'import "omnyo-app/dist/omnyo-app.js"; const path = "./omnyo-chunks/chunk-X.js";',
  );
  expect(readFileSync(join(root, "legacy-runtime-v1.ts"), "utf8")).toBe(
    'export const legacyRuntimeV1 = "dist/bb-app.js";',
  );
  expect(
    JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")).bin,
  ).toEqual({ omnyo: "./bin/omnyo" });
});

test("composes a shared member and its shorthand destructuring local in the same rename", () => {
  const root = fixture({
    "entry.ts":
      "interface Host { bb: number }; const host: Host = { bb: 1 }; const { bb } = host; export const value = bb;",
  });

  const bindings = collectSourceBindings(root);

  const manifest = materializeSymbolOperations({
    root,
    owner: "fixture",
    bindings,
    names: ["bb"],
    includeSerialized: true,
  });

  const initial = createRenamePlan({ root, manifest });
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const plan = createRenamePlan({ root, manifest: bounded });

  expect(manifest.refusals).toEqual([]);
  expect(plan.conflicts).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan, journalPath: journal });
  const result = readFileSync(join(root, "entry.ts"), "utf8");
  expect(result).toContain("const { api } = host");
  expect(result).toContain("value = api");
  expect(result).not.toMatch(/\bbb\b/);
});

test("maps imported Vitest module factories while preserving shadowed calls and opaque text", () => {
  const root = fixture({
    "package.json": '{"name":"@bb/config"}',
    "entry.ts":
      'import {vi as tools} from "vitest"; tools.mock("@bb/config"); tools.importActual("@bb/config"); function user(){const tools={mock(value:string){return value}}; return tools.mock("@bb/config")}; const saved="@bb/config";',
  });

  const bindings = collectSourceBindings(root);
  expect(
    bindings.modules.filter((value) => value.before === "@bb/config"),
  ).toHaveLength(2);
  const selected = collectSourceBindings(root, { files: ["entry.ts"] });
  expect(selected.scope.complete).toBe(false);
  expect(selected.packages).toEqual([]);
  expect(
    selected.modules.filter((value) => value.before === "@bb/config"),
  ).toHaveLength(2);
  expect(() => collectSourceBindings(root, { files: ["outside.ts"] })).toThrow(
    "outside the current universe",
  );
});

test("keeps parsed member identifiers independent from raw literal, comment, and regex branding", () => {
  const source =
    'const bb = { name: 1 }; bb.name; const saved = "bb.name"; const pattern = /bb.name/; // bb.name\n';

  const root = fixture({ "entry.ts": source });
  const bindings = collectSourceBindings(root);

  const manifest = materializeSymbolOperations({
    root,
    owner: "fixture",
    bindings,
    names: ["bb"],
  });

  expect(manifest.refusals).toEqual([]);
  const initial = createRenamePlan({ root, manifest });
  expect(initial.conflicts).toEqual([]);
  const bounded = deferRemainingCandidates({ root, manifest, plan: initial });
  const final = createRenamePlan({ root, manifest: bounded });
  expect(final.conflicts).toEqual([]);
  expect(final.unresolved).toEqual([]);
  const journal = join(root, "..", `${root.split("/").at(-1)}.journal.json`);
  roots.push(journal, `${journal}.staging`);
  applyRenamePlan({ root, plan: final, journalPath: journal });
  expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe(
    source.replace("const bb", "const api").replace("; bb.name", "; api.name"),
  );
  expect(
    final.deferred.filter((entry) => entry.start !== undefined),
  ).toHaveLength(3);
});

test("keeps a declared owner deferral without adding an overlapping untouched file", () => {
  const source = 'export const pending = "bb_workflow_run";\n';
  const root = fixture({ "pending.ts": source });
  const digest = createHash("sha256").update(source).digest("hex");

  const operation = {
    id: "inventory-owner",
    rule_id: "R15",
    ledger_ids: ["ROOT-002"],
    proof_ids: ["V01-source-transform"],
    migration_ids: [],
    owner: "fixture",
    selector: {
      kind: "defer",
      file: "pending.ts",
      digest,
      phase: "P3",
      reason: "Rebuild through the exact inventory owner before acceptance",
    },
  };

  const manifest = {
    schema: 1,
    candidate: { root, owner: "fixture" },
    inputs: [{ file: "pending.ts", digest }],
    operations: [operation],
  };

  const bounded = bindUntouchedFileDeferrals({ root, manifest });
  const plan = createRenamePlan({ root, manifest: bounded });
  expect(plan.conflicts).toEqual([]);
  expect(plan.deferred).toHaveLength(1);
  expect(plan.deferred[0]).toMatchObject({
    owner: "fixture",
    phase: "P3",
    reason: operation.selector.reason,
  });
  expect(readFileSync(join(root, "pending.ts"), "utf8")).toBe(source);
  writeFileSync(join(root, "pending.ts"), source + "changed");
  expect(
    createRenamePlan({ root, manifest: bounded }).conflicts.length,
  ).toBeGreaterThan(0);
});
