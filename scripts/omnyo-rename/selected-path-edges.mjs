import { posix } from "node:path";

function ownerRelativePath(ownerFile, value) {
  const path = posix.normalize(posix.join(posix.dirname(ownerFile), value));

  return path === ".." || path.startsWith("../") || posix.isAbsolute(path)
    ? null
    : path;
}

function configuredAliasPath(ownerFile, value, alias) {
  if (
    !ownerFile.startsWith(`${alias.ownerRoot}/`) ||
    !value.startsWith(alias.specifierPrefix) ||
    !alias.sourceRoot.startsWith(`${alias.ownerRoot}/`) ||
    posix.isAbsolute(alias.ownerRoot) ||
    posix.normalize(alias.ownerRoot) !== alias.ownerRoot ||
    alias.ownerRoot === ".." ||
    alias.ownerRoot.startsWith("../")
  )
    return null;

  const path = posix.normalize(
    posix.join(alias.sourceRoot, value.slice(alias.specifierPrefix.length)),
  );

  return path.startsWith(`${alias.sourceRoot}/`) ? path : null;
}

function moduleSourceCandidates(path) {
  return [
    path,
    ...[
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      "/index.ts",
      "/index.tsx",
    ].map((extension) => path + extension),
  ];
}

export function resolveSelectedMetadataEdge({
  ownerFile,
  before,
  after,
  selectedPaths,
  aliases = [],
}) {
  const configured = aliases.filter(
    (alias) =>
      ownerFile.startsWith(`${alias.ownerRoot}/`) &&
      before.startsWith(alias.specifierPrefix) &&
      after.startsWith(alias.specifierPrefix),
  );

  if (configured.length > 1) return null;

  if (configured.length === 1) {
    const sourceBefore = configuredAliasPath(ownerFile, before, configured[0]);
    const sourceAfter = configuredAliasPath(ownerFile, after, configured[0]);

    if (sourceBefore === null || sourceAfter === null) return null;
    const beforeSources = moduleSourceCandidates(sourceBefore);
    const afterSources = moduleSourceCandidates(sourceAfter);

    const selected = selectedPaths.filter(
      (path) =>
        beforeSources.includes(path.before) &&
        afterSources.includes(path.after),
    );

    return selected.length === 1
      ? {
          ownerFile,
          sourceBefore: selected[0].before,
          sourceAfter: selected[0].after,
        }
      : null;
  }

  const sourceBefore = ownerRelativePath(ownerFile, before);
  const sourceAfter = ownerRelativePath(ownerFile, after);

  if (sourceBefore === null || sourceAfter === null) return null;

  const selected = selectedPaths.find(
    (path) => path.before === sourceBefore && path.after === sourceAfter,
  );

  return selected === undefined
    ? null
    : { ownerFile, sourceBefore, sourceAfter };
}
