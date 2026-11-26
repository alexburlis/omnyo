# RF-034 — Delete the never-constructed desktop JSON version-feed checker and its always-null plumbing in desktop main

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, with small scope corrections (see "Expected gain and cost").
- **Potential:** medium. A whole second update service, its 362-line test, a two-source info merge, a constant feature flag and a smoke-test feed stub disappear. The runtime has had one update mechanism since 2026-10-13; the code still reads as if it had two.
- **Confidence:** high. Proven by inspection at the snapshot and in history.
- **Readiness:** ready. No owner decision is needed, because no shipped desktop build constructs the service.
- **Effort:** small, about 1.5 to 3 hours including the desktop typecheck and the three affected test files.
- **Risk:** low. The one realistic regression is changing the `OmnyoDesktopInfo` the renderer receives. The plan keeps the two normalizations the merge applies today and pins them with tests.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-084 "Retire the desktop JSON version-feed producer and its contract" is the separate producer-side decision (CI publication of `desktop-version*.json`, `apps/desktop/scripts/generate-version-feed.mts`, `packages/desktop-contract/src/version-feed.ts`). This card does not touch the producer, the contract or the README's publication tables. Do RF-034 first; it removes the last runtime consumer and so makes RF-084 a pure publication question.
  - RF-018 "Retire uninvoked one-off proof, benchmark and smoke harnesses" may delete `apps/desktop/scripts/measure-packaged-startup.mjs`. If RF-018 lands first, skip that file here.
  - RF-133 "Drop dependency declarations with no consumer" may pick up `@types/semver` (see step 7).
- **Why it deserves its place:** it is verified dead machinery in the update path, which is release-sensitive code people must read carefully. Every future change to `OmnyoDesktopInfo` or the update lifecycle currently has to reason about a service that cannot exist.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the audit brief had already been removed, so every read used `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and `git grep <pattern> e9e1b74c3`. `git diff --stat e9e1b74c3 5f2d3f895 -- apps/desktop` was empty, so local `main` (5f2d3f895) matched the snapshot for this area on 2026-11-26.

*How desktop updates work today.* The Electron main process (`apps/desktop/src/main.ts`) constructs exactly one update service: `desktopAutoUpdateService = createDesktopAutoUpdateService({...})` at `apps/desktop/src/main.ts:3785`, built on electron-updater with the private signed feed or the pinned public-beta feed (`main.ts:3777-3778`). That service uses the shared scheduler `createDesktopUpdateScheduler` in `apps/desktop/src/desktop-update-scheduler.ts` (`apps/desktop/src/desktop-auto-update.ts:174`). The renderer reads update state through `getCurrentDesktopInfo()` (`main.ts:707`), the `OMNYO_DESKTOP_CHECK_FOR_UPDATES_CHANNEL` IPC handler (`main.ts:2860`) and info-change events.

*The dead second service.* The following facts are **Proven by inspection**:

1. `apps/desktop/src/desktop-update-check.ts` (237 lines) exports `parseDesktopVersionFeed` (line 81), `createDesktopUpdateService` (line 171) and `DESKTOP_UPDATE_CHECK_TIMEOUT_MS` (line 12). It fetched and validated a `desktop-version*.json` feed with `omnyoDesktopVersionFeedSchema` and compared versions with `semver`.
2. `git grep -n -E "desktop-update-check|createDesktopUpdateService|parseDesktopVersionFeed" e9e1b74c3 -- .`, excluding the audit docs, finds only the module itself and `apps/desktop/test/desktop-update-check.test.ts:4-7`. No source, script, Containerfile, package export or dynamic import references the module. `apps/desktop` is an application, not a published package, so no external plugin or SDK consumer can import it.
3. `main.ts:477` declares `let desktopUpdateService: DesktopUpdateService | null = null;`. A search for assignments (`desktopUpdateService\s*=` over `apps/desktop/src`) finds none, so the variable is always `null`. Its five uses are all optional-chained no-ops:
   - `main.ts:710` `feedInfo: desktopUpdateService?.getInfo() ?? null` inside `getCurrentDesktopInfo`;
   - `main.ts:2799` `desktopUpdateService?.stop()` in `finishQuit`;
   - `main.ts:2862` `desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null)` inside the check-for-updates IPC `Promise.all`;
   - `main.ts:3484` `void desktopUpdateService?.checkAfterActive()` in the `did-become-active` handler;
   - `main.ts:4157-4159` `if (desktopUpdateSupport.versionCheck) { desktopUpdateService?.start(); }`.
   The type import `main.ts:250` `import type { DesktopUpdateService } from "./desktop-update-scheduler.js";` exists only for the declaration at line 477.
4. `resolveDesktopUpdateSupport` in `apps/desktop/src/desktop-update-provider.ts:75-87` always returns `versionCheck: false` (line 85). The field is declared on the private interface `DesktopUpdateSupport` at line 72. Only `main.ts:4157` reads it; tests assert the constant at `apps/desktop/test/desktop-update-provider.test.ts:12,24,27` and `apps/desktop/test/public-beta.test.ts:137`.
5. `mergeDesktopUpdateInfo` in `apps/desktop/src/desktop-update-info.ts:23-60` (60-line file) merges `autoInfo` and `feedInfo`. Its only production caller passes `feedInfo: null` (`main.ts:708-711`). The private helper `latestCheckedAt` (lines 8-21) exists only to pick the later of the two timestamps.
6. `OMNYO_DESKTOP_VERSION_FEED_URL` is set by `apps/desktop/scripts/smoke-packaged-app.mjs:368` and `apps/desktop/scripts/measure-packaged-startup.mjs:573`, and nothing reads it (`git grep -n DESKTOP_VERSION_FEED_URL e9e1b74c3 -- .` finds only those two lines). The smoke server serves a fake feed: `createDesktopVersionFeed` at `smoke-packaged-app.mjs:61-83` and the `/desktop-version.json` route at `smoke-packaged-app.mjs:174-184`. The smoke page (`renderSmokePage`, lines 85-117) asserts only `window.omnyoDesktop.platform`, `version` and `info.version`, so it never depends on the feed. `releaseChannel` (line 25) stays because `createDesktopReleaseConfig` at line 27-30 uses it.

*History.* In the retired private repository (`$ARCHIVED_OMNYO_CHECKOUT`), commit `c32232feb6` (2026-10-13, "Prepare guarded private desktop updates") removed `import { createDesktopUpdateService } from "./desktop-update-check.js"`, the `BB_DESKTOP_VERSION_FEED_URL` read and the `desktopUpdateService = createDesktopUpdateService({...})` assignment from `main.ts`. Commit `276e055c10` (2026-10-13) is the other commit the sweep cited for making `versionCheck` constant; its subject was confirmed, its diff was not re-read. The public repository received the code already orphaned in `060950255` ("Publish Omnyo source", 2026-11-24).

*What must stay.*
- `apps/desktop/src/desktop-update-scheduler.ts` and its `DesktopUpdateService` interface: `desktop-auto-update.ts:16,81,174` use them.
- `semver` in `apps/desktop/package.json:41`: `apps/desktop/scripts/prepare-native-modules.cjs:509` still `require("semver")`.
- `omnyoDesktopVersionFeedSchema` and `OmnyoDesktopVersionFeed` in `@omnyo/desktop-contract`: `apps/desktop/scripts/generate-version-feed.mts:6-8,99` and `packages/desktop-contract/test/version-feed.test.ts` use them, and `packages/desktop-contract/src/info.ts:6` reuses the platform schema. That is RF-084's scope.
- Scheduler behavior coverage. The feed test's "throttles rapid active-trigger checks" case (`desktop-update-check.test.ts:311`) exercises the shared scheduler, but `apps/desktop/test/desktop-auto-update.test.ts:248-271` ("checks again on activation after one minute without checking earlier") and `:308-322` already cover the same scheduler throttle through the live service. Deleting the feed test therefore loses only feed-parsing coverage for deleted code.

*Counterevidence considered.* Installed clients from before October may still poll published `desktop-version*.json` files. That is a reason to keep publishing them (RF-084), not a reason to keep this unused consumer in the current app. Upstream `bb` still constructs `createDesktopUpdateService`, so a future upstream backport touching this file would become a modify/delete conflict; Omnyo already diverged here.

*Maintenance cost today.* A reader of `getCurrentDesktopInfo`, the check-for-updates IPC, quit and activation sees two update services and a merge with precedence rules (feed `latestVersion` over auto, latest of two timestamps), and must discover by search that one side is always `null`. Changes to `OmnyoDesktopInfo` or the scheduler must keep a 362-line test of dead code passing. The README tells operators that the app polls the JSON feed (see below), which is false.

*Stale documentation in scope (runtime claims only).* `apps/desktop/README.md:182-185` says Windows builds "check `desktop-version-windows.json` for new versions"; `:232-235` says the JSON feed "is polled on every Linux install"; `:410-416` says the renderer toast "keeps using `desktop-version.json`" and that "these checks run in parallel". All three describe the deleted runtime consumer.

**Proposed end state and preservation argument**

*What disappears.* `desktop-update-check.ts` and its test; the `desktopUpdateService` variable, its type import and its five call sites; `versionCheck` on `DesktopUpdateSupport`; the two-input `mergeDesktopUpdateInfo` and `latestCheckedAt`; the smoke feed stub, its route and both env injections; the README's runtime JSON-feed claims.

*What remains and owns update state.* `createDesktopAutoUpdateService` is the single update service. `desktop-update-info.ts` keeps one small pure function that applies today's two renderer-facing normalizations to that service's info:

```ts
// apps/desktop/src/desktop-update-info.ts
export function normalizeDesktopUpdateInfo(
  info: OmnyoDesktopInfo | null,
): OmnyoDesktopInfo | null {
  if (info === null) return null;
  return {
    ...info,
    latestVersion: info.pendingVersion ?? info.latestVersion,
    updateAvailable: info.updateAvailable || info.updateDownloaded,
  };
}
```

*Equivalence with today (Proven by inspection).* With `feedInfo === null`, `mergeDesktopUpdateInfo({ autoInfo, feedInfo: null })` evaluates as follows. The schema in `packages/desktop-contract/src/info.ts:18-28` makes `lastCheckedAt`, `latestVersion` and `pendingVersion` required nullable fields and `updateAvailable` and `updateDownloaded` required booleans, so every `?? null` and `?? false` on `autoInfo` fields is a no-op.
- `baseInfo = autoInfo`, so `null` in gives `null` out. This is the same.
- `downloadState` is re-set only when defined, and the spread already copied it. This is the same.
- `lastCheckedAt = latestCheckedAt(null, autoInfo.lastCheckedAt) = autoInfo.lastCheckedAt`. This is the same.
- `latestVersion = autoInfo.pendingVersion ?? autoInfo.latestVersion`. This is kept.
- `pendingVersion` and `updateDownloaded` are copied unchanged. This is the same.
- `updateAvailable = autoInfo.updateAvailable || autoInfo.updateDownloaded`. This is kept.
- `serverDaemonLogsAvailable` is still added afterwards by `getCurrentDesktopInfo`.

Key order in the returned object can differ only for keys the spread already contains, and the object crosses IPC as structured data, so order is not observable.

*Why keep a normalizer rather than pass the info through.* Hypothesis: `createDesktopAutoUpdateService` may already keep `latestVersion === pendingVersion` and `updateAvailable === true` whenever `updateDownloaded` is true (see `desktop-auto-update.ts:221-239,287-290`), which would make the normalizer an identity. That was not proven for every transition, so this card keeps it. Removing it would be a separate, evidence-gated follow-up.

*Behavior of the remaining call sites.*
- The check-for-updates IPC awaits only `desktopAutoUpdateService?.checkForUpdates()` and still resolves to `getCurrentDesktopInfo()`. Error propagation does not change, because the removed branch was always `Promise.resolve(null)`.
- `finishQuit` and `did-become-active` lose only no-op calls, and their ordering among the other calls does not change.

*Unaffected contracts.* The preload API, the IPC channel names, the `OmnyoDesktopInfo` schema, the renderer toast and Settings states, and the persisted data are unchanged. There is no UI change.

*Reachability proof and remaining uncertainty.* The searches are listed in Context. The `apps/desktop` source contains no dynamic `import()` by string for this module. The packaged app bundles `main.ts` and its static imports only. Remaining uncertainty: none for the runtime. The producer side is deliberately out of scope.

*Non-goals.*
- The feed producer, CI publication, `desktop:version-feed`, `generate-version-feed.mts`, the contract schema and the README's publication tables (`README.md:285-297,331-333,403`). These belong to RF-084.
- The scheduler.
- Any Linux update capability (see the incidental issue in the structured report).

**Expected gain and cost**

Measured with `git show e9e1b74c3:<file> | wc -l`. The removal figures below are projections from the cited ranges.

| Item | Production lines removed (approx.) | Added |
|---|---|---|
| `apps/desktop/src/desktop-update-check.ts` | 237 | 0 |
| `apps/desktop/src/desktop-update-info.ts` (60 lines become about 14) | about 46 | about 14 (counted in the net) |
| `apps/desktop/src/main.ts` (lines 250, 477-478, 710, 2799, 2861-2864, 3484, 4157-4160) | about 12 | about 1 |
| `apps/desktop/src/desktop-update-provider.ts:72,85` | 2 | 0 |
| `apps/desktop/scripts/smoke-packaged-app.mjs:61-84,174-184,368` | about 37 | 0 |
| `apps/desktop/scripts/measure-packaged-startup.mjs:573` | 1 | 0 |
| **Handwritten production total** | **about 335** | **about 15**, so a net reduction of about 320 |

- **Tests:** `apps/desktop/test/desktop-update-check.test.ts` (362 lines) is deleted. `apps/desktop/test/desktop-update-info.test.ts` (58 lines) is rewritten at about the same size, because all three of its cases are about feed interaction. Four `versionCheck` assertion lines go from `desktop-update-provider.test.ts` and `public-beta.test.ts`. The net is about 365 test lines removed.
- **Docs:** three README paragraphs are rewritten, at roughly the same length.
- **Mechanisms:** update services in main go from 2 to 1 (one was never constructed). Info sources merged go from 2 to 1. Dead lifecycle and IPC call sites go from 5 to 0. A constant feature flag goes from 1 to 0.
- **Performance:** neutral at runtime, because every removed call was an optional-chain no-op. The main bundle shrinks by one module, which was not measured.
- **Cost:** about 2 hours. There is no data, persisted format or compatibility migration.

Corrections to the sweep reports: X2-RF-005's "about 260 production lines" omitted the `main.ts`, `desktop-update-info.ts` and provider removals. S11's "about 300-330" matches this count.

**Execution steps**

1. **Reconfirm the baseline.** In a writable worktree on current `main`, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/desktop packages/desktop-contract`. Re-run `rg -n "desktop-update-check|createDesktopUpdateService|parseDesktopVersionFeed|desktopUpdateService|DESKTOP_VERSION_FEED_URL|versionCheck|feedInfo|mergeDesktopUpdateInfo" apps packages plugins scripts tests`. **Stop and re-plan** if any of the following holds:
   - anything assigns `desktopUpdateService`;
   - any code reads `OMNYO_DESKTOP_VERSION_FEED_URL`;
   - `resolveDesktopUpdateSupport` returns a non-constant `versionCheck`;
   - a new caller passes a non-null `feedInfo`.
2. **Pin today's behavior before editing.** Rewrite `apps/desktop/test/desktop-update-info.test.ts` against the current `mergeDesktopUpdateInfo` with `feedInfo: null`, and confirm that it passes on the unchanged code. Use these cases:
   - (a) `autoInfo: null` returns `null`.
   - (b) `pendingVersion: "0.0.3"`, `latestVersion: "0.0.2"` gives `latestVersion: "0.0.3"`.
   - (c) `updateAvailable: false`, `updateDownloaded: true` gives `updateAvailable: true`.
   - (d) `downloadState: "downloading"` is preserved, and an input without `downloadState` produces an output without that key (`not.toHaveProperty("downloadState")`).
   - (e) `lastCheckedAt` is passed through unchanged.
   - (f) every other field equals the input (`toEqual` on a full fixture).
   Replace the three feed-interaction cases, which test only the deleted feed merge.
3. **Checkpoint A: info normalizer.** In `apps/desktop/src/desktop-update-info.ts`, delete `MergeDesktopUpdateInfoArgs`, `latestCheckedAt` and `mergeDesktopUpdateInfo`, and add `normalizeDesktopUpdateInfo` exactly as shown above. Update the test import and calls to `normalizeDesktopUpdateInfo(autoInfo)`, and run the info test.
4. **Checkpoint B: desktop main.** In `apps/desktop/src/main.ts`:
   - remove the import at line 250 (`import type { DesktopUpdateService } ...`) and the declaration at line 477;
   - change the import at line 258 to `normalizeDesktopUpdateInfo`;
   - in `getCurrentDesktopInfo` (line 707), call `normalizeDesktopUpdateInfo(desktopAutoUpdateService?.getInfo() ?? null)`;
   - in `finishQuit`, delete line 2799;
   - in the `OMNYO_DESKTOP_CHECK_FOR_UPDATES_CHANNEL` handler, replace the `Promise.all([...])` at lines 2861-2864 with `await desktopAutoUpdateService?.checkForUpdates();`;
   - in `did-become-active`, delete line 3484;
   - delete the `if (desktopUpdateSupport.versionCheck) { ... }` block at lines 4157-4159.
   Keep the `desktopUpdateSupport.autoUpdate` branch unchanged.
5. **Checkpoint C: support flag.** In `apps/desktop/src/desktop-update-provider.ts`, remove `versionCheck` from `DesktopUpdateSupport` (line 72) and from the returned object (line 85). Update the assertions in `apps/desktop/test/desktop-update-provider.test.ts:10-13,22-27` to `{ autoUpdate: false }`, `{ autoUpdate: true }` and `{ autoUpdate: false }`. Rename the test at line 15 so it no longer mentions the JSON checker, for example "enables native updates only on configured macOS". In `apps/desktop/test/public-beta.test.ts:135-138`, assert `{ autoUpdate: false }`. Keep the `toEqual` assertions so that an unexpected extra field still fails.
6. **Checkpoint D: delete the checker.** Delete `apps/desktop/src/desktop-update-check.ts` and `apps/desktop/test/desktop-update-check.test.ts`. Run the desktop typecheck.
7. **Support machinery.**
   - In `apps/desktop/scripts/smoke-packaged-app.mjs`, delete `createDesktopVersionFeed` (lines 61-83 and the following blank line), the `/desktop-version.json` branch (lines 174-184 and its blank line) and the `OMNYO_DESKTOP_VERSION_FEED_URL` entry (line 368). Keep `releaseChannel`.
   - In `apps/desktop/scripts/measure-packaged-startup.mjs`, delete line 573. If RF-018 already removed that file, skip this.
   - Optional: `@types/semver` (`apps/desktop/package.json:55`) has no remaining TypeScript consumer in `apps/desktop`, because the only other `semver` user is a `.cjs` script. Remove it with `pnpm --filter @omnyo/desktop remove @types/semver` only if this change is allowed to touch `pnpm-lock.yaml`; otherwise leave it to RF-133. Keep `semver`.
8. **README (runtime claims only).** In `apps/desktop/README.md`:
   - In lines 182-185, say that Windows builds check and install new versions with electron-updater from `latest.yml` (`nightly.yml` on nightly).
   - In lines 232-244, remove the claim that the JSON feed is polled on Linux. State only what the code does: `resolveDesktopUpdateSupport` enables native updates only on macOS and Windows. Before rewriting, confirm whether Linux AppImage self-install is reachable; at the snapshot it is not, because `autoUpdate` is false on Linux. Do not invent behavior.
   - Rewrite the "Auto-update" section at lines 408-418. electron-updater is the only runtime check. It runs on launch and every minute while enabled, and on activation when the previous attempt was at least one minute earlier. The toast moves to "ready to install" only after a signed update has downloaded. Local dev builds skip it unless `OMNYO_DESKTOP_AUTO_UPDATE=1` is set.
   - Leave the publication tables and feed-file lists alone (RF-084).
   - Read `$HOME/.agents/skills/marketing-copywriting/SKILL.md` once before writing this reader-facing prose.
9. **Final pass.** Re-run the search from step 1; only README publication text and producer files may still mention `desktop-version*.json`. Inspect the full diff for unrelated changes and recount the removed lines against the same baseline.

**Verification and acceptance criteria**

Run every command from the repository root of the writable worktree. The script names were read from `apps/desktop/package.json` and the root `package.json` at the snapshot. None of them was executed during this audit, because the snapshot has no `node_modules`.

- **Typecheck:** `pnpm --filter @omnyo/desktop typecheck` (script `tsc --noEmit`) must pass with no remaining `versionCheck` or `mergeDesktopUpdateInfo` reference.
- **Focused tests:** `pnpm --filter @omnyo/desktop exec vitest run --config vitest.config.ts test/desktop-update-info.test.ts test/desktop-update-provider.test.ts test/public-beta.test.ts test/desktop-auto-update.test.ts test/private-update-lifecycle.test.ts` must pass. The command shape is unconfirmed: `vitest.config.ts` uses `sharedWorkerProjects`, and the turbo task `@omnyo/desktop#test` depends on `test:prepare` (`install-electron`). If the direct call cannot find Electron, run `pnpm exec turbo run test --filter=@omnyo/desktop` instead. The new info tests from step 2 must pass both before and after checkpoint A, which is the independent baseline.
- **Lint and format:** `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>` (the root has `.oxlintrc.json` and `.oxfmtrc.json`), then `pnpm format:check` for the changed files.
- **Packaged smoke (optional; it needs a packaged build):** `pnpm exec turbo run smoke:packaged --filter=@omnyo/desktop`, as documented in `apps/desktop/README.md:198`. It must still report the preload-ready check as `ok=1`. This is the only check that the removed stub was unused at runtime. Run it if a packaged build is already available; otherwise the inspection proof in Context stands.
- **Structural completion:** `rg -n "desktopUpdateService|createDesktopUpdateService|parseDesktopVersionFeed|DESKTOP_VERSION_FEED_URL|versionCheck|feedInfo" apps/desktop` returns nothing. `apps/desktop/src/main.ts` has one update-service variable. `desktop-update-scheduler.ts` is unchanged.
- **UI:** none is affected; no renderer, preload or contract file changes. A visual check is not required.
- **Performance:** no measurement is required, because the removed calls were no-ops on a null reference. Do not claim a startup gain.

**Rollback and stop conditions**

- **Reversible boundary.** The change is one local commit touching `apps/desktop` sources, tests, two scripts and the README. It has no persisted data, migration, IPC or contract change, so `git revert` of that commit restores the previous state completely.
- **Stop conditions.** Stop if any of the following appears:
  - any consumer of `desktop-update-check.ts` or `OMNYO_DESKTOP_VERSION_FEED_URL` that step 1 finds;
  - a product decision to restore JSON-feed update notices (for example, for Linux builds, which currently get no update notice at all);
  - a failing step-2 characterization test after checkpoint A, which means the normalizer is not equivalent; fix the normalizer rather than the test.
- **Safer smaller alternative.** If the README or Linux question blocks the change, land checkpoints A to D and step 7 alone, and leave the README edits for the decision.
