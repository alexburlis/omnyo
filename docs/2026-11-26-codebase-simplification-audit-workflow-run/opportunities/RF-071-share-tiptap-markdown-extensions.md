# RF-071 — One registry-owned copy of the Markdown table, tight task-list and task-input tiptap extensions for Docs and Tasks

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and byte-identical, and it is slightly larger than the sweep reported: a third identical extension, `MarkdownTaskInput`, is also copied. Two parts of the sweep's plan were wrong and are corrected here: a registry root must live under `packages/shared-ui/src/components/ui/`, not `src/lib/`, and `packages/plugin-registry/package.json` must also declare the tiptap packages. The Tasks plugin has no `MarkdownLink` at all (it uses the stock `Link`), so only Docs keeps one.
- **Potential:** medium. About 132 lines of duplicated Markdown round-trip rules collapse to one copy. History shows the duplication has already caused a user-visible defect (see Context).
- **Confidence:** medium-high. The identity of the copies is proven by diff. The registry and fork mechanics are proven by reading their scripts. Whether the bundles keep one tiptap instance after the move is a hypothesis with a cheap check.
- **Readiness:** conditional. Alex must accept that `@omnyo/shared-ui` and the public plugin component registry carry a tiptap editor module used by two plugins and not by the app. `docs/forkable-plugins.md` "What belongs in shared-ui" rule 1 describes shared-ui as the home for domain-free primitives that "the app and a plugin" share. This item is domain-free, but it is shared between two plugins and it adds an editor engine to shared-ui's dependency list.
- **Effort:** small, about half a day to one day including the fork check.
- **Risk:** low to medium. The realistic regressions are a Markdown serialization change and a duplicated tiptap or ProseMirror instance inside one plugin bundle. Both have direct checks below.
- **Prerequisites:** the owner decision above. No other RF item is a prerequisite.
- **Related or overlapping RF ids:** none overlap. RF-046 (Tasks glyph module) and RF-069 (Tasks CLI helper) touch other Tasks files. RF-114 touches the Docs CLI, not its editor.
- **Why it deserves its place:** the copied code is the exact part of both editors that decides whether a user's Markdown file survives an edit unchanged. A fix in one copy that misses the other silently corrupts saved files in the other plugin, and that has already happened once.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit worktree was removed before this verification, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`.

Docs (package `omnyo-plugin-simple-notes`, directory `plugins/docs`) and Tasks (package `omnyo-plugin-tasks`, directory `plugins/tasks`) each edit Markdown through tiptap and `tiptap-markdown@0.9.0`. Both load Markdown into the editor and serialize it back on save, so the serializer rules decide whether a file round-trips. Both plugins are listed in `scripts/forkable-plugins.json` (lines 12 and 36), so neither may import the other (`docs/forkable-plugins.md`, rule enforced by the `omnyo/forkable-plugin-imports` lint rule in `scripts/oxlint-plugin.mjs:143` `forkablePluginImports`).

Observed facts (Proven by inspection):

| Block | Docs copy | Tasks copy | Difference |
|---|---|---|---|
| `TightTaskList` (TaskList with a `tight` attribute) | `plugins/docs/editor-extensions.ts:11-26` (exported) | `plugins/tasks/editor/extensions.ts:76-91` (module-local) | only the `export` keyword |
| `TableMarkdownState`, `tableChildren`, `hasMergedCell`, `isMarkdownTable`, `renderTableCell`, `MarkdownTable` | `plugins/docs/editor-extensions.ts:28-125` | `plugins/tasks/editor/extensions.ts:112-209` | only the `export` keyword on `MarkdownTable` |
| `MarkdownTaskInput` (the `[ ] ` / `[x] ` input rule) | `plugins/docs/app.tsx:330-347` | `plugins/tasks/editor/extensions.ts:93-110` | none |

Method: the blocks were extracted with `sed -n` and compared with `diff`; the only output was `export const MarkdownTable` against `const MarkdownTable`. That is 16 + 98 + 18 = 132 duplicated handwritten production lines. The sweep's figure of 114 lines missed `MarkdownTaskInput`, which lives in Docs `app.tsx`, not in `editor-extensions.ts`.

What stays plugin-specific:

- `plugins/docs/editor-extensions.ts:127-188` `MarkdownLink` (autolink and title escaping) is Docs-only. `plugins/docs/markdown-blocks.test.ts:18` imports it. Tasks configures the stock `Link` at `plugins/tasks/editor/extensions.ts:398`.
- Table configuration differs and stays at each call site: Docs uses `MarkdownTable.configure({ resizable: true, lastColumnResizable: false })` at `plugins/docs/app.tsx:530-533`; Tasks uses `MarkdownTable.configure({ renderWrapper: true })` at `plugins/tasks/editor/extensions.ts:402`.
- Mentions, `TrailingParagraph`, `MentionSuggestion` and `createEditorExtensions` in Tasks, and `HtmlBlock`, `HtmlSource`, `HtmlEmbed` and `createProposalDiff` in Docs are plugin-owned.

Consumers (search: `git grep -n -E "isMarkdownTable|TightTaskList|MarkdownTable\b|renderTableCell|data-tight|editor-extensions" e9e1b74c3 -- . ':!*.json'`, whole repository): the only consumers are `plugins/docs/app.tsx:54-58` (import) and `:528-533` (use), and the module-local uses in `plugins/tasks/editor/extensions.ts:400-406`. No app, SDK, server or other plugin code references these symbols. The private plugin repository `$OMNYO_PLUGIN_CHECKOUT` has no Docs or Tasks copy (directory listing). Only `plugins/docs/package.json` and `plugins/tasks/package.json` depend on `tiptap-markdown` or `@tiptap/extension-table` (`git grep -l` over every `package.json`). Nothing is persisted by these extensions except the Markdown they write, which must not change.

History (Proven by inspection, private store `$ARCHIVED_OMNYO_CHECKOUT`): Tasks gained the table serializer in `e4c873521a` "Fix Markdown table rendering in Tasks (#2468)" on 2026-08-27. Docs kept the stock extensions until `12663cf6bf` "Preserve Docs table and task-list Markdown on edit (#6759)" on 2026-11-02, whose description says Docs was "missing the round-trip fixes already in Tasks. Editing a table dropped escapes from code-span pipes and emptied image-only cells; editing a tight task list added blank lines." That PR copied the code because "Direct reuse from Tasks would break standalone plugin forks. No shared-ui, SDK, or protocol changes." So the copy was a deliberate fork-safety choice, and the drift it causes has already corrupted user files once.

Registry and fork mechanics (Proven by inspection):

- `packages/plugin-registry/scripts/build-registry.mjs:120-132` only accepts `uiItems` roots at `packages/shared-ui/src/components/ui/<name>.ts(x)`. A `lib/` file is published only when a `components/ui` root imports it (`classify`, lines 94-114). Non-component `.ts` roots already exist (`activity-row-styles`, `chrome-style-tokens`, `sidebar-row-classes`).
- The registry builder records every non-`react`/`react-dom`/`@omnyo/plugin-sdk` import as an npm `dependencies` entry of the item (lines 166-180).
- `scripts/check-plugin-forks.mjs:247-264` looks up each registry dependency's version in `packages/plugin-registry/package.json` devDependencies and `apps/app/package.json`. `scripts/lib/plugin-fork.mjs:90-110` `registryPackages` throws `no version known for registry dependency <name>` when none is found. `apps/app` declares `@tiptap/core` and `@tiptap/pm` but not `@tiptap/extension-table` or `@tiptap/extension-task-list`, so `packages/plugin-registry/package.json` must declare them.
- `packages/plugin-registry/src/__tests__/vendor-all-items.test.ts` vendors every item into a fixture under `packages/plugin-registry` and builds it with `buildPluginApp`. The tiptap packages must therefore resolve from `packages/plugin-registry`.
- Both plugin tsconfigs map `@/*` to `../../packages/shared-ui/src/*` (`plugins/docs/tsconfig.json`, `plugins/tasks/tsconfig.json`). A file in shared-ui resolves its own npm imports from `packages/shared-ui/node_modules`, so shared-ui must declare the tiptap packages. Its existing pattern for heavy libraries is `peerDependencies` plus matching `devDependencies` (`@dnd-kit/*`, `vaul`).
- The lockfile at the snapshot resolves `@tiptap/core`, `@tiptap/pm`, `@tiptap/extension-table` and `@tiptap/extension-task-list` to identical peer-qualified snapshots for both plugins, all at `3.30.5`. That makes a single shared instance after the move likely. It is still a Hypothesis until the post-change lockfile and bundle are checked.

Existing tests that pin the shared behaviour (Proven by inspection; not run, because the snapshot has no `node_modules`):

- `plugins/tasks/editor/editor.test.tsx:52-110`: round-trip of a tight task list, table rows and cells, an escaped pipe in plain text and in inline code, a pipe in a link destination, and atom-only cells.
- `plugins/docs/app.test.tsx:891-960`: autosave of a table, of code-span pipes with an image-only cell, and of a tight task list, plus table wrapper and style assertions.
- `plugins/docs/raw-html.test.ts:98` and `plugins/docs/markdown-blocks.test.ts:30`: task-list content.
- Gap: no test in either plugin covers the HTML fallback for merged cells (`hasMergedCell`, `git grep -n -i "colspan|rowspan"` finds only the two implementations).

Maintenance cost today: any change to GFM-table eligibility, cell escaping, the merged-cell HTML fallback, tight-list detection or the task input rule needs identical edits and tests in both plugins. Missing one copy corrupts the other plugin's saved Markdown.

**Proposed end state and preservation argument**

What remains: one module, `packages/shared-ui/src/components/ui/tiptap-markdown-extensions.ts`, exporting `TightTaskList`, `MarkdownTable` and `MarkdownTaskInput`, with `TableMarkdownState`, `tableChildren`, `hasMergedCell`, `isMarkdownTable` and `renderTableCell` kept module-private. It is listed in `packages/plugin-registry/registry.json` `uiItems` as `"tiptap-markdown-extensions"`, which publishes it as registry item `tiptap-markdown-extensions` with target `components/ui/tiptap-markdown-extensions.ts`. Both plugins import it as `@/components/ui/tiptap-markdown-extensions`.

What disappears: the Tasks copies at `plugins/tasks/editor/extensions.ts:76-91`, `:93-110` and `:112-209`; the Docs copies at `plugins/docs/editor-extensions.ts:11-125` and `plugins/docs/app.tsx:330-347`; and the imports only those copies used.

Dependency and data flow: plugin source imports `@/components/ui/...`, which resolves to shared-ui source in the monorepo. In a fork, `pnpm check:plugin-forks` writes the registry item's file into the copy and adds the item's npm dependencies, which both plugins already declare with the same versions. No runtime dependency on the host is added: each plugin still bundles its own tiptap, as it does today. The app does not import the module, so the app bundle is unchanged.

Why this is the simplest sufficient option: the registry is the documented, already-enforced route for code shared across forkable plugins. The alternatives are worse. A sibling import breaks forkability. Adding the code to the packed plugin SDK would put tiptap into the SDK's public contract and its minimum-version floor. A cross-plugin parity test keeps both copies and adds a third mechanism.

Preservation argument: the moved code is byte-identical apart from `export`, so serialization rules, extension names (`taskList`, `table`, `markdownTaskInput`), priorities, attributes and the `data-tight` HTML attribute stay identical. Each plugin keeps its own `.configure(...)` call, extension order and other extensions, so editor behaviour and DOM output do not change. Saved Markdown must stay byte-for-byte identical for the existing round-trip fixtures.

Affected contracts: the public registry index (`packages/plugin-registry/r/index.json`) gains one item. That is additive for external plugin authors. No route, RPC, CLI command, settings key, persisted format or SDK export changes.

Non-goals: do not merge `MarkdownLink` into Tasks, do not change table configuration, do not unify `createEditorExtensions` with the Docs editor setup, and do not move tiptap into the app or the SDK.

**Expected gain and cost**

- Before: three duplicated extension definitions (132 identical lines) in two plugins. After: one registry-owned module.
- Projection, not a measurement: about 280 handwritten production lines removed (Docs `editor-extensions.ts` about 120 including its four now-unused import lines; Docs `app.tsx` about 21 including the `Extension` and `InputRule` imports, which only `MarkdownTaskInput` uses (lines 41, 42, 330 and 335 are their only uses); Tasks `extensions.ts` about 140 including the `getHTMLFromFragment`, `InputRule`, `TaskList`, `Table`, `Fragment` and `ProseMirrorNode` imports). About 165 lines are added: the new module (about 145), new import statements in the two plugins (about 10), four tiptap entries each in `peerDependencies` and `devDependencies` of `packages/shared-ui/package.json`, four `devDependencies` in `packages/plugin-registry/package.json`, and one `registry.json` line. The net is about 105-125 fewer handwritten production lines, plus one less mechanism to keep in sync.
- Generated: one new `packages/plugin-registry/r/tiptap-markdown-extensions.json`, an `r/index.json` entry and `pnpm-lock.yaml` changes. These are not counted as handwritten.
- Tests: unchanged unless the optional merged-cell test is added (about 15 lines).
- Cost and tradeoff: shared-ui and plugin-registry gain tiptap dev and peer dependencies (already installed in the workspace for the app and both plugins, so install size barely changes). Shared-ui now contains editor code, which is the owner decision named above.
- Performance: expected neutral, because each plugin still bundles one tiptap copy. This is verified by the bundle-size check below, not assumed.

**Execution steps**

Investigation gate (do this before any edit):

1. Get the owner's decision: may `@omnyo/shared-ui` and the public component registry carry a tiptap editor module that only plugins use? If he declines, stop. The fallback is to keep both copies and add one shared fixture list of round-trip cases to both plugins' tests. That is a smaller, separate change and not this card.
2. Reconfirm the snapshot facts on the current `main`. Re-run the block `diff` (Docs `editor-extensions.ts` table and task-list blocks against Tasks `editor/extensions.ts`, and Docs `app.tsx` `MarkdownTaskInput` against Tasks `MarkdownTaskInput`). If the copies have diverged, stop and decide which behaviour is correct, with a failing test, before moving anything. Confirm that `build-registry.mjs` still requires `components/ui` roots and that `check-plugin-forks.mjs` still takes versions from `packages/plugin-registry/package.json` and `apps/app/package.json`.
3. Record baselines: run the Docs and Tasks test suites and build both plugins. Save the byte sizes of the files under `plugins/docs/dist` and `plugins/tasks/dist` to scratch (`~/scratch/omnyo/<owner-id>--rf-071/`).

Checkpoint A: the mechanical move.

4. Create `packages/shared-ui/src/components/ui/tiptap-markdown-extensions.ts`. Copy `plugins/tasks/editor/extensions.ts:76-91` (`TightTaskList`), `:93-110` (`MarkdownTaskInput`) and `:112-209` (table helpers and `MarkdownTable`) verbatim. Add `export` to `TightTaskList`, `MarkdownTaskInput` and `MarkdownTable` only. Imports: `Extension`, `getHTMLFromFragment` and `InputRule` from `@tiptap/core`; `Table` from `@tiptap/extension-table`; `TaskList` from `@tiptap/extension-task-list`; `Fragment` and `type Node as ProseMirrorNode` from `@tiptap/pm/model`. Use relative or `@/` imports for nothing else, so the registry item has no registry dependencies.
5. `packages/shared-ui/package.json`: add `@tiptap/core`, `@tiptap/pm`, `@tiptap/extension-table` and `@tiptap/extension-task-list` at `3.30.5` to both `peerDependencies` and `devDependencies`, following the `@dnd-kit/*` pattern. An `exports` entry is not needed, because only plugins consume the file through `@/`. Add one only if a check demands it.
6. `packages/plugin-registry/package.json`: add the same four packages at `3.30.5` to `devDependencies`, so `vendor-all-items.test.ts` and `check-plugin-forks.mjs` can resolve them and find versions.
7. `packages/plugin-registry/registry.json`: add `"tiptap-markdown-extensions"` to `uiItems` in alphabetical position.
8. Run `pnpm install` from the repository root to update `pnpm-lock.yaml`. Confirm in the lockfile that the `packages/shared-ui` and `packages/plugin-registry` importers resolve the four packages to the same peer-qualified snapshot strings as `plugins/docs` and `plugins/tasks`, for example `3.30.5(@tiptap/core@3.30.5(@tiptap/pm@3.30.5))(@tiptap/pm@3.30.5)` for `@tiptap/extension-table`. If they differ, stop (see the stop conditions).
9. Regenerate the registry: `pnpm --filter @omnyo/plugin-registry generate`. Expect a new `packages/plugin-registry/r/tiptap-markdown-extensions.json` whose `dependencies` lists exactly the four tiptap packages, and one new `r/index.json` entry.

Checkpoint B: switch the consumers.

10. `plugins/tasks/editor/extensions.ts`: delete lines 76-91, 93-110 and 112-209. Add `import { MarkdownTable, MarkdownTaskInput, TightTaskList } from "@/components/ui/tiptap-markdown-extensions";`. Remove the now-unused `getHTMLFromFragment` and `InputRule` from the `@tiptap/core` import (keep `Extension`, `Node` and `type Extensions`), the `TaskList` import (line 11), the `Table` import (line 14), and `Fragment` and `type Node as ProseMirrorNode` from the `@tiptap/pm/model` import (keep `type DOMOutputSpec`). Leave `createEditorExtensions` (lines 392-424) unchanged.
11. `plugins/docs/editor-extensions.ts`: delete lines 11-125 and the imports only they use (`getHTMLFromFragment`, `Table`, `TaskList` and `Fragment`). Keep `Link`, the `Mark` and `Node` types, `LinkMarkdownState`, `isPlainUrl` and `MarkdownLink`.
12. `plugins/docs/app.tsx`: change the import at lines 54-58 to `import { MarkdownLink } from "./editor-extensions.js";` plus `import { MarkdownTable, MarkdownTaskInput, TightTaskList } from "@/components/ui/tiptap-markdown-extensions";`. Delete `MarkdownTaskInput` at lines 330-347 and remove `Extension` and `InputRule` from the `@tiptap/core` import at lines 39-45. Leave the extension array at lines 524-548 unchanged.
13. Confirm that `plugins/docs/tsconfig.json` (`include: ["*.ts", "*.tsx"]`) and `plugins/tasks/tsconfig.json` (`include: ["**/*.ts", "**/*.tsx"]`) already include the files that now import `@/`. Both do at the snapshot, so `vitest.config.ts` path mapping applies.

Checkpoint C: optional coverage, then cleanup.

14. Optional but recommended, because no test covers it today: add one merged-cell case to `plugins/tasks/editor/editor.test.tsx` "markdown round-trip". Load HTML with `<td colspan="2">`, serialize, and assert that the output is an HTML `<table>` block, not a GFM table. Write it against the current code first, so that it passes before the move and pins the existing behaviour.
15. Inspect the full diff. There must be no remaining definition of `isMarkdownTable`, `renderTableCell`, `TightTaskList` or `MarkdownTaskInput` under `plugins/` (`rg -n "isMarkdownTable|renderTableCell|const TightTaskList|const MarkdownTaskInput" plugins` returns nothing). Recount lines with `git diff --stat` against the baseline.

**Verification and acceptance criteria**

Commands. These scripts were read in the named `package.json` files at the snapshot but not run, because the snapshot has no `node_modules`. Run them from the repository root `$OMNYO_CHECKOUT` or your worktree root:

- `pnpm --filter @omnyo/plugin-registry generate` writes the new item (script `generate` in `packages/plugin-registry/package.json`).
- `pnpm --filter @omnyo/plugin-registry test` runs `build-registry.mjs --check` and `vendor-all-items.test.ts`. Expect a pass, with the new item vendored and built.
- `pnpm --filter @omnyo/plugin-registry typecheck`.
- `pnpm --filter @omnyo/shared-ui typecheck` (script `typecheck`; tsc over `src`, so it needs the tiptap types from step 5).
- `pnpm --filter omnyo-plugin-tasks test`, `pnpm --filter omnyo-plugin-tasks typecheck`, `pnpm --filter omnyo-plugin-tasks lint` and `pnpm --filter omnyo-plugin-tasks build`.
- `pnpm --filter omnyo-plugin-simple-notes test`, `pnpm --filter omnyo-plugin-simple-notes typecheck`, `pnpm --filter omnyo-plugin-simple-notes lint` and `pnpm --filter omnyo-plugin-simple-notes build`. The Docs package name is `omnyo-plugin-simple-notes`, not `docs`.
- `pnpm check:plugin-forks plugins/docs plugins/tasks` (root script `check:plugin-forks`). Expect both copies to list `tiptap-markdown-extensions` under "registry items" and to install, typecheck, test and build.
- `pnpm --filter <package> lint` runs each plugin's `omnyo/forkable-plugin-imports` rule. Expect no "is not a component registry file" report for the new `@/` import.

Behaviour and contract checks:

- Serialization: all existing round-trip cases in `plugins/tasks/editor/editor.test.tsx` and the autosave cases in `plugins/docs/app.test.tsx:891-960` pass without edits to their expected strings. Do not change any expected Markdown.
- Merged cells: the optional test from step 14 passes both before and after the move.
- Task input rule: typing `[ ] ` or `[x] ` at a line start still creates an unchecked or checked task item in both editors. This is covered indirectly by both plugins' task-list tests; Alex checks it in the UI.
- UI: no DOM change is expected. Both editors' table wrappers (`.tableWrapper`), Docs column resizing and Tasks `renderWrapper` behave as before. Alex checks the UI himself, per repository practice.

Performance and bundle integrity:

- Compare the byte sizes of the built `plugins/docs/dist` and `plugins/tasks/dist` app bundles with the step 3 baseline. Expect a difference of no more than a few hundred bytes. A growth in the order of tens of kilobytes means a second copy of `@tiptap/core`, `@tiptap/pm` or a ProseMirror package was bundled from `packages/shared-ui/node_modules`. Treat that as a failure, not noise.

Structural completion:

- Exactly one definition of each moved symbol exists, in `packages/shared-ui/src/components/ui/tiptap-markdown-extensions.ts`.
- `plugins/docs/editor-extensions.ts` contains only the `MarkdownLink` code.
- `plugins/tasks/editor/extensions.ts` keeps no table or task-list serializer code.

**Rollback and stop conditions**

Change boundary: one commit touching the new shared-ui module, `packages/shared-ui/package.json`, `packages/plugin-registry/package.json`, `packages/plugin-registry/registry.json`, the regenerated `packages/plugin-registry/r/` files, `pnpm-lock.yaml`, `plugins/docs/editor-extensions.ts`, `plugins/docs/app.tsx` and `plugins/tasks/editor/extensions.ts`, plus the optional test. Reverting that commit restores the two copies exactly. No persisted data, route or SDK contract changes, so rollback has no compatibility implications. External plugin authors who vendored the new registry item keep a working copy of it.

Stop conditions:

- Alex declines tiptap in shared-ui or the public registry. Keep the copies and use the shared-fixture fallback from step 1.
- The block `diff` in step 2 shows that the copies have diverged. Resolve the intended behaviour with a failing test first.
- The lockfile in step 8 resolves different tiptap snapshots for shared-ui than for the plugins, or the bundle-size check shows a duplicated tiptap instance. Next investigation: pin the four packages as `peerDependencies` only, with `devDependencies` matching the plugins' exact snapshots, or check the pnpm `dedupe-peer-dependents` behaviour. If that cannot guarantee one instance, stop.
- `pnpm check:plugin-forks` fails for either plugin because the fork cannot resolve the item's dependencies. Do not weaken the fork check.
- Any existing round-trip or autosave expectation would need to change to pass. That is a behaviour change, so revert.
