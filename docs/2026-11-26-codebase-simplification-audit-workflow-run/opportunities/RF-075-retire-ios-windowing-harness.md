# RF-075 — Remove the dead instant-history cases and the no-op "candidate windowing" mode from the iOS scroll acceptance harness, or retire the harness

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low to medium. No production code changes. The harness is 1,783 non-production lines. The default plan (option B) removes about 330 to 370 of them, all verified dead. Option A, which needs an owner decision, removes all 1,783.
- **Confidence:** high that the removed parts are dead. Medium on how much value the remaining physical-device cases still have.
- **Readiness:** ready for option B, the default. Option A needs the owner's decision, because it ends the only physical-iPhone momentum-scroll check of the production chat scroll body.
- **Effort:** option B takes 1 to 2 hours of editing, plus a physical-device run if Alex wants one. Option A takes under 30 minutes.
- **Risk:** none for the product, because nothing in the product imports, builds or ships this folder. If option A is chosen, the team loses the ability to rerun physical-device scroll-anchoring evidence.
- **Prerequisites:** none.
- **Related:** RF-018 and RF-019 (other uninvoked proof harnesses; same retire-or-register question). Incidental issues found while verifying are listed separately in the audit's structured summary, not in this plan: a stale windowing section in a shipped guide skill, a candidate test that now always fails, and a likely-broken fixture build.
- **Why it deserves its place:** about a fifth of the harness tests a fixture and a production behavior that no longer exist. Its README tells readers that a production "iOS guard" and a virtualized path exist, and neither does. Each change to `BottomAnchoredScrollBody` or the frame contract currently means maintaining two launch modes that render the same thing, plus three test cases that cannot pass. The item ranks low because its gain is confined to supporting infrastructure.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). I read every file through `git -C $OMNYO_CHECKOUT show <commit>:<path>` because the snapshot worktree was no longer on disk. Private history comes from `$ARCHIVED_OMNYO_CHECKOUT`, read-only.

What the harness is. `apps/mobile/script/ios-performance-acceptance/` is a standalone XcodeGen iOS app. Its WKWebView loads a Vite-built fixture through a custom `bbfixture:` scheme (`App/FixtureSchemeHandler.swift`). The fixture (`fixture/timeline-fixture.tsx` "AcceptanceFixture") renders 500 synthetic rows inside the production `BottomAnchoredScrollBody` (`apps/app/src/components/ui/bottom-anchored-scroll-body.tsx:184`). A frame collector (`fixture/numeric-frame-collector.ts` "installFrameCollector") reports 12-number frame tuples to XCTest. XCTest (`UITests/TimelineWindowingAcceptanceTests.swift`) performs native flicks on a physical iPhone.

Line counts (Proven by inspection; command: `git ls-tree -r --name-only <commit> apps/mobile/script | while read f; do git show "<commit>:$f" | wc -l; done`):

| File | Lines |
|---|---|
| `UITests/TimelineWindowingAcceptanceTests.swift` | 420 |
| `fixture/timeline-fixture.tsx` | 391 |
| `App/AcceptanceViewController.swift` | 298 |
| `fixture/numeric-frame-collector.ts` | 287 |
| `fixture/fixture.css` | 96 |
| `README.md` | 93 |
| `App/FixtureSchemeHandler.swift` | 58 |
| `project.yml` | 48 |
| `vite.config.mts` | 44 |
| `App/AppDelegate.swift` | 19 |
| `fixture/index.html` | 15 |
| `fixture/main.tsx` | 13 |
| `.gitignore` | 1 |
| **Total** | **1,783** (0 production; 795 Swift, 691 TS/TSX, 297 other) |

Facts that establish what is dead (all Proven by inspection unless labeled):

1. **Timeline windowing is gone from production.** Private commit `64fdce5b0e` (2026-11-07, "Rebuild chat scrolling around one position owner") says "Rows render in normal flow; windowing … removed". At the snapshot, `git grep -l -E 'useVirtualizer|TimelineWindowed|@tanstack/react-virtual' -- apps/app/src` finds only non-timeline files (file preview, diff panel, path browser, and tests). The fixture's `FixtureRows` maps every row with no windowing (`fixture/timeline-fixture.tsx:66-127`). The README admits as much (`README.md:3-7`): "The baseline and candidate launch modes below now render identically; they remain only so existing XCTest cases keep their launch arguments."
2. **The "candidate" mode is a no-op.** `--candidate-windowing` (`App/AppDelegate.swift:12-14`) sets `candidateWindowing`, which only injects a user-agent mask that rewrites `iPhone|iPad|iPod` to `Mobile` (`App/AcceptanceViewController.swift:69-85`). Nothing the fixture imports reads `navigator.userAgent`. The only user-agent readers are `apps/app/src/lib/ios-webkit.ts` "isIOSWebKit" (used by `AppLayout.tsx`), `attachment-diagnostics.ts` and `voice-diagnostics.ts` (search: `git grep -l userAgent <commit> -- apps/app/src packages`, ignoring tests). `bottom-anchored-scroll-body.tsx` imports only react, jotai, `@omnyo/shared-ui` utilities and motion, `page-shell-content-style`, `page-scroll-to-top`, `app-keybindings` (which reads `navigator.platform`, not the user agent) and `layoutAnimationAtoms`.
3. **`OMNYO_IOS_WINDOWING_INTERACTION_MODE` only selects that no-op mode** (`UITests/TimelineWindowingAcceptanceTests.swift:222-232` "launchInteractionCase"). Its only effect is the attachment-name prefix.
4. **`testCandidateBoundsMountedRowsAndCapturesFlick` (`UITests/...Tests.swift:316-328`) asserts behavior that was removed.** It requires `mountedRows <= visibleRows + 16`. Sample column 2 is `rows.length`, which counts all `[data-timeline-row-id]` elements (`numeric-frame-collector.ts:67-69, 193`), and that is always 500 or more. The test therefore cannot pass (Proven by inspection; not executed).
5. **The three instant-history cases test a fixture that was deleted.** `testInstantHistoryPhysicalPreflight`, `testInstantHistoryRetainsViewportWithProductionIOSGuard` and `testInstantHistoryBoundsNativePressureAndRestoresGaps` (`UITests/...Tests.swift:4-220`) look for buttons such as "thread-0", "Load eight pages", "Pin visible anchor" and "Verify history traversal", and for a `"stage":…` report with `status: "instant-history"`. Searching the whole snapshot (`git grep -n -F 'Load eight pages'`, also `'Verify history traversal'`, `'Pin visible anchor'`, `'Read oldest loaded page'`) finds them only in this test file. Private history shows that the producing fixture `tests/qa/instant-chat-history/native-entry.ts` (with `native-transport.ts` and `native-entry.html`) was deleted in `4152177a0b` (2026-11-07): `git show 4152177a0b^:tests/qa/instant-chat-history/native-entry.ts` contains `status: "instant-history"` and "Load eighty older pages". The matching native branches are also dead:
   - `App/AcceptanceViewController.swift:128-141`, the `--instant-history-bundled`, `--instant-history-pressure` and `--instant-history-url` launch paths. The bundled path loads `index.html?native=1`, which the current fixture ignores.
   - `App/AcceptanceViewController.swift:160-198`, the `instant-history` message branch with its accessibility suppression and restoration.
   - `App/AcceptanceViewController.swift:15-17`, the `pressureAXSuppressionCount`, `pressureAXRestorationCount` and `pressureProgress` state.

   `testInstantHistoryPhysicalPreflight` also hard-codes other products' bundle identifiers (`me.offlocalhost.paraspeech-ios*`, `fit.sledge.app`) in a public repository.
6. **The README is stale beyond its opening paragraph.** `README.md:30-45` describes a "production iOS detection", an "existing guard" and a "production virtualized path", none of which exist. `README.md:87-93` describes the candidate as a probe for removing that guard.
7. **Nothing outside the folder uses it.** No hits outside the folder for `ios-performance-acceptance`, `windowingacceptance`, `TimelineWindowingAcceptance`, `candidate-windowing`, `OMNYO_IOS_WINDOWING_INTERACTION_MODE`, `bbfixture`, `__omnyoAcceptance` or `data-acceptance-anchor` (`git grep -F <term> <commit> -- . ':!apps/mobile/script/ios-performance-acceptance'`). The same holds in `$HOME/.agents` and `$OMNYO_PLUGIN_CHECKOUT` (`rg -l`). No `package.json` script, turbo task, CI file or Containerfile names it. `apps/mobile/package.json:13-15` limits typecheck, lint and test to `app src scripts plugins …` and `src/**/*.test.ts` (note `scripts`, not `script`), and `apps/mobile/tsconfig.json` does not include `script`. The only repository check that touches the folder is root `pnpm format:check` (`package.json:37`, `oxfmt . --check`). The only outside import the harness relies on is `sharedViteConfig` from `apps/app/vite.config.ts:17`, which also has other consumers (`apps/app/vite.dev.config.ts`, `apps/app/scripts/why-eager.mjs`), so it stays.

What is still live (counterevidence against full deletion):

- `testBaselineCapturesPhysicalFlickWithExistingIOSGuard`, `testPrependResizeAndAppendRunDuringMomentum`, `testQueuedCorrectionDoesNotCrossThreadSwitch`, `testFocusedRowRemainsAccessibleAfterRangeMoves` and `testSelectedProseRemainsAccessibleAfterRangeMoves` exercise the real `BottomAnchoredScrollBody` under native momentum. They cover prepend, resize and append during deceleration, thread switches, focus and WebKit text selection.
- The web replacement `tests/qa/chat-scroll/run.mts` (Playwright and Chrome, not wired to any script) does not cover iOS momentum. The Omnyo guide skill also records that iOS Safari "cannot correct the scroll position during a touch scroll's momentum" (`plugins/omnyo-guide/skills/omnyo-cli/references/app-settings.md:350-354`), so physical evidence is the only proof for that platform.
- The harness was edited on 2026-11-15 (private `eac03ecb9f`, `e8fb13c72b`, `45fb9d977b`, `655e5d6185`, `1b31889087`). Those edits kept the source consistent with scroll-body changes. None of their messages records a device run. Whether the harness still runs at all is uncertain (Hypothesis): `vite.config.mts:22-27` spreads `sharedViteConfig.build`, which sets `rolldownOptions.input` to the app's `index.html` and `origin-adoption-v1.html` (`apps/app/vite.config.ts:36-42`). A Vite build would then probably emit the app's entries instead of `fixture/index.html`. Nobody has run this build to confirm it.

Maintenance cost today: anyone who changes the frame tuple, the fixture controls or the scroll body's footer contract has to read and keep consistent 420 lines of tests, a quarter of which are dead. They also maintain a launch-mode switch whose two modes render identically, and a README that describes a guard that does not exist.

**Proposed end state and preservation argument**

Option B (default, no product decision needed): keep the harness as a physical-device scroll acceptance app with a single mode.

- Removed:
  - the three instant-history test cases;
  - `testCandidateBoundsMountedRowsAndCapturesFlick`;
  - `launchInteractionCase` and the `OMNYO_IOS_WINDOWING_INTERACTION_MODE` variable;
  - the `candidate:` parameter of `launch`;
  - the `--candidate-windowing` argument and `candidateWindowing` property, together with its custom initializer and user-agent mask script;
  - the instant-history launch paths, message branch and pressure state;
  - the stale "guard" and "candidate" README text.
- Kept unchanged: the fixture (`fixture/*`), the frame collector and its 12-value tuple contract, `FixtureSchemeHandler`, the diagnostics script and label, `project.yml` (bundle identifiers and signing), and `vite.config.mts`.
- Kept with one change: the five live test cases. The three that ran in candidate mode by default now launch in the plain mode. Their rendered DOM and gestures are identical, because the user-agent mask had no reader.
- Owner: the harness stays a parent-run manual tool, as `README.md:58-63` describes. No new script or CI wiring is added.
- Preservation argument: every assertion that can still pass is kept, and only the removed assertions depended on removed behavior. Plain-mode launch matches what the candidate mode rendered, as shown under fact 2 in Context. Attachment names lose their `candidate-`/`baseline-` prefix. No stored consumer reads those names; they live only in each run's `.xcresult`.

Option A (owner decision): delete `apps/mobile/script/` entirely. This is justified only if Alex no longer wants physical iOS momentum evidence for chat scrolling, or prefers to rebuild such a harness when needed. Nothing else changes, because nothing references the folder.

Non-goals: fixing the fixture build input (tracked as an incidental issue), wiring the harness into a package script, changing `BottomAnchoredScrollBody`, editing the stale guide-skill section (a separate issue), or reworking `tests/qa/chat-scroll`.

**Expected gain and cost**

- Option B (projection from the line ranges above, not a measurement):
  - Tests: about 217 lines (`:4-220`), plus 14 (`:316-328` and its blank line), plus 11 (`:222-232`), plus small edits to `launch`.
  - View controller: about 3 (`:15-17`), 8 (custom init and `init(coder:)`), 17 (`:69-85`), 13 (`:128-141` collapses to 1 line) and 39 (`:160-198`).
  - App delegate: about 2.
  - README: about 20 to 30 lines net.
  - Total: about 330 to 370 of the 1,783 non-production lines. Zero production lines.

  One launch mode, one environment variable and four impossible or dead test cases disappear. The README then describes what the harness actually does.
- Option A: all 1,783 non-production lines removed (measured count). The cost is losing a ready-made physical momentum check.
- Performance: neutral. Nothing in product builds includes this folder.
- Unknown: whether the remaining cases pass on the current scroll body. That needs a physical run (see Verification).

**Execution steps**

0. **Decision gate (option A only).** Ask the owner once whether he still wants physical-iPhone momentum evidence for chat scrolling. If he answers no, skip to step 7. Without an answer, run option B, which removes only dead code.
1. **Reconfirm the baseline.** In the working checkout, check that `apps/mobile/script/ios-performance-acceptance/` matches the file list and counts above (`git ls-files apps/mobile/script | xargs wc -l`). Rerun the consumer searches from fact 7, and confirm that `git grep -n -F 'Load eight pages'` still matches only the test file. Re-plan if any of these hold:
   - a fixture that emits `status: "instant-history"` has come back;
   - production code reads `navigator.userAgent` in the scroll body's import graph;
   - timeline windowing has come back in `apps/app`;
   - a script or CI file now references the folder.
2. **Tests (`UITests/TimelineWindowingAcceptanceTests.swift`).**
   - Delete `testInstantHistoryPhysicalPreflight`, `testInstantHistoryRetainsViewportWithProductionIOSGuard` and `testInstantHistoryBoundsNativePressureAndRestoresGaps` (lines 4-220).
   - Delete `testCandidateBoundsMountedRowsAndCapturesFlick` (316-328).
   - Delete `launchInteractionCase` (222-232).
   - Change `private func launch(candidate: Bool)` to `private func launch() -> XCUIApplication` and drop the `--candidate-windowing` branch.
   - In `testPrependResizeAndAppendRunDuringMomentum`, `testQueuedCorrectionDoesNotCrossThreadSwitch` and `testSelectedProseRemainsAccessibleAfterRangeMoves`, replace `let (app, mode) = launchInteractionCase()` with `let app = launch()`, and drop the `\(mode)-` prefix from attachment names.
   - In `testFocusedRowRemainsAccessibleAfterRangeMoves`, change `launch(candidate: true)` to `launch()`.
   - Rename `testBaselineCapturesPhysicalFlickWithExistingIOSGuard` to `testCapturesPhysicalFlickWithAllRowsMounted`, because there is no iOS guard, and rename its `baseline-numeric-frames-N` attachments to `numeric-frames-N`.
   - Keep every remaining assertion as it is.
3. **App (`App/AppDelegate.swift`, `App/AcceptanceViewController.swift`).**
   - In `AppDelegate`, construct `AcceptanceViewController()` without the argument check.
   - In `AcceptanceViewController`, remove `candidateWindowing` and the custom `init(candidateWindowing:)`. Remove `required init?(coder:)` too, if no designated initializer remains that requires it. Otherwise keep `init() { super.init(nibName: nil, bundle: nil) }`.
   - Delete the user-agent mask block (69-85) and the pressure state (15-17).
   - Replace the launch-argument branching (128-141) with `webView.load(URLRequest(url: URL(string: "bbfixture://local/index.html")!))`.
   - Delete the `instant-history` branch in `userContentController(_:didReceive:)` (160-198).
   - Keep the fixture-error path, the numeric-frame report and its metadata, including `webKitUserAgent`, which the tests check for "AppleWebKit".
4. **Checkpoint.** If Xcode, `xcodegen` and the signing profile from `README.md:49-56` are available, generate the project and run `build-for-testing` (see Verification) to prove the Swift compiles. If they are unavailable, rely on a careful read of the diff: the Swift changes only remove members and simplify one initializer.
5. **README (`README.md`).**
   - Retitle it to "Physical iOS chat-scroll acceptance".
   - Rewrite lines 3-7 to say the fixture renders rows unwindowed through the production `BottomAnchoredScrollBody`.
   - Replace lines 30-45 with one paragraph stating that every case runs one mode with the real WebKit user agent.
   - Update the `-only-testing:` name at line 84 to the renamed test.
   - Trim lines 87-93 to the proof limits that still apply: no simulator substitute, and no VoiceOver, bottom-pinned append or nested-detail proof.
   - Keep the signing boundary section.
6. **Structural check and recount.** `rg -n 'candidate|instant-history|INTERACTION_MODE|pressure|guard' apps/mobile/script/ios-performance-acceptance` should return no stale hits. Expected survivors are none, apart from words in unrelated prose such as "safeguard". Recount with `git diff --stat` against the same baseline and report the net lines removed. Format only the files you changed: `pnpm exec oxfmt <changed TS files>` is needed only if any TS file changed; option B changes none. Swift has no repository formatter here, so match the existing style by hand.
7. **Option A only.** Delete the whole folder with `git rm -r apps/mobile/script`. Confirm that `apps/mobile/script` no longer exists and that the searches from fact 7 still return nothing. Name the deleted tracked files in the report.

**Verification and acceptance criteria**

- Structural (repository root):
  - `git grep -n -E 'candidate-windowing|OMNYO_IOS_WINDOWING_INTERACTION_MODE|instant-history|candidateWindowing' -- apps/mobile/script` returns nothing.
  - `git grep -n -F 'Load eight pages'` returns nothing.
  - For option A, `git ls-files apps/mobile/script` is empty.
- Formatting (repository root): `pnpm format:check` (root `package.json:37`, confirmed to exist). It covers the fixture TS and vite config. Option B does not change them, so the result should match the baseline.
- No product check is affected. No package `typecheck`, `lint` or `test` script includes this folder (`apps/mobile/package.json:13-15`, `apps/app/package.json:16-18`), so none of them needs to run.
- Swift compile (optional; needs Xcode, `xcodegen` and the exact profile `acb1c791-ca59-4d54-b985-458ead7b6c3b`): run the `xcodegen generate` and `xcodebuild build-for-testing … -destination 'generic/platform=iOS'` commands from `README.md:64-77`, using `IOS_WINDOWING_RUN_ROOT` under your scratch directory. These commands come from the README and were not executed in this audit. `build-for-testing` needs the `FixtureDist` folder to exist. Running the Vite step `pnpm --dir apps/app exec vite build --config ../mobile/script/ios-performance-acceptance/vite.config.mts` may emit the app's entries instead of the fixture; that is the incidental fixture-build issue. If it does, an empty `FixtureDist/` directory is enough for a compile-only check.
- Physical behavior (optional; only if Alex asks for device verification; the test iPhone's standing authority is in `~/.agents/docs/apple.md`): run `xcodebuild test` from `README.md:78-84` with each of the five remaining test names. Acceptance: the same assertions pass as before the change. A failure that also happens on the unchanged harness is pre-existing; report it rather than adjusting assertions. Do not weaken or rewrite assertions to make a run pass.

**Rollback and stop conditions**

- Rollback: the change touches only files inside `apps/mobile/script/ios-performance-acceptance/`. Reverting the single commit restores everything. There is no persisted data, published contract or shipped artifact.
- Stop and re-plan if any of these turn up:
  - a script, CI job, document or agent skill outside the folder starts referencing the harness or its launch arguments;
  - an instant-history native fixture or a user-agent-dependent windowing guard comes back in production;
  - Alex says the candidate user-agent mask is still wanted for some other WebKit experiment.

  In those cases keep the affected part and remove only the instant-history cases, which are dead on any of these paths.
- If option A is chosen but later physical momentum evidence is needed, restore the folder from git history at the parent of the deletion commit, rather than rebuilding it.
