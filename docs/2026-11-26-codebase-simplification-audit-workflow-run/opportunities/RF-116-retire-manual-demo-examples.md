# RF-116 — Retire the three manual-only example plugins (`thread-chat-demo`, `replacement-lab-alpha`, `replacement-lab-beta`) or make them discoverable

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low. About 474 handwritten example lines (not shipped product code), 186 manifest, config and README lines, 9 `turbo.json` lines and about 45 generated lockfile lines disappear, together with the repository's only TypeScript 5 install.
- **Confidence:** high that nothing in the repository, the private plugin repository or the agent docs consumes the three directories. Medium on the value judgement, because the directories are deliberate manual QA fixtures.
- **Readiness:** decision-needed. Alex decides whether manual demonstration fixtures for `ThreadChat`, targeted fixed tabs and exclusive replacement are still wanted.
- **Effort:** small, about one hour including lockfile regeneration and the typecheck.
- **Risk:** low. Examples are not bundled, published or installed by any script. The only loss is a ready-made manual QA setup for two-provider exclusive replacement.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-020 (derive plugin-SDK turbo task dependencies from defaults) also edits the three `turbo.json` entries this card deletes; whichever lands second drops or skips those entries. RF-115 (placeholder Plugin API Tester plugin) is the same kind of keep-or-retire decision for a fixture-like plugin. RF-095 touches `PluginThreadChat`, the host component `thread-chat-demo` renders, but not this example.
- **Why it deserves its place:** every SDK change that renames or tightens a `fileOpener`, `experimental_threadList`, `messageAction` or fixed-tab prop must keep these three packages compiling, and the two replacement-lab copies must be edited twice. In return they give no automated coverage and no guide reference. The gain is small, so this ranks low; it stays in the audit because the decision is cheap and the alternative (listing them in the guide) is also cheap.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had been removed, so every file was read with `git -C $OMNYO_CHECKOUT show <commit>:<path>` and searched with `git grep <pattern> <commit>`. No test suite could run (no `node_modules`); test coverage claims below come from reading test files.

What the three directories are (Proven by inspection):

- `examples/plugins/thread-chat-demo/` (`app.tsx` 203 lines, `server.ts` 5, `package.json` 31, `tsconfig.json` 22, `README.md` 34). `app.tsx:164` `definePluginApp` registers a nav panel "ThreadChat demo" (`app.slots.navPanel`), a thread panel (`app.slots.threadPanelAction`) and `app.slots.messageAction`. It renders the host `ThreadChat` component, calls `panel.openFixedTab(...)` at `app.tsx:56` and reads the target with `experimental_useFixedTabTarget(demoThreadFixedTab)` at `app.tsx:96`. Its README documents manual steps that start with `omnyo plugin install ./examples/plugins/thread-chat-demo`.
- `examples/plugins/replacement-lab-alpha/` and `examples/plugins/replacement-lab-beta/` (`app.tsx` 128 lines each, `server.ts` 5 each, `package.json` 27 each, `tsconfig.json` 13 each, `README.md` 14 and 5). Each registers `app.slots.experimental_threadList` and `app.slots.fileOpener` (extensions `md`, `mdx`) with a "Crash" button and an "Embed Omnyo original" checkbox. The alpha README lists the manual protocol: Automatic selects Alpha first, Settings can pin Omnyo, Alpha or Beta, the `Original` renderer can be embedded, Crash exercises owner fallback, and disabling Alpha reveals Beta.
- Alpha and beta are near-copies. `diff` of the two `app.tsx` files differs only in the `LABEL` constant, component names, error strings, ids and titles, one `border-dashed` class and two copy lines (`app.tsx:35`, `app.tsx:69`). The two `server.ts` files differ only in the log text.
- History in the retired private repository (`git -C $ARCHIVED_OMNYO_CHECKOUT log --all -- examples/plugins/<dir>`): `thread-chat-demo` has 20 commits since 2026-07-20 (BB-70) and each replacement-lab directory has 13 since 2026-08-17 (#1708). Recent ones are repository-wide sweeps (the BB-to-Omnyo rename `8498d76a89`, the type-aware promise lint `0509f46aae`), which is the maintenance cost this card removes.

Consumer search (Proven by inspection, with the stated scope):

- `git grep -n -e thread-chat-demo -e replacement-lab -e thread_chat_demo -e replacementLab -e replacement_lab e9e1b74c -- ':!examples' ':!pnpm-lock.yaml'` returns only `turbo.json:1083`, `turbo.json:1086` and `turbo.json:1089` (the three `#typecheck` task entries, 9 lines in total).
- `git grep -i -e 'Replacement Lab' -e 'ThreadChat demo' -e 'thread chat demo' -e 'demo panel'` outside `examples/` and the lockfile returns nothing, so no doc, test or UI string names their display titles.
- `rg -l -e thread-chat-demo -e replacement-lab $OMNYO_PLUGIN_CHECKOUT $HOME/.agents` returns nothing.
- The guide's example lists name other examples only: `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/testing.md:244-251` lists `slack-bot` and `agent-enrichment`, and `packages/templates/src/templates/omnyo-guide-plugins.md:1028-1030` lists slack-bot, agent-enrichment and composer-customization.
- Generic directory scanners include `examples/plugins/*` but do not depend on these three: `pnpm-workspace.yaml:10` (workspace membership), `vitest.config.ts:10` `discoverVitestProjects` (only directories with a `vitest.config.ts`; none of the three has one), `scripts/oxlint-plugin.mjs:28` `workspacePackageNames`, `scripts/plan-ci.mjs:95` (path regex), `packages/plugin-build/src/svg-asset.test.ts:23` `discoverFirstPartyBrandingSvgs` (only `icons/` directories; none of the three has one), `turbo.json:792` (`examples/plugins/*/icons/**`). The server hero tests (`apps/server/test/services/plugins/heroes.test.ts:24`, `heroes-phase2.test.ts:30`) install only `agent-enrichment` and `slack-bot`.
- Nothing ships them: `packages/plugin-build/src/bundled-workspace.ts`, `apps/desktop`, `apps/server/src`, `packages/plugin-registry` and the Containerfiles have no reference to `examples` that selects these packages. All three `package.json` files are `"private": true`.

Is any capability left without a consumer or test? (Proven by inspection)

- `thread-chat-demo` is the only non-test, non-doc caller of `openFixedTab`, `experimental_useFixedTabTarget` and `experimental_target` (`git grep -l` over `plugins/` and `examples/` code files). Those public SDK APIs stay covered by `packages/plugin-sdk/src/testing/__tests__/app-harness.test.tsx:99-133` and `:1278-1325` and by `apps/app/src/components/plugin/PluginPanelRightPanelHost.test.tsx:702-717` and `:1251`. `packages/plugin-sdk/src/__tests__/frontend-exports.test.ts:18` checks that every public runtime value is declared in the bundled types. The guide documents the APIs at `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/frontend-core-slots.md:129-147`.
- `ThreadChat` and `messageAction` have a production consumer, `plugins/side-chat/app.tsx:9`, `:292-318`, tested by `plugins/side-chat/app.test.tsx`.
- Every item of the replacement-lab README protocol maps to an app unit test: `apps/app/src/lib/plugin-replacement-preference.test.ts:39` (first registered replacement wins), `:46` (keep Omnyo's implementation), `:52` (pin a provider), `:60` (pinned provider unavailable); `apps/app/src/lib/plugin-slot-resolvers.test.ts:146` and `:225` (reveal the next provider after removal); `apps/app/src/components/plugin/PluginReplacementSlot.test.tsx:44` (delegate to the bound `Original`) and `:63` (restore the owner after a crash); `apps/app/src/components/settings/FileOpenersSettingsSection.test.tsx:36` (Automatic and pinned choices persist). What the tests do not reproduce is the end-to-end case of two real installed plugins competing; that remains the counterevidence.
- `thread-chat-demo/package.json:26` pins `"typescript": "^5.7.0"` while the other examples use `npm:@typescript/typescript6@^6.0.2`. In `pnpm-lock.yaml`, `typescript@5.9.3` (package entry near line 17210, snapshot near line 30730) has no other referrer (`grep -c 'typescript@5\.9\.3)\|typescript: 5\.9\.3'` returns 0; the other `^5.7.0` user, `apps/server/test/fixtures/plugins/bb-plugin-sdk-0.4.8-scaffold`, is not a workspace member). Deleting the demo therefore also drops TypeScript 5 from the install (Proven by inspection of the lockfile; the install-size effect is a projection).

Maintenance cost today: three private packages that compile against the SDK on every `pnpm typecheck`, three hand-maintained turbo entries, three lockfile importers, and a duplicated alpha/beta pair that every slot-prop change must edit twice.

**Proposed end state and preservation argument**

Owner choice, presented as two options:

- **Option A (recommended): delete.** Remove the three directories, their three `turbo.json` entries and their lockfile importers. `plugins/side-chat` stays the working reference for `ThreadChat` and `messageAction`. The guide (`frontend-core-slots.md:129-147`) and the SDK and app tests stay the reference for targeted fixed tabs and exclusive replacement. A manual two-provider check can still be done when needed by installing any two plugins that register the same slot (for example two file openers among `plugins/docs`, `plugins/monaco-editor` and `plugins/pdf-preview`, which all call `app.slots.fileOpener`), so the capability to run that QA does not depend on these fixtures.
- **Option B: keep and document.** Keep the three directories and add one bullet each to `testing.md:244-251` and to `omnyo-guide-plugins.md:1028-1030`, so the typecheck cost buys discoverability. Optionally collapse alpha and beta into one source parameterised by `LABEL`; that is not recommended, because two independent packages are what the fixture needs to show plugin-level enable and disable.

What disappears in Option A: the three example packages and nothing else. No public API, SDK export, persisted format, route, setting key or UI changes. No user installation can contain these plugins unless a developer installed them by path, and such a local install keeps working from its own install copy until the developer removes it (Hypothesis; installed plugins are copied into the server's plugin store, which this card did not trace).

Non-goals: changing `ThreadChat`, the fixed-tab APIs, the replacement resolvers or their tests; retiring `echo-provider`, `content-script`, `slack-bot`, `agent-enrichment` or `composer-customization`, which all have tests or guide references.

Remaining uncertainty: whether Alex or a QA routine outside the repository uses the replacement-lab pair by path. No reference was found in the repositories and docs searched above; that search does not cover private notes or memory.

**Expected gain and cost**

Measured at the snapshot (`git show <commit>:<path> | wc -l`):

| Item | Lines removed (Option A) |
|---|---|
| `app.tsx` + `server.ts` (handwritten example code) | 208 + 133 + 133 = 474 |
| `package.json`, `tsconfig.json`, `README.md` | 87 + 54 + 45 = 186 |
| `turbo.json` task entries | 9 |
| `pnpm-lock.yaml` importers and `typescript@5.9.3` entries (generated) | about 45 |

Production product code removed: 0 lines; these are developer examples. Mechanisms removed: three typechecked packages and one duplicated fixture pair. Projection: each `pnpm typecheck` runs three fewer `tsc` tasks, and installs skip TypeScript 5; neither was measured. Option B adds about 6 guide lines and removes nothing.

The causal maintenance link: a change such as renaming a `PluginFileOpenerProps` field today needs edits in `replacement-lab-alpha/app.tsx` and `replacement-lab-beta/app.tsx` and a fresh typecheck of both. After Option A it needs neither.

**Execution steps**

1. **Decision gate.** Obtain the owner's choice of Option A or Option B. Do not edit anything before that answer. If Alex wants the fixtures kept, follow step 6 only.
2. **Reconfirm the baseline** on the current branch, from `$OMNYO_CHECKOUT` or a worktree of it:
   - `git grep -n -e thread-chat-demo -e replacement-lab -- ':!examples' ':!pnpm-lock.yaml'` must still return only the three `turbo.json` entries. Any new hit (a test, script, doc or guide line) invalidates this plan; re-plan around that consumer.
   - `ls examples/plugins/thread-chat-demo examples/plugins/replacement-lab-alpha examples/plugins/replacement-lab-beta` must show no `vitest.config.ts`, `*.test.*` or `icons/`.
   - `rg -l -e thread-chat-demo -e replacement-lab $OMNYO_PLUGIN_CHECKOUT $HOME/.agents` must still be empty.
3. **Option A edits.**
   - Delete the directories `examples/plugins/thread-chat-demo/`, `examples/plugins/replacement-lab-alpha/` and `examples/plugins/replacement-lab-beta/` (15 tracked files; confirm with `git ls-files examples/plugins/thread-chat-demo examples/plugins/replacement-lab-alpha examples/plugins/replacement-lab-beta` that nothing untracked lives there before deleting).
   - In `turbo.json`, remove the three task entries `"omnyo-plugin-replacement-lab-alpha#typecheck"`, `"omnyo-plugin-replacement-lab-beta#typecheck"` and `"omnyo-plugin-thread-chat-demo#typecheck"` (snapshot lines 1083-1091). If RF-020 has already replaced per-plugin entries with defaults, there is nothing to remove.
4. **Regenerate the lockfile through its source.** Run `pnpm install` from the repository root (needs network or a warm pnpm store, and the owner's normal install authority). Confirm that the diff to `pnpm-lock.yaml` removes only the three `examples/plugins/...` importers and the `typescript@5.9.3` package and snapshot entries. Any other lockfile change is a stop condition.
5. **Checkpoint.** Run the verification below and inspect `git diff --stat`: it should list 15 deleted files, `turbo.json` and `pnpm-lock.yaml`, and nothing else.
6. **Option B edits (only if chosen instead).** Add one bullet each for `thread-chat-demo` ("host `ThreadChat`, `messageAction`, targeted fixed tabs") and the replacement-lab pair ("install both to exercise exclusive thread-list and file-opener replacement") to `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/testing.md` after line 251, and extend the sentence in `packages/templates/src/templates/omnyo-guide-plugins.md:1028-1030`. Read `$HOME/.agents/skills/marketing-copywriting/SKILL.md` before writing that guide prose, as the global instructions require. Check whether `omnyo-guide-plugins.md` is generated or mirrored by `scripts/omnyo-guide-map.mjs` and edit the source it names.

**Verification and acceptance criteria**

Commands (run from the repository root; the root `package.json` scripts were read at the snapshot):

- `pnpm typecheck` (root script `turbo run typecheck`) must pass. Turbo must not fail on a task entry for a missing package.
- `pnpm --filter @omnyo/plugin-build test` (package script `vitest run --config vitest.config.ts`) must pass; it includes `svg-asset.test.ts` and `bundled-workspace.test.ts`, which scan `examples/plugins`.
- `pnpm lint` (root script `turbo run lint`) must pass; `scripts/oxlint-plugin.mjs` reads every `examples/plugins/*/package.json`.
- `pnpm check:plugin-forks` (root script `node scripts/check-plugin-forks.mjs`) should pass unchanged.
- For Option B, the existing guide test `apps/server/test/services/plugins/plugin-authoring-docs.test.ts` should pass; run it through the server package's test script (not confirmed here: read `apps/server/package.json` for the exact script name first).

Structural completion for Option A: `git grep -n -e thread-chat-demo -e replacement-lab` returns no hit anywhere, including `pnpm-lock.yaml`; `examples/plugins/` contains `agent-enrichment`, `composer-customization`, `content-script`, `echo-provider` and `slack-bot` only; `pnpm-lock.yaml` has no `typescript@5.9.3` entry.

No UI, performance or persisted-data check applies: the change touches no shipped code.

**Rollback and stop conditions**

Rollback is a plain `git revert` of the single commit; it restores the directories, turbo entries and lockfile importers, after which `pnpm install` reinstalls them. There is no data or compatibility implication.

Stop and report instead of continuing when:

- Alex wants to keep manual two-provider replacement fixtures (switch to Option B).
- Step 2 finds a new consumer, such as a test, a script, a QA doc or a guide reference.
- The regenerated lockfile changes anything beyond the three importers and `typescript@5.9.3`; investigate which package still needed TypeScript 5.
- `pnpm typecheck` or the plugin-build tests fail because of the removal; that would mean a scanner depends on these directories after all.
