# RF-094 — Delete the private fence scanner in `markdown-local-file-link-normalize.ts` and use the shared fence helpers

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicate is real. The scope is slightly smaller than the sweep claimed (about 33 to 40 production lines, not 35 to 45). The whitespace question the sweep left open is settled by inspection in favor of the shared helper, so the item is ready rather than conditional.
- **Potential:** low to medium. It removes one of two maintained CommonMark fence scanners in the app's Markdown pipeline.
- **Confidence:** high. Both implementations were compared line by line and on a table of inputs (see Context).
- **Readiness:** ready.
- **Effort:** small, about two hours including two characterization tests.
- **Risk:** low. The only behavior change is for a closing fence followed by a non-breaking space, form feed or vertical tab, where the change makes link normalization agree with the renderer.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none. RF-060 (GitHub bodies through the SDK host Markdown) touches Markdown rendering but not this module.
- **Why it deserves its place:** the local-file link normalizer is the only module in the app's Markdown pipeline that still keeps its own fence grammar. Five other modules already share one. A fix to fence detection today needs two edits, and the two copies already disagree on which characters may follow a closing fence.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). All paths are repository-relative.

The web app (`apps/app`) renders chat messages and previews through `react-markdown` (micromark, CommonMark) in `apps/app/src/components/ui/markdown-preview.tsx`. Before rendering, it runs several text pre-passes over the Markdown source. Each pass must skip fenced code blocks, so each needs to know where a fence opens and closes.

Observed facts (Proven by inspection):

1. **The shared fence helpers.** `apps/app/src/components/ui/markdown-prompt-blockquote-boundaries.ts` exports `MarkdownFence` (:10), `trimMarkdownLineCarriageReturn` (:15), `parseMarkdownFenceStart` (:27, pattern `MARKDOWN_FENCE_START_PATTERN` at :1), `isMarkdownFenceClose` (:41), and the any-indent variants `parseAnyIndentMarkdownFenceStart` (:59) and `closesAnyIndentMarkdownFence` (:71). Despite the file name, it is the pipeline's line-grammar module. These five files import fence helpers from it:
   - `apps/app/src/components/ui/markdown-message-directive-repair.ts:1-6`
   - `apps/app/src/components/ui/markdown-math-fences.ts:1-6`
   - `apps/app/src/components/ui/markdown-incremental-pieces.ts:30-39`
   - `apps/app/src/components/ui/markdown-code-fence-renderers.tsx:25-28`
   - `apps/app/src/components/thread/timeline/streaming-markdown-split.ts:3-10`
2. **The private copy.** `apps/app/src/components/ui/markdown-local-file-link-normalize.ts` defines its own `interface MarkdownFence` (:7-10), `type MarkdownFenceCharacter` (:29), `MARKDOWN_FENCE_PATTERN` (:31), `parseMarkdownFence` (:66-84) and `isMarkdownFenceClose` (:86-105). They are used only by the exported `normalizeLocalFileMarkdownLinks` (:522-559) at :528, :535 and :542.
3. **Consumers of the normalizer.** `git grep -n "normalizeLocalFileMarkdownLinks\|markdown-local-file-link-normalize" e9e1b74c3 -- .` finds only `apps/app/src/components/ui/markdown-preview.tsx:63` (import), :2282 (`imageSourceOffset` memo) and :2315 (`markdownContent` memo), plus the test file `apps/app/src/components/ui/markdown-local-file-link-normalize.test.ts`. Neither module is exported from a package, the SDK or the plugin SDK, and no persisted data depends on it. `markdown-preview.tsx:119` already imports the shared module, so the change adds no new bundle edge.
4. **Opening fences are equivalent.** The private copy matches `/^( {0,3})(`{3,}|~{3,})/u` on a line that still carries its trailing `\n` (lines come from `splitMarkdownLines`, :46-64). The shared copy matches `/^(?: {0,3})(`{3,}|~{3,})/u` after removing one trailing `\r`. Both are prefix matches, so trailing characters never change the result. Neither copy implements the CommonMark rule that a backtick fence's info string may not contain backticks, so neither behavior changes there.
5. **Closing fences differ only in which whitespace may follow.** The private `isMarkdownFenceClose` strips `/\r?\n$/` and then accepts any `String.prototype.trim()` whitespace after the marker run. The shared one strips one trailing `\r` and requires `/^[ \t]*$/`. The shared one does not strip `\n`, and JavaScript `$` without the `m` flag does not match before a final newline, so the caller must remove `\n` first.

Reproduced (pure `node -e` computation over verbatim copies of both functions, fence = three backticks; the shared call received the line with one trailing `\n` removed):

| Line | Private result | Shared result |
| --- | --- | --- |
| three backticks + `\n` | close | close |
| three backticks + `\r\n` | close | close |
| three backticks + space, tab + `\n` | close | close |
| three spaces + three backticks + `\n` | close | close |
| four spaces + three backticks + `\n` | not close | not close |
| four backticks + `x\n` | not close | not close |
| three backticks + U+00A0 + `\n` | close | **not close** |
| three backticks + `\f\n` or `\v\n` | close | **not close** |
| three backticks + `\r\r\n` | close | **not close** |

The renderer decides which side is right. In micromark-core-commonmark 2.0.3 (the version in the snapshot's `pnpm-lock.yaml`), `sequenceClose` and `sequenceCloseAfter` in `dev/lib/code-fenced.js` accept only `markdownSpace` (space, tab, virtual space) and then a line ending or end of file after the closing marker run. The check was made against the copy in the main checkout's `node_modules`, at the same version, because the snapshot has no `node_modules`. So for U+00A0, form feed and vertical tab, the renderer agrees with the shared helper. With the private copy, the normalizer treats such a line as a close while the renderer keeps the block open. Local-file links after that line are then rewritten to `<...>` form while they are still rendered as code. The `\r\r\n` row does not matter in practice: `splitMarkdownLines` splits only on `\n`, so the normalizer already ignores bare `\r` line breaks, and fence semantics do not change that.

Searches for other fence scanners (`git grep -n -E '\{3,\}\|~\{3,\}|isMarkdownFenceClose|parseMarkdownFence' e9e1b74c3 -- apps/app packages plugins`, then the same pattern outside `apps/app`):

- `apps/app/src/components/thread/completion-report.ts:17` "removeCompletionReportFromDisplay" has a third, smaller inline fence toggle (13 non-blank lines at :16-30). It is an optional follow-on; see Execution steps.
- `plugins/composer-predictions/server.ts:113` is rejected. Plugins must stay forkable (`docs/forkable-plugins.md`), so a plugin cannot import from `apps/app`.
- `apps/app/src/test/fixtures/streaming-markdown/pathological.ts:288` is rejected. It is a test fixture's independent oracle and should stay independent.

Maintenance cost today: two fence grammars must be kept in step by hand, and they have already drifted (the table above). A reader looking for where the pipeline decides what counts as a fence has to check two places.

**Proposed end state and preservation argument**

What disappears: from `markdown-local-file-link-normalize.ts`, the private `MarkdownFence` interface, the `MarkdownFenceCharacter` type, `MARKDOWN_FENCE_PATTERN`, `parseMarkdownFence` and the private `isMarkdownFenceClose`.

What remains: `normalizeLocalFileMarkdownLinks` imports `parseMarkdownFenceStart`, `isMarkdownFenceClose` and `type MarkdownFence` from `./markdown-prompt-blockquote-boundaries.js`. It passes each line to the close check with its single trailing `\n` removed. `splitMarkdownLines`, the indented-code check and all link-repair logic stay unchanged, and the output still concatenates the original lines, newline included.

Canonical owner: `apps/app/src/components/ui/markdown-prompt-blockquote-boundaries.ts`, which already serves five fence consumers.

How current behavior survives:

- Openers are equivalent (fact 4).
- Closers are equivalent for every line ending in `\n` or `\r\n` and followed by spaces or tabs, which covers all ordinary input (table above).
- The one intentional change: a closing fence followed by U+00A0, form feed or vertical tab no longer ends the fence for link normalization. This matches the renderer, so links the renderer shows as code are no longer rewritten. It is recorded as an incidental finding.
- The returned string is unchanged for all other inputs, so the `imageSourceOffset` length calculation in `markdown-preview.tsx:2280-2288` is unaffected.

Non-goals:

- Do not rename or split `markdown-prompt-blockquote-boundaries.ts` into a `markdown-fences.ts` module. That would only move code, touch six import sites and remove no mechanism. If someone wants the clearer name, do it as a separate mechanical change.
- Do not change the any-indent helpers or other consumers.
- Do not add the backtick-in-info-string rule. That would change behavior in all six consumers and needs its own decision.

Why this is the simplest sufficient option: it is one import plus one newline strip at the single call site, with no new module, adapter type or option flag.

**Expected gain and cost**

- **Removed (measured at the snapshot):** 46 raw lines, 38 of them non-blank (`awk 'NR>=7&&NR<=10||NR==29||NR==31||NR>=66&&NR<=105'` over the file, then `grep -cv '^\s*$'`).
- **Added (projection):** a five-line formatted import block and one changed call expression.
- **Net (projection):** about 33 non-blank (about 40 raw) handwritten production lines.
- **Tests (projection):** about 20 to 30 lines added for two characterization cases.
- **Mechanisms:** two fence grammars in the pipeline become one, plus the separately named any-indent variant, which stays.
- **Maintenance effect:** any future fence rule change (for example the info-string rule, or tilde and backtick edge cases) is made once and reaches all six pre-passes. The two pre-passes that run on the same source in `markdown-preview.tsx` can no longer disagree about fence boundaries.
- **Performance:** expected to be neutral. Both functions are linear scans per line, and the shared module is already in the same bundle. This is not measured. No benchmark is warranted for this size of change.
- **Optional follow-on:** converting `completion-report.ts` to the shared helpers would save roughly 5 more lines. It is not counted above.

**Execution steps**

1. **Reconfirm the baseline.** In the current checkout, check that `markdown-local-file-link-normalize.ts` still has its private fence helpers and that `markdown-prompt-blockquote-boundaries.ts` still exports `parseMarkdownFenceStart`, `isMarkdownFenceClose` and `MarkdownFence` with the semantics described above. Re-plan if any of the following is true:
   - The shared `isMarkdownFenceClose` now strips `\n`, accepts any `trim()` whitespace, or changed its signature.
   - The normalizer gained a consumer outside `apps/app`.
   - The renderer is no longer micromark-based.
2. **Add characterization tests first** in `apps/app/src/components/ui/markdown-local-file-link-normalize.test.ts`, inside `describe("normalizeLocalFileMarkdownLinks")`:
   - (a) **CRLF fenced block.** Use the content from the existing test "does not rewrite code spans or fenced code blocks" (:80-102), joined with `"\r\n"`. Expect the fenced link to stay untouched and the link after the fence to be wrapped as `[real](</Users/me/Agent Workspaces/file.md>)` (with `\r` preserved at line ends).
   - (b) **Closer followed by spaces and a tab.** Use a closing line of three backticks followed by a space and a tab. Expect the fence to close and the following link to be wrapped.
   - (c) **Closer followed by a non-breaking space.** Use a closing line of three backticks followed by U+00A0, then the line `[x](/Users/me/A B/file.md)`. Expect the output to equal the input, because the renderer keeps that block open.

   Tests (a) and (b) must pass before the edit. Test (c) fails before the edit; that failure proves the drift.
3. **Edit `apps/app/src/components/ui/markdown-local-file-link-normalize.ts`:**
   - Add `import { isMarkdownFenceClose, parseMarkdownFenceStart, type MarkdownFence } from "./markdown-prompt-blockquote-boundaries.js";`.
   - Delete `interface MarkdownFence` (:7-10), `type MarkdownFenceCharacter` (:29), `MARKDOWN_FENCE_PATTERN` (:31), `function parseMarkdownFence` (:66-84) and the private `function isMarkdownFenceClose` (:86-105).
   - In `normalizeLocalFileMarkdownLinks`, change :535 to `if (isMarkdownFenceClose(line.endsWith("\n") ? line.slice(0, -1) : line, fence))`.
   - Change :542 to `const openingFence = parseMarkdownFenceStart(line);`. The opener needs no strip, because the pattern is a prefix match.
   - Keep `let fence: MarkdownFence | null = null;` (:528). It now uses the shared type, whose `character` is `string`; nothing else reads `fence.character`.
4. **Checkpoint.** Run the targeted tests listed under Verification. All of the existing tests and tests (a), (b) and (c) must pass.
5. **Optional, separate change: `apps/app/src/components/thread/completion-report.ts:12-33`** "removeCompletionReportFromDisplay".
   - Replace the inline regex toggle with `parseMarkdownFenceStart` outside a fence and `isMarkdownFenceClose` inside one. Keep the rule that every fence-marker line is skipped (`continue`) and that only lines outside a fence can match `report`.
   - Run `apps/app/src/components/thread/timeline/completion-message.test.ts` before and after.
   - Skip this step if it changes any expected output in that test.
6. **Close out.** Confirm the following:
   - `git grep -n "MARKDOWN_FENCE_PATTERN\|parseMarkdownFence\b\|MarkdownFenceCharacter" -- apps/app` returns nothing.
   - `normalizeLocalFileMarkdownLinks` contains no fence regex of its own.
   - The diff touches only the normalizer, its test file and, if step 5 ran, the completion-report pair.

   Recount removed lines against the baseline above.

**Verification and acceptance criteria**

The snapshot had no `node_modules`, so none of these commands was executed for this card. The script names come from the snapshot's `apps/app/package.json` (`test`: `vitest run --config vitest.config.ts`, `lint`, `typecheck`) and root `package.json` (`format:check`: `oxfmt . --check`).

- **Targeted tests** (working directory `apps/app`): `pnpm exec vitest run --config vitest.config.ts src/components/ui/markdown-local-file-link-normalize.test.ts src/components/ui/markdown-preview.test.tsx src/components/ui/markdown-math-fences.test.ts src/components/ui/markdown-message-directive-repair.test.ts`. If step 5 ran, add `src/components/thread/timeline/completion-message.test.ts`. Expected result: all pass, with no existing expectation edited.
- **Typecheck** (working directory `apps/app`): `pnpm run typecheck`.
- **Lint and format** of the changed files (working directory: repository root): `pnpm exec oxlint --deny-warnings --format=agent apps/app/src/components/ui/markdown-local-file-link-normalize.ts apps/app/src/components/ui/markdown-local-file-link-normalize.test.ts` and `pnpm exec oxfmt --check <same files>`. The flags come from the global agent policy; check that they still work with the installed oxlint version.
- **Behavior contract:**
  - Links inside backtick and tilde fences, including CRLF input, stay unrewritten.
  - Links after a closing fence followed by spaces or tabs are rewritten as before.
  - A closer followed by a non-breaking space no longer ends the fence, which is the one intended change.
  - Output length is unchanged for all other inputs, which protects `imageSourceOffset`.
- **UI:** no visual change is expected for ordinary messages. Alex checks UI changes himself. A manual spot check is to render a message with a local-file link containing spaces after a fenced code block, in the desktop app or web app.
- **Structural completion:** `markdown-local-file-link-normalize.ts` has no fence grammar of its own, and six modules import fence helpers from one owner.

**Rollback and stop conditions**

- **Rollback:** the change is one revertable commit confined to `apps/app` source and tests. There is no persisted data, API or SDK surface, so rolling back has no compatibility impact.
- Stop and re-plan if any existing test in `markdown-local-file-link-normalize.test.ts` or `markdown-preview*.test.tsx` changes outcome. That would mean an equivalence assumed above is wrong.
- Stop and re-plan if the renderer is found to accept non-space whitespace after a closing fence. In that case, the shared helper is the one that is wrong, and the fix belongs there, as a separate decision covering all consumers.
- Stop and re-plan if someone needs the normalizer to treat bare `\r` as a line break. That is a separate line-splitting change, not part of this item.
- **Safer smaller alternative:** if test (c) proves controversial, keep the private close check's whitespace rule as a call-site option. This is not recommended, because it keeps two grammars alive.
