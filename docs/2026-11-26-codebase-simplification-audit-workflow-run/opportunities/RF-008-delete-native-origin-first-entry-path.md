# RF-008 — Delete the native origin first-entry and session-restore path: the desktop first-entry owner, the final-runtime pin, the app restore engine and the boot wait that serves it

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The scope is corrected in three places. First, `originTargetStorageEntriesV1` is not freed, because the live target staging still calls it. Second, more code is freed than the sweep counted: the composer-recovery planner in `prompt-draft-recovery-v1.ts`, `assertOriginAdoptionAcceptedV1`, `originLocalWindowSchemaV1`, the `__omnyoBeginBrowserStorageAdmissionV1` global and a whole 259-line test file. Third, the restore engine is imported statically by `main.tsx`, so it sits in the boot chunk, not in a lazy chunk.
- **Potential:** medium. About 2,050 handwritten production lines and about 850 test lines disappear, with no feature loss. Two protocol owners for a peer that no longer exists go away, along with seven contract schemas and one boot-time branch.
- **Confidence:** high. Every claim below was checked against the snapshot source and the history of the retired private repository.
- **Readiness:** conditional. The desktop half (checkpoint A) is ready now. The app half (checkpoint B) has a short owner gate: The owner confirms that no iOS build from before 2026-11-11 that still carries the identity handoff is in use (see the investigation gate).
- **Effort:** small to medium. Checkpoint A takes under an hour. Checkpoint B takes two to four hours, including typecheck and the focused app tests.
- **Risk:** low. The only runtime edit is on the app boot path (`apps/app/index.html` and `apps/app/src/main.tsx`). That edit deletes a branch that no shipped client can enter. `index.html` and `main.tsx` must change in the same commit (see Rollback and stop conditions).
- **Prerequisites:** none for checkpoint A. Checkpoint B needs the owner gate.
- **Related and overlapping:**
  - RF-005 (retire the BB Private to Omnyo Private desktop profile, keychain and browser-origin continuity) is the wider retirement. This card is the subset whose peer is already gone, and it can land before RF-005. If RF-005 lands first and deletes `apps/app/src/origin-adoption-v1.ts` and `origin-window-state-v1.ts`, recount this card against what remains.
  - RF-006 (retire the stopped-state BB-to-Omnyo identity adoption) gets slightly smaller: `desktop-final-runtime-v1.ts` is one of the consumers of `identityAdoptionBindingSchema` from `@omnyo/domain`, and it disappears here.
- **Why it deserves its place:** this is verified dead machinery on the boot path and in a contract package, with a mechanical deletion plan and almost no behavioral exposure. Today any change to the origin window-state IndexedDB owner, the composer submission journal format, the internal origin contract or the legacy browser storage migration must keep about 1,450 lines of unreachable orchestration compiling and its tests passing.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). It was read with `git show <commit>:<path>` and `git grep <commit>` in `$OMNYO_CHECKOUT`, because the audit worktree had already been removed. No node_modules exist, so no test, typecheck or build ran.

*What the subsystem is.* When Omnyo replaced BB Private, a one-time "origin adoption" moved saved browser state (drafts, pending chats, preferences) from the old web origin to the new one. Three participants took part:

1. The **live desktop adoption page**: `apps/app/origin-adoption-v1.html` → `apps/app/src/origin-adoption-v1.ts`, with the desktop side in `apps/desktop/src/desktop-profile-adoption-v1.ts` and `apps/desktop/src/main.ts` near line 4207. This page is bundled and stays. Retiring it is RF-005's subject.
2. An **iOS identity handoff**. A native shell injected `window.__omnyoOriginSessionRestoreV1` (a restore descriptor) and `window.__omnyoNativeFirstEntryV1` (a native callback) before the web app loaded. The web app then ran a "first entry" protocol. It replanned composer drafts across all sealed windows, recorded a first-entry receipt in IndexedDB, and asked the native owner to confirm each phase (`inspect`, `preflight`, `ready`, `prepared`, `retired`, `will-enter`, `entered`).
3. A **desktop twin of that native owner** (`createDesktopOriginFirstEntryOwnerV1`) and a **final-runtime qualifier** (`assertDesktopFinalRuntimeV1`), meant to answer the same protocol from Electron.

*Observed facts (Proven by inspection unless labelled).*

- `apps/app/src/main.tsx:1` imports `restoreNativeOriginSessionV1` statically. At `main.tsx:28` "startApp" reads `__omnyoOriginSessionRestoreV1`. Only when that global is defined does it call `restoreNativeOriginSessionV1` (`:31`, passing `__omnyoNativeFirstEntryV1` at `:35`) and then `__omnyoBeginBrowserStorageAdmissionV1` (`:38-45`). It confirms entry after `app-entry` loads (`:67-71`). The file has 77 lines.
- `apps/app/index.html:78` defines `beginAdmission`. `:180` publishes it as `window.__omnyoBeginBrowserStorageAdmissionV1`. `:181-182` calls it only when `window.__omnyoOriginSessionRestoreV1 === undefined`, which keeps the pre-paint storage writers closed until the native restore finishes.
- **No producer exists at the snapshot.** The search `git grep -n -i -E 'OriginSessionRestore|NativeFirstEntry|BeginBrowserStorageAdmission' e9e1b74c3` over all tracked files returns only `apps/app/index.html:180-181`, `apps/app/src/main.tsx:1,28,35,40`, `apps/app/src/index-html-origin-admission.test.ts:120,129`, `apps/app/src/index-html-pre-paint.test.ts:81-82` and the restore engine and its test. Every `__omnyo*` global set under `apps/mobile`, `apps/desktop` and `packages` was listed (`git grep -o '__omnyo[A-Za-z0-9]*'`), and none of them is either global. Desktop exposes only `omnyoDesktop`, `omnyoDesktopNotifications` (`apps/desktop/src/preload.ts:786-788`) and `omnyoLogViewer` (`apps/desktop/src/log-viewer-preload.ts:43`). The mobile WebView injects only `buildBridgeInjectionScript` (`apps/mobile/src/screens/webview/ProfileWebViewScreen.tsx:287-289,440`).
- **The only producer was deleted.** In the retired private repository `$ARCHIVED_OMNYO_CHECKOUT`, `git log -S'__omnyoOriginSessionRestoreV1'` and `git log -S'__omnyoNativeFirstEntryV1'` each return a single commit: `68cca64070` (2026-11-11, "Remove the iPhone identity handoff now that Omnyo replaced BB Private"). At `68cca64070^`, the injector was `apps/mobile/src/lib/native/identity-entry-webview-v1.ts:70`, together with the Swift `IdentityNativeEntryV1.swift` and related files. Private HEAD (`52b7fdf012`) has no producer either.
- **The desktop modules were never wired.** `apps/desktop/src/desktop-origin-first-entry-v1.ts:57` "createDesktopOriginFirstEntryOwnerV1" (522 lines) and `apps/desktop/src/desktop-final-runtime-v1.ts:28` "assertDesktopFinalRuntimeV1" (59 lines, with `desktopFinalRuntimeDescriptorSchemaV1` pinned at `:11-13` to `appVersion: "0.46.247+private.1"`, `protocolVersion: 254` and `serverHostId: "host_demo"`) are imported only by `apps/desktop/test/desktop-origin-first-entry-v1.test.ts` (229 lines) and `apps/desktop/test/desktop-final-runtime-v1.test.ts` (130 lines). Neither file is an esbuild entry point. The entries in `apps/desktop/scripts/build.mjs:116-211` are `desktop-profile-adoption-v1.ts`, `desktop-profile-continuity-entry-v2.ts`, `startup.ts`, `main.ts`, five preloads and `omnyo-app-bridge.mts`. The string `0.46.247+private.1` also appears in `apps/desktop/src/desktop-profile-continuity-v2.ts:508`, which is RF-005's code and unrelated to this card.
- **The restore engine's other exports have no outside consumers.** `apps/app/src/lib/origin-native-session-restore-v1.ts` (864 lines) exports `restoreNativeOriginSessionV1` (`:37`), `prepareOriginFirstEntryRecoveryV1` (`:475`), `applyOriginFirstEntryRecoveryV1` (`:613`) and `restoreOriginFirstEntryWindowV1` (`:655`), and re-exports three contract schemas (`:7-11`). `git grep -w` on each of these finds only the file itself, plus `main.tsx` and its own test (193 lines) for the first one.
- **Code that only the restore engine and the desktop owner use** (consumer counts from `git grep -n -w <symbol>`):
  - In `apps/app/src/lib/origin-window-state-v1.ts` (588 lines):
    - The import and re-export of `originLocalWindowSchemaV1` and `OriginLocalWindowV1` at `:1-6`.
    - `restoreOriginTargetWindowStateV1` at `:239-250`. It has no caller at all, so it was dead even before this change.
    - The first-entry schemas `originFirstEntryMutationSchemaV1`, `originFirstEntryPayloadSchemaV1`, `originFirstEntryRecordSchemaV1` and `OriginFirstEntryRecordV1` at `:367-436`.
    - `readOwnerRecord` and `writeOwnerRecord` at `:438-506`, whose only callers are freed.
    - `readExactOriginTargetWindowStateV1` at `:508-532`.
    - `firstEntryStorageSelectionSchema`, `firstEntryStorageKey`, `readOriginFirstEntryRecordV1` and `writeOriginFirstEntryRecordV1` at `:534-588`.
    - Once `restoreOriginTargetWindowStateV1` is gone, `restoreWindowState` (`:252`) is only ever called with `side: "source"` and `expectedSha256: null`. Its target-side branches at `:261`, `:300-307` and `:310-313` become dead.
  - In `apps/app/src/lib/prompt-draft-recovery-v1.ts` (418 lines):
    - `class RecoveryStorage` at `:206-237`.
    - `originRecoveryMutationsV1` at `:239-254`.
    - `planOriginComposerRecoveryV1` at `:256-418`.
    - After those deletions, the imports `pendingChatDescriptorsSchema` and `migrateLegacyBrowserStorageV1` (`:10-14`) are used only by the deleted lines.
    - The whole test file `apps/app/src/lib/prompt-draft-recovery-v1.test.ts` (259 lines, one `describe("sealed local-window composer recovery")` with four cases) tests only `planOriginComposerRecoveryV1`.
  - In `apps/app/src/lib/origin-storage-transfer-v1.ts`: `assertOriginAdoptionAcceptedV1` at `:405-421`.
  - In `packages/desktop-contract/src/internal/origin-adoption-v1.ts` (202 lines):
    - `originLocalWindowSchemaV1` and `OriginLocalWindowV1` at `:78-88`.
    - `originNativeSessionRestoreSchemaV1` at `:90`.
    - `nativeFirstEntryBindingSchema` at `:102`.
    - `originNativeSessionIdentitySchemaV1` at `:116`.
    - `originNativeWindowEntrySchemaV1` at `:123`.
    - `originNativeFirstEntryRequestSchemaV1` at `:128`.
    - `originNativeFirstEntryReplySchemaV1` at `:150-202`.
    - The package is `"private": true`, so external plugins and older clients cannot import it.
- **Code that stays live and must be kept:**
  - `originTargetStorageEntriesV1` (`origin-window-state-v1.ts:105`) is called by `stageWindowState` at `:162-163`. That is live target staging used by `apps/app/src/origin-adoption-v1.ts:668` through `stageOriginTargetWindowStateV1`. The sweep listed it as freed, which is wrong. It may lose its `export` keyword only.
  - `digestOriginWindowStateV1`, `stageOriginWindowStateV1`, `stageOriginTargetWindowStateV1`, `restoreOriginWindowStateV1` and `initializeOriginWindowStateV1` are imported by `apps/app/src/origin-adoption-v1.ts:21-27`.
  - `ORIGIN_WINDOW_STATE_DATABASE_V1` and `ORIGIN_WINDOW_STATE_DATABASE_VERSION_V1` are used by `apps/app/src/lib/origin-database-inventory-v1.ts:2-3`.
  - `preserveComposerSubmissionTabV1` and `recoverComposerSubmissionEntriesV1` are used by `apps/app/src/lib/composer-submission-journal.ts`.
  - `mergeRecoveredPromptDraftV1` is used by `apps/app/src/hooks/usePromptDraftStorage.ts`.
  - `ORIGIN_STORAGE_ADMISSION_LOCK_V1` is used by `withOriginStorageLeaseV1`.
  - `originStorageTicketSchemaV1`, `originNativeMappingSchemaV1`, `originNativeCompletionSchemaV1` and `originNativeInventorySchemaV1` are used by `origin-native-completion-v1.ts` and `origin-storage-transfer-v1.ts`.
  - The desktop native-window receipt key `omnyo.origin-transfer.v1:native-window:<id>`, read at `apps/desktop/src/main.ts:4207-4211`, is written by the live page at `apps/app/src/origin-adoption-v1.ts:655`, not by the restore engine.
- **Persisted data.** The restore engine wrote `first-entry:<adoptionId>:<sha>` rows into the IndexedDB database `omnyo-origin-adoption-v1`, store `staged-windows`. Nothing enumerates that store: `git grep -E 'getAll|openCursor'` finds no hit in `origin-window-state-v1.ts` or `origin-database-inventory-v1.ts`, and the inventory reads only database names and versions (`origin-database-inventory-v1.ts:96,108`). Any leftover row becomes inert. The database name and version stay unchanged.
- **Bundle placement.** Because `main.tsx` imports the engine statically, the engine and its first-entry helpers ship in the boot chunk that `apps/app/scripts/check-bundle-budget.mjs` measures against `apps/app/bundle-budget.json:128` (`maxBootBytes: 1640415`). The budget is a ceiling, so shrinking under it needs no re-pin.
- **Docs.** `git grep -i -E 'first-entry|session restore|final-runtime'` over `*.md` and `.omnyo/**` finds nothing, so no documentation needs updating.

*Counterevidence considered.* (a) An old iOS build from before 2026-11-11 would still inject the restore global when it loads the current web app from the self-hosted server. This is the investigation gate below. (b) The desktop owner writes `desktop-origin-first-entry-v1.json` and a lock file in a job directory, which suggests it was planned for later wiring. There is no caller, no bundle entry and no history of one, so this is Hypothesis-level intent with no supported behavior behind it.

*Maintenance cost today.* Seven contract schemas, about 600 lines of record and receipt plumbing, and three test files with intricate fixtures must keep compiling and passing whenever someone edits the origin window-state store, the composer submission journal, the legacy browser storage migration (`migrateLegacyBrowserStorageV1`) or `@omnyo/domain`'s `identityAdoptionBindingSchema` and `@omnyo/server-contract`'s `maintenanceStatusSchema`. The boot path also carries an alternate admission ordering that no client exercises.

**Proposed end state and preservation argument**

*What disappears:*

- Both desktop modules and their tests.
- The app restore engine and its test.
- The first-entry and target-restore helpers in `origin-window-state-v1.ts`.
- The composer-recovery planner in `prompt-draft-recovery-v1.ts` and its test file.
- `assertOriginAdoptionAcceptedV1`.
- The seven native first-entry and session-restore schemas in the desktop contract.
- The `__omnyoBeginBrowserStorageAdmissionV1` global and the deferred-admission branch in `index.html`.
- The native branch and the post-start confirmation in `main.tsx`.

*What remains:*

- `index.html` always starts browser storage admission immediately.
- `main.tsx` awaits `window.__omnyoBrowserStorageAdmission`, runs `assertBrowserStorageMigrationV1()` and `importLegacyBrowserPreferences()`, then imports `./app-entry`, with the two existing error screens.
- The live desktop origin adoption page, window-state staging and source restore, the storage transfer, the database inventory and the legacy browser storage migration are untouched.

*Preservation argument.* For every client that exists today (web, desktop and current mobile), `window.__omnyoOriginSessionRestoreV1` is `undefined`. On that path `index.html:181-182` already calls `beginAdmission()` synchronously, and `main.tsx` skips `:30-46` and `:67-71` because `confirmNativeEntry` stays `null`. The end state runs exactly the same statements in the same order, so lock acquisition, pre-paint writes, error screens and the `app-entry` import timing are unchanged. The only behavioral difference applies to a client that defines the restore global. For such a client the web app would now admit storage normally and never call the native owner (see the gate).

*Why this is the simplest sufficient option:* it deletes the code outright, adds no replacement, and leaves the live adoption flow and its owner (RF-005) alone.

*Non-goals:*

- Retiring the desktop origin adoption page, `origin-window-state-v1.ts` staging, `origin-native-completion-v1.ts` or the desktop profile continuity (RF-005).
- Touching `identityAdoptionBindingSchema` (RF-006).
- Changing the IndexedDB database name or version.
- Changing `bundle-budget.json`.

*Remaining uncertainty:* whether any pre-2026-11-11 iOS build is still in use. That question decides only checkpoint B.

**Expected gain and cost**

Counted with `git show <commit>:<path> | wc -l` and `sed -n '<range>p' | wc -l` on the snapshot. The totals include blank lines between declarations. The figures marked "about" are projections of the edit, not measurements.

| Area | Production lines removed | Test lines removed |
|---|---|---|
| `apps/desktop/src/desktop-origin-first-entry-v1.ts` + test | 522 | 229 |
| `apps/desktop/src/desktop-final-runtime-v1.ts` + test | 59 | 130 |
| `apps/app/src/lib/origin-native-session-restore-v1.ts` + test | 864 | 193 |
| `origin-window-state-v1.ts` (`:1-7`, `:239-251`, `:366-588`, plus about 10 lines of dead target branches in `restoreWindowState`) | about 253 | 0 |
| `prompt-draft-recovery-v1.ts` (`:205-418` plus one import line) + `prompt-draft-recovery-v1.test.ts` | about 215 | 259 |
| `origin-storage-transfer-v1.ts` (`:404-421`) | 18 | 0 |
| `packages/desktop-contract/src/internal/origin-adoption-v1.ts` (`:77-202`) | 126 | 0 |
| `apps/app/src/main.tsx` (native branch and confirmation) | about 25 | 0 |
| `apps/app/index.html` (`:180-182` → one call) | about 2 | 0 |
| `index-html-origin-admission.test.ts:109-145` and `index-html-pre-paint.test.ts:81-82` | 0 | about 40 |
| **Total** | **about 2,080** | **about 850** |

Nothing is added. The mechanisms that disappear are two protocol owners (app and desktop) for a native first-entry peer that no longer exists, a record and receipt store inside the window-state IndexedDB owner, a historical runtime pin, an alternate boot admission ordering, and seven contract schemas. Maintenance gets easier because changes to the composer journal, the window-state store, the legacy storage migration and the domain identity schemas no longer have to keep unreachable code and its fixtures compiling. Performance: the boot chunk loses the engine and its helpers. The byte size is unknown until `vite build` runs, and the change can only shrink the chunk. One `Reflect.get` and one branch also leave startup. Effect: neutral to slightly positive.

**Investigation gate (before checkpoint B)**

1. Ask the owner one question: "Is any iPhone or iPad still running an Omnyo build from before 2026-11-11 (one that still has the BB Private identity handoff) and expected to finish that handoff?" The handoff was a one-time move and its native code was removed in private commit `68cca64070`.
2. If the answer is no, or if the device can simply update to a current build, checkpoint B is approved.
3. If the answer is yes, land only checkpoint A and stop checkpoint B until that device updates.

Checkpoint A has no gate: the desktop modules were never bundled and nothing ever imported them.

**Execution steps**

1. **Reconfirm the baseline.** In a dedicated worktree on current `origin/main`, rerun these checks:
   - `git grep -n -i -E 'OriginSessionRestore|NativeFirstEntry|BeginBrowserStorageAdmission'`. It must still return only the consumers listed in Context.
   - `git grep -n -E 'createDesktopOriginFirstEntryOwnerV1|assertDesktopFinalRuntimeV1|restoreNativeOriginSessionV1|prepareOriginFirstEntryRecoveryV1|applyOriginFirstEntryRecoveryV1|restoreOriginFirstEntryWindowV1|planOriginComposerRecoveryV1|assertOriginAdoptionAcceptedV1|readExactOriginTargetWindowStateV1|restoreOriginTargetWindowStateV1'`. Every hit must be a definition, the restore engine, the two desktop modules or their own tests.
   - Rerun the producer search under `apps/mobile`, `apps/desktop/src` and `packages`.
   - If RF-005 has landed, check whether `origin-adoption-v1.ts` and `origin-window-state-v1.ts` still exist, and recount.
   - Stop and re-plan if any new producer of either global, any new importer of a listed symbol, or a desktop build entry for either desktop module appears.
2. **Behavioral evidence.** No new tests are needed. The existing `apps/app/src/main-migration.test.ts` (normal start and the recovery screen), `apps/app/src/index-html-origin-admission.test.ts` ("refuses an unknown controller key before preference writes"), `apps/app/src/index-html-pre-paint.test.ts`, `apps/app/src/lib/origin-native-completion-v1.test.ts`, `apps/app/src/lib/origin-storage-transfer-v1.test.ts` and `apps/app/src/lib/legacy-browser-storage-v1.test.ts` already cover the surviving path. Record their pass state before editing.
3. **Checkpoint A, desktop (ready now).**
   - Delete `apps/desktop/src/desktop-origin-first-entry-v1.ts`, `apps/desktop/src/desktop-final-runtime-v1.ts`, `apps/desktop/test/desktop-origin-first-entry-v1.test.ts` and `apps/desktop/test/desktop-final-runtime-v1.test.ts`.
   - Leave the contract alone in this checkpoint, because the app engine still imports it.
   - Run the desktop typecheck and tests (see Verification). Commit.
4. **Checkpoint B, app and contract (after the gate). Make all of these edits in one commit.**
   1. `apps/app/index.html`: delete `window.__omnyoBeginBrowserStorageAdmissionV1 = beginAdmission;` (`:180`) and replace the conditional at `:181-182` with an unconditional `beginAdmission();`. Leave the body of `beginAdmission` (`:78-179`) byte-for-byte unchanged.
   2. `apps/app/src/main.tsx`:
      - Delete the import at `:1`, `let confirmNativeEntry ...` at `:24`, the whole `nativeRestore` block at `:28-46` and the `if (confirmNativeEntry) ...` block at `:67-71`.
      - `startApp` then reads `const admission = Reflect.get(window, "__omnyoBrowserStorageAdmission")`, checks `instanceof Promise`, awaits it and calls `assertBrowserStorageMigrationV1()` inside the existing try/catch. It then calls `importLegacyBrowserPreferences()`, and the last try block runs `await import("./app-entry")`.
      - Keep both `showStartupError` messages verbatim.
   3. Delete `apps/app/src/lib/origin-native-session-restore-v1.ts` and `apps/app/src/lib/origin-native-session-restore-v1.test.ts`.
   4. `apps/app/src/lib/origin-window-state-v1.ts`:
      - Delete `:1-6` (the `OriginLocalWindowV1` import and the re-export).
      - Delete `restoreOriginTargetWindowStateV1` (`:239-250`).
      - Delete everything from `originFirstEntryMutationSchemaV1` (`:367`) to the end of the file (`:588`). That covers `readOwnerRecord`, `writeOwnerRecord`, `readExactOriginTargetWindowStateV1`, `firstEntryStorageSelectionSchema`, `firstEntryStorageKey`, `readOriginFirstEntryRecordV1` and `writeOriginFirstEntryRecordV1`.
      - Specialize `restoreWindowState` to the source side: remove the `side` and `expectedSha256` parameters, use `ticket.fromOrigin` at `:261`, always call `snapshotOriginStorageV1(...).local` at `:300-307`, and check `record.side !== "source"` at `:310` with no `expectedSha256` clause. `restoreOriginWindowStateV1` then calls `restoreWindowState(args)`.
      - Drop `export` from `originTargetStorageEntriesV1` and keep the function itself, because `stageWindowState` (`:162-163`) uses it.
      - Keep `stageWindowState` and its `"target"` side unchanged.
   5. `apps/app/src/lib/prompt-draft-recovery-v1.ts`: delete `RecoveryStorage`, `originRecoveryMutationsV1` and `planOriginComposerRecoveryV1` (`:206-418`), and remove `pendingChatDescriptorsSchema` and `migrateLegacyBrowserStorageV1` from the import at `:10-14`. Keep `composerSubmissionEntriesSchema`. Delete `apps/app/src/lib/prompt-draft-recovery-v1.test.ts`.
   6. `apps/app/src/lib/origin-storage-transfer-v1.ts`: delete `assertOriginAdoptionAcceptedV1` (`:405-421`). Keep `adoption()`, because `admitOriginAdoptionV1` still uses it. Confirm this with `git grep -n -w adoption apps/app/src/lib/origin-storage-transfer-v1.ts`.
   7. `packages/desktop-contract/src/internal/origin-adoption-v1.ts`: delete `:78-202` (from `originLocalWindowSchemaV1` through `originNativeFirstEntryReplySchemaV1`). Keep `originSchema`, `originStorageTicketSchemaV1`, `OriginStorageTicketV1`, `originNativeMappingSchemaV1`, `originNativeCompletionSchemaV1` and `originNativeInventorySchemaV1`. Leave the subpath export in `packages/desktop-contract/package.json:12-16` in place, because `origin-native-completion-v1.ts` and `origin-storage-transfer-v1.ts` still import it.
   8. Tests:
      - In `apps/app/src/index-html-origin-admission.test.ts`, delete the case "keeps prepaint writers closed while a native target session must be restored" (`:109-145`). It asserts the deferred ordering, which is the behavior being removed.
      - In `apps/app/src/index-html-pre-paint.test.ts`, delete the two `Reflect.deleteProperty` cleanups at `:81-82`.
      - Do not change any other assertion.
5. **Leftover sweep.** Run `git grep -n -i -E 'OriginSessionRestore|NativeFirstEntry|BeginBrowserStorageAdmission|first-entry|FirstEntry|planOriginComposerRecoveryV1|assertOriginAdoptionAcceptedV1|originLocalWindowSchemaV1|OriginLocalWindowV1'`. The only acceptable hit is unrelated wording, such as `firstEntry` variables in `apps/host-daemon` and `apps/server` tests.
6. **Format and lint the touched files** with the repository's own tools: `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. Then inspect the full diff for unrelated changes and recount the removed lines with `git diff --stat` against the baseline.

**Verification and acceptance criteria**

Run all commands from the repository root of the worktree. The script names come from the snapshot's `package.json` files. The `--filter` package names are `@omnyo/app` (in `apps/app/package.json`), `@omnyo/desktop` and `@omnyo/desktop-contract`. These commands were not run during the audit, because the snapshot has no node_modules.

- Checkpoint A:
  - `pnpm --filter @omnyo/desktop typecheck` passes.
  - `pnpm --filter @omnyo/desktop test` passes with two fewer test files. The desktop package also defines `test:prepare` (`install-electron`), which may be required first on a fresh clone.
  - `pnpm --filter @omnyo/desktop build` still succeeds. Its entry list does not reference the deleted files.
- Checkpoint B:
  - `pnpm --filter @omnyo/app typecheck` passes.
  - `pnpm --filter @omnyo/desktop-contract typecheck` passes.
  - `pnpm --filter @omnyo/desktop typecheck` passes, because desktop imports the contract.
  - Focused app tests: `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/main-migration.test.ts src/index-html-origin-admission.test.ts src/index-html-pre-paint.test.ts src/lib/origin-native-completion-v1.test.ts src/lib/origin-storage-transfer-v1.test.ts src/lib/legacy-browser-storage-v1.test.ts`. All pass with unchanged assertions. The `exec vitest run <files>` form is a standard pnpm and vitest invocation, and the `test` script in `apps/app/package.json` is `vitest run --config vitest.config.ts`.
  - `pnpm --filter @omnyo/app lint` passes (an oxlint script in `apps/app/package.json`).
  - Root checks: `pnpm format:check` and `pnpm lint` (both in the root `package.json`).
- Boot behavior: `main-migration.test.ts` proves the normal start and the "Saved browser data needs review" screen. `index-html-origin-admission.test.ts` proves that an unknown controller key is still refused before preference writes, so the `beginAdmission` body is intact. Alex tests UI himself, so no screenshot round is required. A manual load of the web app in a browser, which should reach the thread list, is enough if Alex wants a live check.
- Bundle (optional): after `pnpm --filter @omnyo/app build`, `node apps/app/scripts/check-bundle-budget.mjs` should report a boot payload no larger than before. The script exists, but no package.json script runs it and its arguments were not confirmed.
- Structural completion: the step 5 sweep is clean. The desktop contract exports only ticket, mapping, completion and inventory schemas. `origin-window-state-v1.ts` no longer has a first-entry or target-restore path. `main.tsx` has one admission path.

**Rollback and stop conditions**

- Checkpoint A and checkpoint B are separate commits, and each one can be reverted independently. Checkpoint B must stay a single commit. If `index.html` stopped calling `beginAdmission()` while `main.tsx` no longer called the global, admission would hang. If `main.tsx` kept waiting for a native owner that `index.html` no longer published, a native client would see the startup error screen.
- The change has no data-compatibility effect. Leftover `first-entry:*` rows in IndexedDB are never read, and the database name and version are unchanged.
- Stop conditions:
  - Alex reports an in-use pre-2026-11-11 iOS build that is mid-handoff. Land checkpoint A only.
  - A new producer of `__omnyoOriginSessionRestoreV1` or `__omnyoNativeFirstEntryV1` appears.
  - A new importer of any symbol listed for deletion appears outside the deleted files.
  - RF-005 has already restructured `origin-window-state-v1.ts` or the contract. Recount and re-plan against the new layout.
  - A surviving focused test fails for a reason other than a removed import. Investigate before changing any assertion.
- Safer smaller alternative: land checkpoint A alone, plus the gate-free deletion of the already-uncalled `restoreOriginTargetWindowStateV1`.
