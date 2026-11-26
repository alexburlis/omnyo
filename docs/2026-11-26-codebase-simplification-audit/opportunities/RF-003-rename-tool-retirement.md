# RF-003 — Retire the source rename tool after its last run

## Rank and disposition

Decision and evidence required. High confidence in the 6,220-line source footprint, low confidence in current operator reachability. Medium effort, low production runtime risk and high recovery risk if an unfinished journal exists. Independent of runtime branding and stored-data compatibility.

## Context and evidence

Proven by inspection and line count at `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. `scripts/omnyo-rename.mjs` coordinates `plan`, `apply`, `resume` and `check`. `scripts/omnyo-source-map.mjs`, the other `scripts/omnyo-*-map.mjs` files, the inventory and `scripts/omnyo-rename/*.mjs` resolve source edits and bind them to a Git snapshot and journal. Repository references outside the implementation lead to dedicated `packages/scripts/test/omnyo-*.test.mjs` fixtures. `scripts/omnyo-rename/README.md` documents live operator commands with external journals. Nothing in a scoped repository reference search proves that an external operator, fork, CI workflow or unfinished journal is gone. The pinned public commit has no `.github` tree to inspect.

## Proposed end state and preservation argument

If the maintainer confirms the operation is finished and supported owners have no unfinished or scheduled runs, preserve the exact last working revision and retire the specific source operation from main. Keep operational data migrations, compatibility keys, upgrade paths and the existing product's names and wire formats. A manually invoked command is an entry point until the operator confirms retirement.

## Expected gain and cost

Measured with `git ls-files 'scripts/omnyo-*.mjs' 'scripts/omnyo-rename/*.mjs' | xargs wc -l`, the 12 files total 6,220 handwritten lines. That is the upper bound for implementation removed if every map shares the same last consumer. Dedicated tests and README lines are separate and were excluded. A retirement note with the last revision adds a few lines. The entire plan/apply/resume/check workflow would disappear from main. The expected production runtime effect is none once supported callers are resolved.

## Execution steps

1. Ask the maintainers of private release/source workflows, downstream backports and rename migrations about active plans, journals and supported manual invocations. Obtain completion or retain the operation. Check the known release/CI repositories or branches with their owners. Search exact script filenames, CLI verbs, dedicated test names and npm entry points in tracked source and CI configuration. Do not open journal contents to prove existence.
2. Record the recoverable last commit and how to run it with the original expected Node/toolchain. Verify that the retained revision can still be checked out by the operators who need historical recovery.
3. Remove `scripts/omnyo-rename.mjs`, the inventory and map files that only feed it, `scripts/omnyo-rename/` and the dedicated fixtures under `packages/scripts/test/`. Verify each file before deletion. Remove only rename-tool references. If a map has another owner, retain it and revise the count.
4. Search exact deleted paths again, including tests, public guidance and supported CI. Verify runtime compatibility and ordinary tooling through existing checks.

## Verification and acceptance criteria

Use `pnpm --filter @omnyo/scripts test` from the repository root after retirement. Before edits, smoke the existing `plan`/`check` fixtures through `pnpm --filter @omnyo/scripts test test/omnyo-rename.test.mjs test/omnyo-source-map.test.mjs` as a rollback reference. A supported maintainer can locate the last working revision. Regular tests, builds and guidance have no unresolved import or invocation. Runtime compatibility code and migration history remain outside this change.

## Rollback and stop conditions

Revert the retirement change together with the test and docs removals. If any active journal exists, keep the exact source and original execution path until it resolves. Foreign journals and their associated files require separate owner direction.
