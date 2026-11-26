# RF-079 — Delete seven orphaned helpers that only their own tests still call

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. Every deletion the sweep proposed holds up. Verification
  changed the scope in three ways. Two more private symbols become dead and go
  with their callers: `FRAME_TYPE_NAMES` in tunnel-contract and
  `getNativeThreadImportColumns` in db. One import (`mkdir`) must also be
  dropped. The proposed test-file rename is dropped because the target name
  `question-form.test.tsx` already exists.
- **Potential:** low to medium. About 210 handwritten production lines and about
  175 test lines go. No mechanism changes behaviour. The main gain is that four
  packages stop carrying public exports that look supported but have no caller.
  These are a second host-path parser, a plaintext identifier-file writer, two
  in-place wire-frame rewriters and three database readers.
- **Confidence:** high. There are no production callers at the snapshot, and
  for four of the items the retired private history shows where the last caller
  was removed.
- **Readiness:** ready.
- **Effort:** about 1 hour, plus the package checks.
- **Risk:** very low. Every affected package is `private: true` and workspace-only.
  No published SDK or plugin-SDK surface changes. No persisted format changes.
- **Prerequisites:** none.
- **Related or overlapping work:** X2-RF-008 also proposed deleting the relay's
  typed token and its unused key purposes, and the desktop publication-retention
  functions. Those parts are deliberately excluded here: they run as RF-077
  (relay HMAC token and key derivation) and RF-057 (publication-retention
  writer). RF-104 (Cloudflare-era leftovers in connect-db) is related by origin.
  The tunnel-contract helpers lost their last caller when the Cloudflare
  connect worker was removed. RF-065 touches `plugins/storage-retention` but not
  `src/host-path-key.ts`.
- **Why it ranks here:** this is cheap, safe dead-code removal across several
  packages. No single item is large, so it belongs below the opportunities that
  remove whole mechanisms.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on
2026-11-26). The snapshot worktree named in the audit brief no longer existed
during verification, so every file was read with `git show e9e1b74c3:<path>`
and searched with `git grep` at that commit. No test suite was run, because
there are no `node_modules` to run them with.

Decisive search (Reproduced). Run from `$OMNYO_CHECKOUT`:

```
git grep -n -I -E 'useSetupComplete|native-question-form|native-question-draft|question-form-draft|host-path-key|readOrCreateIdentifierFile|peekFrame|setFrameStreamId|getLatestTokenUsageRow|getLatestThreadSystemErrorEventRow|GetLatestThreadSystemErrorEventRowArgs|getNativeThreadImportBySource|getNativeThreadImportColumns|FRAME_TYPE_NAMES' e9e1b74c3 -- .
```

This search covers every tracked text file: source, scripts, manifests,
`turbo.json`, Vite configs, generated registry JSON and docs. The only hits
outside the definitions themselves are the tests listed below and the
`question-form-draft` entries described in item 2. A second search,
`rg -l -g '!**/node_modules/**'`, over the separate plugin repository
`$OMNYO_PLUGIN_CHECKOUT` for the same symbols found no matches. No
`import.meta.glob` covers `components/onboarding`,
`plugins/storage-retention/src`, secret-storage, tunnel-contract or db.

The items, with each observed fact (Proven by inspection unless labelled):

1. **`apps/app/src/components/onboarding/useSetupComplete.ts:5` "useSetupComplete"**
   (18 lines). Its only importer is `useSetupComplete.test.tsx:4` (70 lines).
   Onboarding gating lives in `apps/app/src/App.tsx:96` `OnboardingGate`. The hook's
   dependencies, `listSidebarNavigationThreads` (`apps/app/src/hooks/cache-owners/query-cache.ts:339`)
   and `useSidebarNavigation`, have many other callers and stay.
2. **`apps/app/src/components/ui/native-question-form.tsx`** (6 lines) re-exports
   `QuestionForm` and `QuestionFormProps` from `@omnyo/shared-ui/question-form`,
   and `Question` from `@omnyo/shared-ui/question-form-state`. Its only importer is
   the type import at `apps/app/src/components/ui/native-question-form.test.tsx:10`.
   That test renders `QuestionForm` from `./question-form`, the app's real
   wrapper (`apps/app/src/components/ui/question-form.tsx`, 90 lines).
   **`apps/app/src/components/ui/native-question-draft.ts`** (1 line) re-exports
   `useQuestionFormDraft` through the deep relative path
   `../../../../../packages/shared-ui/src/components/ui/question-form-draft`, and
   nothing imports it. The `question-form-draft` hits in
   `packages/plugin-registry/r/*.json` do not read this file:
   `packages/plugin-registry/scripts/build-registry.mjs:12` reads only
   `packages/shared-ui/src`. `packages/shared-ui/src/components/ui/question-form.tsx:37`
   imports the draft hook directly. In the retired private history, the shim's
   last relevant change was `9a8c0865b7` (2026-11-22, "Keep the independent web
   candidate app-only").
3. **`plugins/storage-retention/src/host-path-key.ts:32` "hostPathComparisonKey"**
   (52 lines). This is a plugin-local copy of `@omnyo/domain`
   `getHostPathComparisonKey`. Its only importer is `src/host-path-key.test.ts:3`
   (28 lines), a parity test that pins the copy to the domain parser. The
   plugin manifest in `plugins/storage-retention/package.json` names only
   `./src/server.ts`, `./app.tsx` and `./src/host.ts`, and the package has no
   exports map. The sweep's provenance, taken from the retired private repository
   and not re-run here: private `cc19c1fa8d` added the copy for
   `src/git-worktrees.ts`, and `e91d6841d1` deleted that file. The
   storage-retention plugin keeps its `@omnyo/domain` dependency, because
   `storage.ts` uses it.
4. **`packages/secret-storage/src/secret-file.ts:127-150` "readOrCreateIdentifierFile"**,
   exported at `packages/secret-storage/src/index.ts:15`. Its only caller is the
   `describe("readOrCreateIdentifierFile")` block at
   `packages/secret-storage/test/secret-file.test.ts:203-219` and the import on
   line 8 of that file. The plaintext `telemetry-id` file it once managed is now
   deleted at `apps/server/src/services/system/telemetry.ts:215` with
   `deleteSecretFile`. In the retired private history, the last change touching
   it in `apps/server` was `dcace223e0` (2026-11-24, "Separate weekly
   installation counts from opt-in product analytics"). Its only consumer
   package is `apps/server`. **Extra finding:** `mkdir` in the import on
   `secret-file.ts:2` is used only at line 130, inside this function, so the
   import must be trimmed. `readIfPresent`, `createFileExclusive`, `randomBytes`
   and `GeneratedFileArgs` stay, because `readOrCreateSecretFile` uses them.
5. **`packages/tunnel-contract/src/index.ts:143` "peekFrame" and `:160` "setFrameStreamId"**.
   Their only callers are in `packages/tunnel-contract/test/frames.test.ts:11-12`
   and the `describe("frame header access")` block at lines 521-575.
   **Extra finding:** `FRAME_TYPE_NAMES` (`index.ts:120-129`) is read only at
   line 148, inside `peekFrame`, so it is dead as well. `frameBytes` (line 133)
   and `FRAME_HEADER_BYTES` (line 131) stay, because `decodeFrame` uses them at
   lines 463 and 466. The rejection cases in the deleted block ("too short",
   "unknown frame type") are already covered for `decodeFrame` at
   `frames.test.ts:258-260`. The stream-id range check exists only in
   `setFrameStreamId`, so it leaves with that function. `encodeFrame` keeps its
   own checks, which `frames.test.ts:243-246` covers. In the retired private
   history, `1018d56215` (2026-10-01, the connect gate in the Cloudflare Worker)
   used these helpers, and `e233452617` (2026-11-11) removed that worker. The
   relay has no manual header parsing. The only `setUint32(1` outside the
   package is in `apps/relay/src/tunnel/memory-accounting.test.ts:189`, a test
   that builds its own frame.
6. **`packages/db/src/data/events.ts:4930-4950` "getLatestTokenUsageRow"** and
   **`:5009-5027` "getLatestThreadSystemErrorEventRow"**, with its argument
   interface `GetLatestThreadSystemErrorEventRowArgs` at `:1929-1931`. Both are
   listed in the barrel `packages/db/src/data/index.ts:391` and `:396`. Neither
   has a caller anywhere, tests included. The live sibling
   `getLatestRequestTokenUsageRow` (about line 4959) keeps
   `isNotNestedTurnUsageEvent` and `ListContextWindowUsageRowsArgs` in use.
7. **`packages/db/src/data/native-thread-imports.ts:99-111` "getNativeThreadImportBySource"**.
   It has no caller. **Correction to the sweep:** this function *is* exported
   from the barrel, through `export * from "./native-thread-imports.js"` at
   `packages/db/src/data/index.ts:652`. That export comes from `export *`, so the
   barrel needs no edit. **Extra finding:** the private helper
   `getNativeThreadImportColumns` (lines 113-122) is used only at line 105,
   inside the deleted function, so it goes too. `sourceKeyWhere`,
   `NativeThreadImportSourceKey`, `isNull` and `NativeThreadImportRow` remain in
   use.

Counterevidence that was considered:

- `host-path-key.ts` exists because the plugin's host bundle should not import
  `@omnyo/domain`. A future host-side caller would need it again. History keeps
  it.
- `peekFrame` and `setFrameStreamId` suit relay stream re-addressing. No current
  relay or connect code does that.
- None of the seven is part of the published SDK or plugin SDK. External
  plugins and older clients cannot import them, because
  `@omnyo/secret-storage`, `@omnyo/tunnel-contract` and `@omnyo/db` are
  `private: true`, and the two app files and the plugin file are not package
  exports.

Today's maintenance cost: a change to domain host-path semantics breaks a
parity test for code nothing runs. Frame-header layout changes must keep two
unused rewriters and a name map correct. Secret-file refactors must keep a
plaintext writer working. Token-usage predicate changes have two "latest token
usage" readers to reason about. A move of `question-form-draft` inside
shared-ui would break a deep relative import that nothing uses.

**Proposed end state and preservation argument**

What disappears: the seven helpers above, two dead private symbols, two
barrel names and their dedicated tests. What remains:

- **Question forms:** `@omnyo/shared-ui/question-form` and
  `@omnyo/shared-ui/question-form-state` are the single import path. The app
  wrapper stays at `apps/app/src/components/ui/question-form.tsx`.
- **Host paths:** `@omnyo/domain` `getHostPathComparisonKey` is the single
  host-path key implementation.
- **Secret storage:** keeps `readOrCreateSecretFile`, `readSecretFile`,
  `writeSecretFile`, `deleteSecretFile` and `sealLegacySecretFile`.
- **Frame decoding:** `@omnyo/tunnel-contract` decodes frames only through
  `decodeFrame`.
- **Token usage:** `@omnyo/db` keeps `getLatestRequestTokenUsageRow` as its
  only latest-token-usage reader.

The preservation argument is reachability. No production module imports any
deleted symbol, so no runtime path, UI state, API, wire format or persisted
format changes. The kept test `native-question-form.test.tsx` changes one type
import and keeps every assertion.

Non-goals:

- The relay typed token and key purposes (RF-077).
- The publication-retention functions (RF-057).
- Renaming `native-question-form.test.tsx`. The obvious new name collides with
  the existing `question-form.test.tsx` (292 lines), and merging the two tests
  is out of scope.
- Any change to `listSidebarNavigationThreads`, `frameBytes` or `sourceKeyWhere`.

Remaining uncertainty: whether unpublished private-repository code imports
these symbols from this checkout. Hypothesis, judged unlikely: the plugin
repository search found nothing, and the private repository is retired.

**Expected gain and cost**

Counts come from `git show e9e1b74c3:<file> | wc -l` and the line ranges above.
Removed separator blank lines are included.

| Item | Production lines | Test lines |
|---|---|---|
| `useSetupComplete.ts` and its test | 18 | 70 |
| `native-question-form.tsx` and `native-question-draft.ts` | 7 | 0 (1 line edited) |
| `host-path-key.ts` and its test | 52 | 28 |
| `readOrCreateIdentifierFile`, its export and `mkdir` | about 26 | about 19 |
| `FRAME_TYPE_NAMES`, `peekFrame` and `setFrameStreamId` | about 42 | about 58 |
| Three db readers, their interface, barrel entries and `getNativeThreadImportColumns` | about 74 | 0 |
| **Total** | **about 219** | **about 175** |

All of this is handwritten code. None of it is generated. Nothing is added.
Four files are deleted outright: `useSetupComplete.ts`, `native-question-form.tsx`,
`native-question-draft.ts` and `host-path-key.ts`. Two test files are deleted
outright: `useSetupComplete.test.tsx` and `host-path-key.test.ts`.

Removed mechanisms:

- one duplicate host-path parser with its parity pin
- one unused plaintext identifier-file API with its race-handling path
- two unused wire-frame header operations and their type-name map
- two unused event readers and one unused import reader
- two dead re-export shims, one of which bypasses package exports

The expected effect on bundle size and runtime is neutral, because tree-shaking
probably already drops these. That is a projection and was not measured.

**Execution steps**

1. Reconfirm the baseline on the branch you are working on. From the
   repository root, rerun the `git grep` command in "Context and evidence"
   against `HEAD`, adding `getNativeThreadImportColumns` and `FRAME_TYPE_NAMES`
   (both are already in that command). Stop and re-plan if any new non-test
   importer appears, or if any item has been edited since the snapshot.
2. **App shims and hook (`apps/app`).**
   - Delete `apps/app/src/components/onboarding/useSetupComplete.ts` and
     `useSetupComplete.test.tsx`.
   - Delete `apps/app/src/components/ui/native-question-form.tsx` and
     `apps/app/src/components/ui/native-question-draft.ts`.
   - In `apps/app/src/components/ui/native-question-form.test.tsx:10`, replace
     `import type { Question } from "./native-question-form";` with
     `import type { Question } from "@omnyo/shared-ui/question-form-state";`.
     Do not rename the file.
3. **Storage & Retention.** Delete `plugins/storage-retention/src/host-path-key.ts`
   and `plugins/storage-retention/src/host-path-key.test.ts`. Keep the
   `@omnyo/domain` dependency.
4. **Secret storage.**
   - In `packages/secret-storage/src/secret-file.ts`, delete
     `readOrCreateIdentifierFile` (lines 127-150) and change the line 2 import
     to `import { readFile, rename, rm } from "node:fs/promises";`. Keep
     `GeneratedFileArgs`, `readIfPresent` and `initializationFailure`.
   - In `src/index.ts`, remove `readOrCreateIdentifierFile,` from the export
     list.
   - In `test/secret-file.test.ts`, remove the import on line 8 and the
     `describe("readOrCreateIdentifierFile")` block at lines 203-219.
   - Leave the test file's `node:fs/promises` import as it is: `readFile`,
     `readdir`, `mkdir` and `writeFile` are all still used in other cases (for
     example at lines 49, 69, 84 and 85).
5. **Tunnel contract.**
   - In `packages/tunnel-contract/src/index.ts`, delete `FRAME_TYPE_NAMES`
     (lines 120-129), `peekFrame` (lines 143-158) and `setFrameStreamId` (lines
     160-172). Keep `FRAME_HEADER_BYTES` and `frameBytes`.
   - In `test/frames.test.ts`, remove `peekFrame` and `setFrameStreamId` from
     the import (lines 11-12) and delete `describe("frame header access")`
     (lines 521-575).
6. **Database.**
   - In `packages/db/src/data/events.ts`, delete
     `GetLatestThreadSystemErrorEventRowArgs` (lines 1929-1931),
     `getLatestTokenUsageRow` (lines 4930-4950) and
     `getLatestThreadSystemErrorEventRow` (lines 5009-5027).
   - In `packages/db/src/data/index.ts`, remove the
     `getLatestThreadSystemErrorEventRow,` (line 391) and
     `getLatestTokenUsageRow,` (line 396) entries.
   - In `packages/db/src/data/native-thread-imports.ts`, delete
     `getNativeThreadImportBySource` (lines 99-111) and
     `getNativeThreadImportColumns` (lines 113-122). Leave the drizzle import
     unchanged, because `isNull`, `and` and `eq` are still used.
7. **Checkpoint.** Rerun the step 1 search. The expected result is no hits for
   any deleted symbol, apart from `question-form-draft` in
   `packages/shared-ui` and `packages/plugin-registry/r`, which are unrelated
   and stay.
8. Format the changed files with the repository formatter
   (`pnpm exec oxfmt <files>` from the repository root). Run the checks in the
   next section, then review the full diff for unrelated changes. Recount the
   removed lines with `git diff --stat` against the baseline.

**Verification and acceptance criteria**

These commands come from the `package.json` scripts at the snapshot. They were
not run during the audit, because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/app typecheck` and
  `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/components/ui/native-question-form.test.tsx`.
  The script is `test`; passing a file filter to vitest is the usual pattern
  but is not confirmed. Expect a clean typecheck and an unchanged pass count for
  that test.
- `pnpm --filter @omnyo/app lint` (the script runs `oxlint src ...`).
- `pnpm --filter omnyo-plugin-omnyo--storage-retention typecheck`, then
  `lint` and `test` with the same filter.
- `pnpm --filter @omnyo/secret-storage typecheck` and
  `pnpm --filter @omnyo/secret-storage test`. Expect every remaining
  `secret-file.test.ts` case to pass, and no unused-import error.
- `pnpm --filter @omnyo/tunnel-contract typecheck` and
  `pnpm --filter @omnyo/tunnel-contract test`. The `decodeFrame` rejection
  cases at `frames.test.ts:258-260` must still pass.
- `pnpm --filter @omnyo/db typecheck` and `pnpm --filter @omnyo/db test`.
- Consumers of the changed packages:
  - `pnpm --filter @omnyo/server typecheck` (secret-storage and db)
  - `pnpm --filter @omnyo/relay typecheck` (tunnel-contract; the package name
    is assumed from `apps/relay`, so confirm it in `apps/relay/package.json`)
  - `pnpm --filter @omnyo/host-daemon typecheck` (tunnel-contract)
- Root `pnpm format:check` and `pnpm exec oxlint --deny-warnings --format=agent`
  on the changed files.
- Structural completion: the step 7 search returns no deleted symbols, the
  barrel no longer lists the two readers, and no new export or shim replaces
  them.
- No UI, visual, wire-format or performance comparison is needed, because no
  runtime path changes.

**Rollback and stop conditions**

Each package's change is independent and touches only source files. Any one of
them can be reverted with `git revert` on its own commit, or restored from
history, without data or compatibility effects. No persisted data, migration,
wire format or published API is involved.

Stop and re-plan for an item in any of these cases:

- A new non-test importer of that item appears on the working branch.
- Alex says private release tooling or another checkout imports any of these
  package exports.
- A planned relay feature needs in-place stream re-addressing. In that case,
  keep `peekFrame` and `setFrameStreamId` until that feature lands.
- Storage & Retention host code is about to gain a host-path comparison. In
  that case, keep `host-path-key.ts` alongside its new caller.

If any one item is blocked, ship the others. The items do not depend on each
other.
