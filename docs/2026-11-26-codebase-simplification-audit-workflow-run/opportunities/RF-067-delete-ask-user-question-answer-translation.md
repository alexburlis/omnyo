# RF-067 — Delete the Needs You plugin's dormant answer-to-tool-result translator

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** Confirmed, with slightly corrected line counts (see Expected gain).
- **Potential:** Low to medium. This is a small, self-contained deletion of dead machinery, not a structural change.
- **Confidence:** High. Every removed symbol has been traced to zero runtime callers in the whole snapshot.
- **Readiness:** Ready.
- **Effort:** Under an hour, plus the plugin's own test and typecheck and the fork check.
- **Risk:** Very low. Nothing at runtime calls the code. The only consumers are the plugin's own tests for the deleted functions.
- **Prerequisites:** None.
- **Related or overlapping RF ids:** None overlap. RF-043 (retire the legacy decisions/needs-you attention adoption) touches the same plugin's `server.ts` line `api.sdk.experimental_attention.adopt(...)` but not these files; the two can land in either order.
- **Why it deserves its place:** The plugin keeps a second answer representation (a native-Claude-shaped `ToolResult`) beside the one it actually uses (the native attention command). Anyone who changes the question shape is invited to update and test the dormant translator too. Removing it leaves one answer path and costs almost nothing.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree named in the audit brief had been removed by the time of verification, so every file was read from that commit with `git -C $OMNYO_CHECKOUT show`, `git grep` and `git archive` (read-only).

The subsystem: `plugins/ask-user-question` (package `omnyo-plugin-ask-user-question`, display name "Needs You", stable plugin id `ask-user-question`) registers the `AskUserQuestion` agent tool for providers without a native question tool. It also renders older pending-interaction question cards and the sidebar attention overlay.

Observed facts (Proven by inspection):

1. `plugins/ask-user-question/src/server.ts:5-9` imports only `validateToolInput`, `buildInteractionPayload` and `assertInteractionPayloadFits` from `./translate.js`. The tool's `execute` (`server.ts:24-98`) validates input, checks payload size, calls `api.sdk.experimental_attention.command({ action: "open", ... })` at `server.ts:47` and returns a JSON string at once. It never calls `api.ui.requestInput` and never waits for an answer.
2. `plugins/ask-user-question/src/translate.ts:89-222` holds the dormant translator: `describeAnswers` (89-110), `buildInteractionTitle` (112-118), the private helpers `selectedOptions` (120-131), `buildAnswerText` (133-152) and `buildAnnotation` (154-175), and `buildToolResult` (177-222).
3. `plugins/ask-user-question/src/tool-definition.ts:19-21` "buildTimeoutMessage" exists for the old blocking flow's timeout result.
4. `plugins/ask-user-question/src/contracts.ts:136-153` declares `ToolResultQuestion`, `ToolResultAnnotation` and `ToolResult`, used only by `translate.ts`.
5. Consumer search. Command: `git grep -n -w <symbol> e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- .` for each symbol, scope the whole repository, excluding only the audit docs:
   - `describeAnswers`, `buildTimeoutMessage`, `ToolResultQuestion`: only their definitions.
   - `buildInteractionTitle`, `buildToolResult`: definitions plus `plugins/ask-user-question/src/translate.test.ts:8-9,167-287`.
   - `ToolResultAnnotation`, `ToolResult`: `contracts.ts` and `translate.ts` only.
   - `selectedOptions`, `buildAnswerText`, `buildAnnotation`: inside `translate.ts` only. The one other `selectedOptions` hit, `apps/app/src/components/plugin/management/PluginBrowseControls.tsx:465`, is an unrelated local variable.
   - `InteractionQuestion` and `InteractionAnswer` (types in `contracts.ts:34` and `:52`): used only by the deleted helpers in `translate.ts`.
6. Non-obvious consumers checked:
   - Imports of the plugin package from outside: `git grep -E "omnyo-plugin-ask-user-question/|ask-user-question/src|ask-user-question/(app|src)"` finds only two relative imports of `plugins/ask-user-question/app.tsx` (in `apps/app/src/components/plugin/PluginPendingInteractionComposer.submission.test.tsx:85` and `apps/app/src/components/thread/pending-interactions/AskUserQuestionPlugin.stories.tsx:16`). `apps/app/package.json:126` and `packages/bundled-plugins/package.json:12` depend on the workspace package. The plugin's `package.json` has no `exports` field; its entry points are `omnyo.server: ./src/server.ts` and `omnyo.app: ./app.tsx`. Neither entry reaches the deleted symbols.
   - Plugin discovery and registries: `apps/server/src/services/plugins/builtin-registry.ts:64-65`, `plugins/omnyo-official.json` (category and screenshots only, no content hash), `scripts/forkable-plugins.json` and `turbo.json:1092-1110` (task inputs) address the plugin by id or package name, not by symbol.
   - The private plugin repository `$OMNYO_PLUGIN_CHECKOUT`: `rg -e 'buildToolResult|describeAnswers|buildInteractionTitle|buildTimeoutMessage'` returns no files. Forkable plugins may not import sibling plugins anyway (`docs/forkable-plugins.md`).
   - Core code cannot call plugin-local functions. The server resolves pending interactions in `apps/server/src/services/interactions/pending-interactions.ts:819` "resolvePendingInteraction" without plugin code.
7. History: `git log -- plugins/ask-user-question/src/translate.ts` shows only `060950255 Publish Omnyo source`. At that commit `server.ts` already called `api.sdk.experimental_attention.command` (line 45) and none of the deleted symbols. So the translator has had no runtime caller in any published revision; it was inherited from the bb plugin's blocking `requestInput` flow (see the Credits in `plugins/ask-user-question/PLUGIN_OVERVIEW.md`).

Counterevidence and why it does not apply: `PLUGIN_OVERVIEW.md` says "Older question cards retain their renderer until they drain." That renderer is `plugins/ask-user-question/app.tsx:14-58` "AskUserQuestionInteraction". It parses the stored payload with `interactionPayloadSchema` and submits `{ answers }` directly; it does not use the translator. This card keeps the renderer and its schemas.

Maintenance cost today (Hypothesis about future work, based on the code shape): a change to the question or option shape (for example a new option field) appears to need matching edits in `buildToolResult`, `ToolResult` and four test cases, though none of them run in production.

**Proposed end state and preservation argument**

What disappears:

- `translate.ts`: `describeAnswers`, `buildInteractionTitle`, `selectedOptions`, `buildAnswerText`, `buildAnnotation`, `buildToolResult`, and the now-unused type imports `InteractionAnswer`, `InteractionQuestion`, `InteractionResponse`, `ToolResult`, `ToolResultAnnotation`.
- `contracts.ts`: `ToolResultQuestion`, `ToolResultAnnotation`, `ToolResult` (lines 136-153).
- `tool-definition.ts`: `buildTimeoutMessage` (lines 19-21).
- `translate.test.ts`: the `describe("buildInteractionTitle")` and `describe("buildToolResult")` blocks (lines 167-287) and their two imports.
- Optional, same change: drop the `export` keyword from `InteractionQuestion` and `InteractionAnswer` in `contracts.ts` (or delete the two aliases), since nothing will use them. Keep `interactionAnswerSchema`, because `interactionResponseSchema` is built from it.

What remains, unchanged:

- `validateToolInput`, `MAX_INTERACTION_PAYLOAD_BYTES`, `PreviewTooLargeError`, `questionId`, `optionValue`, `normalizePreview`, `buildInteractionPayload`, `assertInteractionPayloadFits` (`translate.ts:1-87`). `server.ts` uses them to reject duplicate labels and oversized previews before opening a question.
- `interactionPayloadSchema`, `InteractionPayload`, `interactionResponseSchema`, `InteractionResponse` and `ASK_USER_QUESTION_RENDERER_ID` in `contracts.ts`. The legacy renderer (`app.tsx`), `app.test.tsx:5`, and `src/contracts.test.ts` use them.
- `TOOL_DESCRIPTION`, `TOO_FEW_OPTIONS_MESSAGE`, `NOT_UNIQUE_MESSAGE` in `tool-definition.ts`.
- All tool input, tool result strings, presentation, settings, sidebar overlay and pending-interaction rendering.

Preservation argument: the deleted code is unreachable from both plugin entry points and from every other package (evidence items 5-7). No API, persisted format, tool result, UI state or performance property changes. The agent-visible tool result is the JSON built in `server.ts:75-97`, which does not touch the translator.

Remaining uncertainty: an external, unpublished fork of this plugin could import `src/translate.ts` by path. The plugin is private (`"private": true`), has no `exports`, and the forkability rules forbid cross-plugin imports, so this card treats that as out of scope.

Non-goals: retiring the legacy pending-interaction renderer or its schemas; changing the tool's description or result; RF-043's attention adoption.

**Expected gain and cost**

Measured at the snapshot with `wc -l` and `cat -n` (counts include the blank separator line before each removed block):

| File | Before | Removed | After (projected) |
|---|---|---|---|
| `src/translate.ts` (production) | 222 | 135 (lines 88-222) + 5 import lines = 140 | about 82 |
| `src/contracts.ts` (production) | 153 | 19 (lines 135-153); about 2 more if the unused type aliases go | about 132-134 |
| `src/tool-definition.ts` (production) | 21 | 4 (lines 18-21) | 17 |
| **Production total** | | **about 163** | |
| `src/translate.test.ts` (test) | 287 | 122 (lines 166-287) + 2 import lines = 124 | about 163 |

The sweep's estimate of about 150 production and 120 test lines was slightly low; the corrected figures are about 163 and 124. No lines are added. The gain is one answer representation instead of two: a later change to the question shape needs only `server.ts` and the legacy payload schema. Bundle size shrinks by a few hundred bytes (Hypothesis; not measured, and immaterial).

**Execution steps**

1. Reconfirm. In a fresh worktree on current `main`, rerun the consumer search from evidence item 5, for example `git grep -n -w -E "describeAnswers|buildInteractionTitle|buildToolResult|buildTimeoutMessage|ToolResult|ToolResultAnnotation|ToolResultQuestion|InteractionQuestion|InteractionAnswer" -- . ':!docs'`, and `rg -e 'buildToolResult|describeAnswers|buildInteractionTitle|buildTimeoutMessage' $OMNYO_PLUGIN_CHECKOUT`. Confirm `plugins/ask-user-question/src/server.ts` still imports only the three kept functions and still does not call `api.ui.requestInput`. Stop and re-plan if any new caller appears or if `server.ts` has gone back to a blocking `requestInput` flow.
2. No new behavioral evidence is needed. The kept functions already have coverage in `translate.test.ts` ("tool input validation" and the payload-size tests at lines 26-165) and in `src/server-harness.test.ts`.
3. Edit `plugins/ask-user-question/src/translate.ts`: delete lines 88-222 (`describeAnswers` through `buildToolResult`). Reduce the import from `./contracts.js` to `MAX_OPTION_PREVIEW_LENGTH`, `type InteractionPayload` and `type ToolInput`.
4. Edit `plugins/ask-user-question/src/contracts.ts`: delete `ToolResultQuestion`, `ToolResultAnnotation` and `ToolResult` (lines 135-153). Optionally remove the `export` keyword from, or delete, `type InteractionQuestion` (line 34) and `type InteractionAnswer` (line 52) after confirming step 1 found no other users. Do not touch the zod schemas.
5. Edit `plugins/ask-user-question/src/tool-definition.ts`: delete `buildTimeoutMessage` (lines 18-21).
6. Edit `plugins/ask-user-question/src/translate.test.ts`: delete the `describe("buildInteractionTitle", ...)` and `describe("buildToolResult", ...)` blocks (lines 166-287) and remove `buildInteractionTitle` and `buildToolResult` from the import at lines 4-11. Keep `twoOptions` and `parseInput` only if the remaining tests still use them; `twoOptions` is used earlier in the file, so it stays.
7. Format the four touched files with the repository formatter (`pnpm exec oxfmt <files>` from the repository root), then run the checks below.
8. Inspect the full diff: only these four files change, no old symbol remains (`git grep -n -w -E "buildToolResult|describeAnswers|buildInteractionTitle|buildTimeoutMessage|ToolResult"` in `plugins/ask-user-question` returns nothing), and recount with `wc -l`.

**Verification and acceptance criteria**

Commands (scripts confirmed in `plugins/ask-user-question/package.json` and the root `package.json` at the snapshot; not run here because the snapshot has no `node_modules`):

- From `plugins/ask-user-question`: `pnpm run typecheck` (`tsc --noEmit`) passes. This catches any leftover import of a deleted symbol.
- From `plugins/ask-user-question`: `pnpm run test` (`vitest run --config vitest.config.ts`) passes, including `src/translate.test.ts`, `src/contracts.test.ts`, `src/server-harness.test.ts` and `app.test.tsx`.
- From `plugins/ask-user-question`: `pnpm run lint` passes.
- From the repository root: `pnpm check:plugin-forks plugins/ask-user-question` passes (usage confirmed at `scripts/check-plugin-forks.mjs:32`). This check may pack and install the plugin in isolation; if it needs network access the sandbox does not allow, run it outside the sandbox or report it as not run.
- From the repository root: `pnpm exec oxfmt --check plugins/ask-user-question` reports no changes needed.
- Optional, because the app imports `app.tsx` directly: from `apps/app`, run the focused test `PluginPendingInteractionComposer.submission.test.tsx` through the app's existing vitest script (check `apps/app/package.json` for the exact script name before running).

Acceptance: the four files are the only changes; the tool's registered description, parameters, presentation and both JSON result shapes in `server.ts` are byte-identical; the legacy renderer and its schemas are untouched; no deleted symbol remains anywhere in the repository. No UI or performance comparison is needed because no reachable code changes.

**Rollback and stop conditions**

Rollback: the change is one commit touching four files in one plugin, with no persisted data, migration, API or version implications. Reverting that commit restores the old state exactly.

Stop conditions:

- Step 1 finds a caller of any deleted symbol in the repository, in `$OMNYO_PLUGIN_CHECKOUT`, or in a published plugin SDK surface.
- `server.ts` (or a planned change) reintroduces a blocking `api.ui.requestInput` flow that needs a native-Claude-shaped answer. In that case keep `buildToolResult` and its tests, and delete only `describeAnswers` and `buildTimeoutMessage`, which had no callers even in tests.
- Typecheck or tests fail in a kept function. That means the deletion range was wrong; fix the range rather than editing kept behavior.
