import { expect, it } from "vitest";
import { resolveSelectedMetadataEdge } from "../../../scripts/omnyo-rename/selected-path-edges.mjs";

const ownerFile = "packages/config/package.json";

const before = "./src/bb-app-managed-config.ts";

const after = "./src/managed-app-config.ts";

it("does not rewrite a package export when only a same-basename source in another owner will move", () => {
  expect(
    resolveSelectedMetadataEdge({
      ownerFile,
      before,
      after,
      selectedPaths: [
        {
          before: "apps/server/src/services/system/bb-app-managed-config.ts",
          after: "apps/server/src/services/system/managed-app-config.ts",
        },
      ],
    }),
  ).toBeNull();
});

it("rewrites the actual selected package-owned source export", () => {
  expect(
    resolveSelectedMetadataEdge({
      ownerFile,
      before,
      after,
      selectedPaths: [
        {
          before: "packages/config/src/bb-app-managed-config.ts",
          after: "packages/config/src/managed-app-config.ts",
        },
      ],
    }),
  ).toEqual({
    ownerFile,
    sourceBefore: "packages/config/src/bb-app-managed-config.ts",
    sourceAfter: "packages/config/src/managed-app-config.ts",
  });
});

const aliases = [
  {
    ownerRoot: "apps/app",
    specifierPrefix: "@/",
    sourceRoot: "apps/app/src",
  },
];

const selectedModulePaths = [
  {
    before: "apps/app/src/components/ui/bb-logo.tsx",
    after: "apps/app/src/components/ui/omnyo-logo.tsx",
  },
];

it("binds a moved module through its actual configured app alias", () => {
  expect(
    resolveSelectedMetadataEdge({
      ownerFile: "apps/app/src/components/tools/SkillsCollection.tsx",
      before: "@/components/ui/bb-logo",
      after: "@/components/ui/omnyo-logo",
      aliases,
      selectedPaths: selectedModulePaths,
    }),
  ).toEqual({
    ownerFile: "apps/app/src/components/tools/SkillsCollection.tsx",
    sourceBefore: "apps/app/src/components/ui/bb-logo.tsx",
    sourceAfter: "apps/app/src/components/ui/omnyo-logo.tsx",
  });
});

it("refuses the app alias from a different source owner", () => {
  expect(
    resolveSelectedMetadataEdge({
      ownerFile: "plugins/tasks/app.tsx",
      before: "@/components/ui/bb-logo",
      after: "@/components/ui/omnyo-logo",
      aliases,
      selectedPaths: selectedModulePaths,
    }),
  ).toBeNull();
});

it("does not guess an alias target from a matching basename", () => {
  expect(
    resolveSelectedMetadataEdge({
      ownerFile: "apps/app/src/components/tools/SkillsCollection.tsx",
      before: "@/components/ui/bb-logo",
      after: "@/components/ui/omnyo-logo",
      aliases,
      selectedPaths: [
        {
          before: "plugins/tasks/components/ui/bb-logo.tsx",
          after: "plugins/tasks/components/ui/omnyo-logo.tsx",
        },
      ],
    }),
  ).toBeNull();
});
