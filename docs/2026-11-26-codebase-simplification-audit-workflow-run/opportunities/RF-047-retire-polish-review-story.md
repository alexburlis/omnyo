# RF-047 — Retire the "Polish review" Ladle story and its 8,919-line change manifest

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. Two numbers in the sweep report were wrong and are corrected here: the manifest holds 383 change records, not 408. The before side can still be rebuilt by hand from the retired private repository, so it is unconfigured rather than permanently broken.
- **Potential:** medium. No production line disappears. What disappears is a 10,122-line dev-only review tool whose manifest has to keep typechecking and linting with every app change.
- **Confidence:** high that nothing in the product, tests, scripts or builds consumes it. Whether Alex still uses it is unknown.
- **Readiness:** decision-needed. The tool was added on 2026-11-22, four days before this snapshot, for Alex to review two polish passes. Only Alex can say whether that review has finished.
- **Effort:** small, under an hour. Delete two files, then run the app typecheck, the app lint and one Ladle build.
- **Risk:** low. There is no runtime, build, test or plugin consumer. The only loss is a review page Alex may still open.
- **Prerequisites:** The owner confirms that the polish review is finished and chooses how to keep the record (step 1).
- **Related or overlapping RF ids:** none overlap. RF-011 and RF-028, which retire lab variants on the website, follow the same "finished review artifact" pattern in a different app. RF-018 and RF-019, which retire one-off proof harnesses, are similar in kind.
- **Why it deserves its place:** it is the largest single block of dev-only code in `apps/app/src` that serves a finished, one-time purpose. It is cheap to remove and can be restored from Git, but it is not urgent.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit worktree for this snapshot had been removed by the time of verification, so every check below read the commit's objects with `git -C $OMNYO_CHECKOUT show e9e1b74c3…:<path>` and `git grep <commit>`. The snapshot has no `node_modules`, so nothing was built or run.

What the subsystem is. Ladle is the app's story browser (`apps/app/package.json` scripts `storybook` = `ladle serve` and `storybook:build` = `ladle build`). `apps/app/.ladle/config.mjs:42-52` registers stories through the glob `"src/**/*.stories.tsx"`, which picks up `apps/app/src/polish-review/PolishReview.stories.tsx`. That story (title `"Polish review"`, export `BeforeAndAfter` at line 895) is a review console for two polish passes made on 2026-11-22. It reads `apps/app/src/polish-review/polish-review-manifest.ts`, which is hand-written data: types `PolishKind` (line 1), `PolishChange` (line 17), labels `POLISH_KINDS` (36), `POLISH_VISIBILITY_LABEL` (46) and `POLISH_KIND_LABEL` (52), `POLISH_BEFORE_SNAPSHOT` (62), `POLISH_AREAS` (69) and `POLISH_CHANGES` (176 to the end of the file).

The story has two modes:
- **Compare mode** (`CompareStage`, line 504) shows the "before" story and the "after" story side by side, or stacked, or flipped, with playback speed control. The before frame loads a second Ladle server at `${location.hostname}:${POLISH_BEFORE_SNAPSHOT.port}` (lines 896-899). The before frame can also show screenshots from `SHOT_URLS = import.meta.glob("../../.ladle/polish-shots/*.png")` (line 66, read through `shotUrl`, line 72).
- **Read mode** (`ReadAll`, line 804) lists each change's area, kind, how-to-see note, before/after text, reason and touched files.

Observed facts (each one Proven by inspection unless marked otherwise):

| Fact | Evidence |
|---|---|
| Size | `PolishReview.stories.tsx` has 1,203 lines and `polish-review-manifest.ts` has 8,919 lines (`git show <commit>:<path> \| wc -l`). Total 10,122. All of it is dev-only, so 0 production lines. |
| Records | 383 change records (`grep -cE '^\s+howToSee:'`), 144 from pass 1 and 239 from pass 2. 229 records name a `beforeStoryId`, 146 name a `beforeShot` and 191 name an `afterShot`. The sweep's figure of 408 was wrong. |
| No other consumer | `git -C $OMNYO_CHECKOUT grep -n -E "omnyo-ladle-playback-rate\|polish-review\|PolishReview\|POLISH_\|polish-shots\|Polish review\|polish review\|61422\|ladle-before\|f93ae67314" e9e1b74c3… -- . ':!apps/app/src/polish-review/**'` returns no matches. That search covers the whole tracked tree: docs, scripts, plugins, tests, configs and lockfiles. |
| Before commit is not in this repository | `POLISH_BEFORE_SNAPSHOT.commit` is `"f93ae67314"`. `git -C $OMNYO_CHECKOUT cat-file -t f93ae67314` fails with "Not a valid object name". It does exist in `$ARCHIVED_OMNYO_CHECKOUT` (dated 2026-11-22, "Record the Chief build's progress…"). |
| Before worktree is gone | `~/worktrees/omnyo/thr_demo--ladle-before` does not exist. |
| Screenshots never existed in Git | `apps/app/.ladle/polish-shots/` is absent from the snapshot, from the working checkout and from the retired private checkout. `git log --all -- apps/app/.ladle/polish-shots` in the private repository shows no history. As a result, `shotUrl` returns `null` for all 337 shot references. |
| Playback message has no receiver | `postPlaybackRate` posts `{ type: "omnyo-ladle-playback-rate" }` to the before frame. No listener for that message exists anywhere in the snapshot, so cross-origin speed control is already inert. Same-origin speed control (`useSameOriginPlaybackRate`) still works on the after frame. |
| After side still works | Of 177 unique `storyId` values, 174 match a current story export. This was checked with a Python derivation of Ladle ids (kebab-cased title plus `--` plus kebab-cased export name) over all 154 `*.stories.tsx` files at the snapshot. The three that do not match are `thread--timeline--rows--backgroundprocess--overview`, `thread--timeline--selectionmenu--overview` and `ui--scrolltobottombutton--show-and-hide`. The derivation is an approximation of Ladle's id rules (Proven by inspection, approximate). |
| Checked like product code | `apps/app/tsconfig.json` has `"include": ["src", …]`, so `tsc --noEmit` checks both files. The app's `lint` script runs `oxlint src …`. The `.oxlintrc.json:252-262` override for `apps/app/src/**/*.stories.tsx` matches by glob and does not name this file. Vitest excludes stories (`vitest.shared.ts:441`) and `scripts/omnyo-copy-map.mjs:48` skips `.stories.` files, so neither one depends on them. |
| Not in the production bundle | Nothing imports either file outside Ladle. The app's Vite build starts from `index.html`, and stories load only through Ladle's glob. |
| History | In the public repository the files arrive with the squashed import `060950255 Publish Omnyo source` (2026-11-24). The private repository shows the work: `687ffc3c94`/`0f129e4525` "Polish Ladle story motion and states across the app" and `9a08ce3fb8` "Make the whole app visibly more polished and readable" (2026-11-22), followed by three later touch-ups (`e91d6841d1`, `7055e84a6c`, `cc523584f8`, all 2026-11-23). |
| Unchanged after the snapshot | Both files at `origin/main` (`18be024aa`) and in the working checkout `$OMNYO_CHECKOUT` are byte-identical to the snapshot (`cmp`), so no one has uncommitted edits to them. |

Counterevidence:
- Read mode and the after frames still work against the live checkout. The page is half-working, not fully broken.
- The before side can be restored by hand. Someone can create a worktree of `f93ae67314` from the retired private store and run `ladle serve --port 61422` in it. Even then, the screenshots stay missing and cross-origin speed control does nothing.
- The tool is four days old and was built for the owner's personal review. Its practical value right now is unknown (Hypothesis that the review is finished).

Maintenance cost today. Every app typecheck and lint parses the 10,122 lines. The story imports `@omnyo/shared-ui/motion` exports (`CONTROL_HOVER_TRANSITION`, `CONTROL_PRESS_FEEDBACK`, `CONTROL_PRESS_TRANSITION`), `@omnyo/shared-ui/icon` and `@omnyo/shared-ui/lib/utils`. Renaming any of those breaks a tool that is not shipped. Its 300 story-id strings are not type-checked, so they quietly go stale whenever a story export is renamed; three already have.

**Proposed end state and preservation argument**

What disappears: the directory `apps/app/src/polish-review/` and both files in it: the story `BeforeAndAfter` with its compare and read modes, the before-server probe `useBeforeServerStatus`, the screenshot glob `SHOT_URLS`, the playback-rate posting, and the manifest schema and data.

What remains: every product component and every other Ladle story. The Ladle config does not change, because its glob simply matches one file fewer. If Alex wants the record kept, one of these lightweight options holds it (Alex chooses in step 1):
- (a) Rely on Git alone. The files stay readable at `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` and at the deletion commit's parent. This needs no new artifact and is the recommended option.
- (b) Option (a) plus a short Markdown summary, for example under `docs/`, listing the areas and a few notable changes. Writing it is reader-facing prose, so follow `skills/marketing-copywriting/SKILL.md`.
- (c) Option (a) plus a lightweight Git tag on the parent commit. Pushing a tag is a remote write and needs the owner's authority.

Preservation argument: no supported feature, API, persisted format or product UI changes. The only affected surface is one dev-only Ladle page (`?story=polish-review--before-and-after`, which is Ladle's derived id; not confirmed by running Ladle). Reachability proof: the consumer search above returned nothing, the only importer of the manifest is the story, and the story is reached only through Ladle's glob. Remaining uncertainty: a bookmark or habit of the owner's, which only he can rule out.

Non-goals: do not change `apps/app/.ladle/config.mjs`, other stories, `.oxlintrc.json` or `@ladle/react`. Do not fix the three stale story ids, which disappear along with the files. Do not recreate the before worktree.

**Expected gain and cost**

- Removed: 1,203 handwritten lines of story logic and 8,919 lines of handwritten data. That is 10,122 dev-only lines and 0 production lines (measured with `wc -l`).
- Mechanisms removed: one Ladle story, one manifest schema, one before-server probe, one screenshot glob and one postMessage protocol with no receiver.
- Added: 0 lines with option (a). With option (b), roughly 20 to 60 lines of Markdown (projection).
- Performance: no change at runtime. App typecheck, app lint and Ladle startup each do slightly less work, because an 8.9k-line module no longer has to be parsed. The size of that saving was not measured, so this is a projection.
- Causal link: after deletion, a rename in `@omnyo/shared-ui/motion` or of a story export no longer touches a file that serves no current purpose.
- Tradeoff: the side-by-side review tool is gone. Restoring it means a `git revert`.

**Execution steps**

1. **Decision gate (do this first and stop if the answer is no).** Ask the owner: "Has the 2026-11-22 polish review finished, and should the record live only in Git history (a), in Git plus a short docs summary (b), or in Git plus a tag (c)?" If Alex still uses the page, stop and mark RF-047 as deferred.
2. **Reconfirm the baseline.** In the execution worktree, run `wc -l apps/app/src/polish-review/*` (expect 1,203 and 8,919, or explain any difference). Rerun the consumer search from Context against the current HEAD with `git grep`, covering the whole repository and excluding `apps/app/src/polish-review/**`. Any match outside that directory, for example a new doc link, a script, a test or a story that imports the manifest, invalidates this plan; handle that consumer first. Also check that `git status --porcelain apps/app/src/polish-review` is empty. If another agent has uncommitted edits there, stop and ask.
3. **Delete** `apps/app/src/polish-review/PolishReview.stories.tsx` and `apps/app/src/polish-review/polish-review-manifest.ts`, and the now-empty directory. Make no other source edits.
4. **Optional record.** If Alex chose (b), write the summary under `docs/` and derive its content from `POLISH_AREAS` and the pass 1 and pass 2 records at the parent commit. If Alex chose (c), only propose the tag command. Do not push the tag without the owner's authority.
5. **Superseded machinery.** None remains. The screenshots folder never existed, the Ladle glob is generic, and no lint or config entry names these files. Confirm this with the search from step 2.
6. **Verify and inspect the diff.** Run the commands below and confirm the diff contains exactly the two deletions, plus the optional doc.

**Verification and acceptance criteria**

Commands from `apps/app/package.json` and the root `package.json` at the snapshot. The script names were read from those files but not run, because the snapshot has no dependencies installed.

- `cd apps/app && pnpm typecheck` (runs `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`): passes with no new errors.
- `cd apps/app && pnpm lint` (runs `oxlint src …`): passes.
- `cd apps/app && pnpm storybook:build` (runs `ladle build`): finishes. The story list no longer contains "Polish review", and every other story is still present. Compare the story count with a build from before the deletion if one is available.
- From the repository root, `pnpm format:check` (runs `oxfmt . --check`) should be unaffected, because only deletions occurred.
- Structural check: `git grep -n -E "polish-review|PolishReview|POLISH_|polish-shots"` returns nothing, and `apps/app/src/polish-review` does not exist.
- No product behavior check is needed: nothing in the product imports these files. No new tests are warranted.

**Rollback and stop conditions**

- Rollback: `git revert <deletion commit>` restores both files exactly. No persisted data, migration or compatibility surface is involved.
- Stop if Alex says the review is still in use, or if step 2 finds a consumer outside the directory. Also stop if another agent has uncommitted changes under `apps/app/src/polish-review/`, which counts as foreign work.
- If typecheck or the Ladle build fails after deletion in a way that names these files, a hidden importer exists. Restore the files, find the importer and re-plan.
- Safer smaller alternative, if Alex wants to keep the page but drop the dead parts: remove `POLISH_BEFORE_SNAPSHOT`, `useBeforeServerStatus`, `SHOT_URLS`/`shotUrl` and `postPlaybackRate`, and keep read mode and the after frames. That removes far less and still leaves the 8,919-line manifest, so it is not recommended by default.
