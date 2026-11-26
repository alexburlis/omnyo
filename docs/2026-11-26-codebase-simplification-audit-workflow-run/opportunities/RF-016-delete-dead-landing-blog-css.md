# RF-016 — Delete the dead old-homepage and blog rules from `landing.css` and `blog.css`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The scope is larger than the sweep reported, and one safety rule (keyframes are global across stylesheets) must be part of the method.
- **Potential:** medium. About 2,560 lines of handwritten CSS go: about 2,364 from `landing.css` and 198 from `blog.css`, counting the blank separators and comments that belong to the deleted rules. About 75% of `landing.css` is dead.
- **Confidence:** high for the conservative pass described here.
- **Readiness:** ready.
- **Effort:** small, 2 to 3 hours including the regenerated scan and a visual pass.
- **Risk:** low. A rule whose required class appears nowhere in the repository cannot match. The residual risk is a class assembled at runtime from a prefix; the templated-prefix check below found none that can produce a flagged class.
- **Prerequisites:** none. The result does not depend on RF-011 or RF-028: the same scan with `apps/web/src/lab/**` excluded from the corpus gives the same survivors (779 lines), so lab pages keep no `landing.css` rule alive.
- **Related or overlapping:** RF-011 (lab variants) and RF-028 (homepage move) touch the same website but not these sheets. RF-092 (footer link sets) touches site chrome markup, not these rules. No overlap.
- **Why it ranks here:** this is dead machinery, not cosmetic tidying. The two global sheets still carry the styles of five removed surfaces (the old homepage install call to action and toast, the updates callout, the partner-logo marquee, the animated app mockup, the subscribe form) and of the removed blog. A maintainer cannot tell which three quarters of `landing.css` are live, and the browser downloads and parses all of it on every content page before first paint. The gain is moderate because the code is CSS, which has no callers to break.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the audit brief no longer existed, so all evidence was read from that commit with `git archive` and `git grep` against the commit.

How the sheets load (Proven by inspection):

- `apps/web/src/landing/page-head.ts:16` `siteHeadLinks()` always emits `{ rel: "stylesheet", href: landingCss }` (line 22) before any page-specific sheets. Every content route uses it: `apps/web/src/guides/guide-page.tsx:54` (with `blogCss`, `compareCss`, `guidesCss`), `apps/web/src/routes/plugin-guide.tsx:30`, the legal routes (`privacy.tsx:59`, `terms.tsx:21`, `cookies.tsx:42`, `imprint.tsx:20`, `abuse.tsx:21`, all with `blogCss`), the Explore routes (`explore.index.tsx:48`, `explore.skills.index.tsx:22`, `explore.plugins.$slug.tsx:33`, and others) and the Workflows routes (`workflows.index.tsx:28`, `workflows.$slug.tsx:43`).
- `apps/web/src/routes/__root.tsx:70` `NotFound` links `landingCss` and `blogCss` with `precedence="default"` (lines 73 and 74) and renders `.wrap`, `.post.article`, `.post-body`, `.lede` and `.release-link`.
- The homepage (`apps/web/src/routes/index.tsx:49`), feature pages (`apps/web/src/features/feature-head.ts` `featureHead`) and comparison pages (`apps/web/src/compare/comparison-head.ts` `comparisonHead`) do not link `landing.css`.
- The only other reader is `apps/web/src/lib/theme.test.ts:14`, which reads `landing.css` and asserts the `.dark {` block at line 159. That block survives.
- `git grep -n -E 'landing\.css|blog\.css|landing/landing|blog/blog' <commit>` found no consumer outside `apps/web/src`. The sheets are imported with `?url`, so their built names are content-hashed and no external site, plugin or older client can link them.

The scan (Reproduced). For each style rule, the scan splits the selector list at top-level commas. A selector's required classes are the `.class` tokens outside any parentheses or brackets, so classes inside `:not()`, `:is()`, `:where()`, `:has()` and attribute selectors are ignored, which keeps more rules alive. A rule is dead when every selector in its list requires at least one class that never appears as a whole token (`[A-Za-z_][A-Za-z0-9_-]*`) in any non-CSS text file of the whole repository at the commit, including tests, docs, JSON fixtures, `apps/web/public`, the SDK, plugins and lab pages. This corpus is deliberately broader than the website, so the dead set can only be too small, never too large. Results:

| Sheet | Lines (wc -l) | Dead rules | Dead rule lines | Dead `@keyframes` | Lines after pruning |
|---|---|---|---|---|---|
| `apps/web/src/landing/landing.css` | 3,143 | 311 | 1,806 | 21 | 779 |
| `apps/web/src/blog/blog.css` | 462 | 31 | 167 | 0 | 264 |
| `apps/web/src/explore/explore.css` (optional) | 632 | 4 | 20 | 0 | not simulated |
| `apps/web/src/guides/guides.css` (optional) | 1,573 | 3 | 18 | 0 | not simulated |

"Lines after pruning" comes from a simulated prune with postcss 8.5.26 into a scratch copy: the dead rules, the comments directly before them, `@media` blocks left empty, and `@keyframes` no longer named by any remaining `animation` or `animation-name` declaration were removed, then runs of blank lines were collapsed. A rule-by-rule comparison of the original and pruned `landing.css` showed 336 rules removed (311 dead rules plus 25 keyframe steps), 0 rules added or changed, comments 98 to 52, and 24 at-rules removed (21 keyframes and 3 emptied `@media` blocks). Re-running the scan on the pruned copy found 0 dead rules. The `theme.test.ts` regular expression still matched the pruned copy.

Dead families in `landing.css`, with the first rule of each (Proven by inspection): `.cta-row` 247, `.install-options` 261, `.cmd-toast` 347, `.updates-callout` 515, `.reveal-pending` 577, `.plogo` 616, `.mockup-wrap` 643, `.company-proof` 655, `.mock-bar` 927, `.trow` 1118, `.askq` 1394, `.composer-box` 1559, `.band-grid` 1866, `.tg-bar` 1936, `.customize-feed` 2301, `.plugin-task` 2449, `.sb-thread` 2595, `.subscribe-form` 2799. In `blog.css`: `.meta-row` 26, `.back-link` 35, `.post-index` 77, `.read-more` 100, `.article-head` 214, `.post-figure` 229, `.post-quote` 332, `.tweet` 352, `.source-note` 435. The scan's full list holds 210 unemitted class names for `landing.css` and 23 for `blog.css`.

Removal history (Proven by inspection): `apps/landing/scripts/chibistack-test.mjs:839` lists `/api/subscribe` and `/blog` as routes that must not be served, and `apps/web/src/server/sitemap.test.ts:33` asserts `/blog` is absent from the sitemap. The sweep cited private commit `31121b75d7` for the removal of the company-proof markup; that commit is not in this public repository and was not checked.

Counterevidence checked:

- **Templated class prefixes.** `rg -o '[A-Za-z0-9_-]*-\$\{'` over `apps/web/src`, `packages/shared-ui/src` and `plugins/plugin-api-docs/src` lists every prefix used in a template literal (`is-`, `get-btn--`, `wf-card-`, `source-`, `step-`, `cb-dot--` and others). Only three dead rules depend solely on classes that start with such a prefix: `.step-chev` (`landing.css:1355`), `.cb-expand` (`landing.css:1569`) and `.source-note` (`blog.css:435`). The matching templates are `step-${stepKey}` (a React `key` in `packages/shared-ui/src/components/ui/step-transition.tsx:77`), `source-${...}` (element ids in `apps/web/src/compare/comparison-page.tsx:53` and `:208`) and the `cb-*--${...}` modifiers, none of which can yield those classes. Every other dead rule also requires a fixed, unemitted class. No string concatenation of the form `"prefix-" +` exists in `apps/web/src`.
- **Third-party markup.** `apps/web/package.json` has no Markdown or syntax-highlighting library that would emit its own classes. None of the unemitted names looks library-generated.
- **Global keyframes.** `@keyframes` are global to the document, so another sheet could depend on a keyframe defined in `landing.css`. The one generic name, `spin` (`landing.css:1292`), is only used at `landing.css:1289`, `:1707` and `:2167`, all inside dead rules. A hyphen-aware search for `animation(-name)?:` naming `spin` in every CSS and TS/TSX file under `apps/web/src`, `packages/shared-ui/src` and `plugins/plugin-api-docs/src` found no other user. Spinners elsewhere use their own keyframes (`cmp-spin`, `gd-sched-spin`, `fv-inbox-spin`). The other 20 dead keyframes have names unique to `landing.css`. The kept keyframes are `fade-up`, `c-frame`, `c-left`, `c-up` and `plugin-panel-up`.
- **Partially dead selector lists.** Four lists in `landing.css` (lines 989, 3074, 3119, 3133) and two in `blog.css` (lines 76, 260) mix live and dead selectors. The prune keeps these rules whole. Trimming only the dead selectors is optional.

Maintenance cost today: any change to tokens, buttons or content-page layout needs a maintainer to work out whether a rule is live in a 3,143-line sheet where about three quarters of the rules style markup that no longer exists. The header comment of `blog.css` ("Omnyo blog") describes a page that no longer exists.

**Proposed end state and preservation argument**

- **What disappears:** the 311 dead rules and 21 dead keyframes in `landing.css`, the 31 dead rules in `blog.css`, the comments that only introduce them, and the `@media` wrappers they leave empty. Optionally also the 4 dead rules in `explore.css` (`.ex-skill-facts`, `.ex-skill-actions`, lines 599 to 621) and the 3 in `guides.css` (`.gd-open`, `.gd-quote`, `.gd-code pre .gd-dim`, lines 385 to 391, 772 to 774 and 1206 to 1213).
- **What remains:** in `landing.css`, the font imports, `:root` and `.dark` tokens, the `landing-reset` layer, base element rules, `.wrap`, `.omnyo-mark`, the `.btn` family, the shared display-heading rule, the `.hero`, `.closer`, `.sec-title` and `.statement` rules, the `.mock` layer that live selectors still reach, the five live keyframes and their `@media` overrides. In `blog.css`: `.page-head`, `.post`, `.article`, `.post-body`, `.lede` and the lightbox and legal rules, about 264 lines.
- **Owner and flow:** unchanged. `siteHeadLinks()` and `NotFound` keep linking the same two sheets. No TypeScript, route or test changes.
- **Why this is the simplest sufficient option:** deleting unreachable rules removes no rendering path. Splitting or renaming the sheets would add work for no extra gain.
- **Preservation argument:** a CSS rule changes rendering only when an element matches it. Each deleted rule requires a class that appears in no source file, so no element on any page can carry it. Deleted keyframes are named only by deleted rules. The cascade order of the remaining rules is unchanged, because the prune deletes and never reorders.
- **Remaining uncertainty:** class names that arrive from outside the repository at runtime, such as raw HTML in remote marketplace data, are not covered by the scan. No such path was found, and those names would have to equal names like `tg-bubble` or `askq-radio` to matter.
- **Header comments:** keep the `landing.css` header. It still describes the brand and app token layers, which both survive. Change the first line of `blog.css`, "Omnyo blog — loads alongside landing.css", so it describes what the sheet now serves: article, legal and 404 bodies.
- **Non-goals:** do not remove custom properties from `:root` or `.dark`. Some may now be unused, but `theme.test.ts` pins the `.dark` block and token pruning is a separate decision. Do not restyle or merge the surviving rules.
- **Optional second pass (not in the estimate):** after this pass, several surviving rules use generic class names (`.mock`, `.side`, `.threads`, `.feed`, `.composer`, `.model`, `.ctx`, `.dl`, `.diff-panel`, `.plugin-panel`, `.statement`, `.subscribe`, `.providers`). The whole-token scan cannot prove them dead because those words appear elsewhere in the repository. A check of class attributes in the website closure suggests some are dead; a string-literal corpus without lab pages prunes `landing.css` to 674 lines. That second pass needs a manual check of each class against real `className` values and is left out of the ready plan.

**Expected gain and cost**

- **Projected reduction (simulation, not a measured diff):** `landing.css` from 3,143 to about 779 lines (minus about 2,364) and `blog.css` from 462 to about 264 (minus 198). The total is about 2,560 lines of handwritten production CSS. The optional `explore.css` and `guides.css` deletions add about 38 rule lines plus separators. No tests, generated code or TypeScript change.
- **Mechanisms removed:** the styles of five removed homepage surfaces and of the removed blog: 210 plus 23 class vocabularies and 21 animations that nothing triggers.
- **Payload:** the source of `landing.css` shrinks from 62,250 to about 20,383 bytes (gzip about 14,951 to 6,070), and `blog.css` from 7,884 to about 4,900 bytes (gzip 1,972 to 1,458). These are source-file numbers. The built size also includes the inlined font-face CSS and was not measured. Both sheets block rendering on every content page and the 404 page, so the change should reduce parse work there. The effect on paint time is unmeasured.
- **Cost:** a single deletion-only diff, plus a short visual check.
- **Maintenance link:** after the change, every remaining rule in the two sheets matches markup that ships, so editing a token or a button no longer means auditing a few thousand lines of leftovers.

**Execution steps**

1. **Reconfirm the baseline.** Work in your own linked worktree of `$OMNYO_CHECKOUT` with dependencies installed. Record `git rev-parse HEAD`, `wc -l` for the four sheets, and `git log --oneline -3 -- apps/web/src/landing/landing.css apps/web/src/blog/blog.css`. If either sheet changed after `e9e1b74c3`, rerun the scan; the line numbers in this card are only a guide. Stop and re-plan if a new route, component or plugin now emits any of the flagged class names, or if any other stylesheet now names one of the deleted keyframes.
2. **Write the scan script** to your scratch directory, `~/scratch/omnyo/<owner-id>--rf016/scan.cjs`, not into the repository. Resolve postcss from the pnpm store (`node_modules/.pnpm/postcss@*/node_modules/postcss`). Build the token corpus from the commit under test with `git grep -I -o -h -E '[A-Za-z_][A-Za-z0-9_-]*' HEAD -- ':!*.css' ':!pnpm-lock.yaml'`, strip the leading `HEAD:` from each line and keep the unique values. Implement exactly these rules:
   - Skip rules inside `@keyframes`.
   - Split `rule.selector` at commas outside `()` and `[]`.
   - A selector's required classes are the `.name` tokens left after blanking everything inside `()` and `[]`.
   - A rule is dead when no selector in its list has all of its required classes present in the corpus.
   - After removing the dead rules, a keyframe is dead when no remaining declaration matches `animation(-name)?:[^;]*(^|[\s:,])NAME([\s;,]|$)` in this sheet. Then run the same hyphen-aware search over every other `*.css` and `*.ts*` file in `apps/web/src`, `packages/shared-ui/src` and `plugins/plugin-api-docs/src`, and keep any keyframe found there.
   Print the line ranges of dead rules and the unemitted class names. Checkpoint: the counts should be close to this card's (311 rules and 21 keyframes in `landing.css`, 31 rules in `blog.css`). A large difference means the sheets or the markup changed; review it before deleting.
3. **Re-check templated prefixes.** Run `rg -o --no-filename '[A-Za-z0-9_-]*-\$\{' apps/web/src packages/shared-ui/src plugins/plugin-api-docs/src | sort -u`. For every dead rule whose unemitted classes all start with one of those prefixes (at the snapshot only `.step-chev`, `.cb-expand` and `.source-note`), read the template's possible values and keep the rule if any value could produce the class.
4. **Delete from `apps/web/src/landing/landing.css`.** Remove each dead rule, the comment block directly above it when that comment only introduces dead rules, each `@media` block left without rules, and each dead `@keyframes`. Do not reorder or edit any surviving rule. Leave the four partially dead selector lists (around lines 989, 3074, 3119 and 3133) whole, or trim only their dead selectors. Keep `@keyframes fade-up`, `c-frame`, `c-left`, `c-up` and `plugin-panel-up`. A postcss script that removes nodes and writes `root.toString()` keeps the surviving text byte-for-byte; hand deletion is fine too.
5. **Delete from `apps/web/src/blog/blog.css`** in the same way: the tweet embed, post index, read-more, post-figure, post-quote, meta-row, article-head, back-link and source-note rules. Update the header comment at line 1 so it describes the article, legal and 404 bodies the sheet now serves.
6. **Optional:** delete `.ex-skill-facts` and `.ex-skill-actions` in `apps/web/src/explore/explore.css`, and `.gd-open`, `.gd-quote` and `.gd-code pre .gd-dim` in `apps/web/src/guides/guides.css`, after rerunning the scan on those files.
7. **Re-scan to zero.** Run the scan on the edited sheets. It must report 0 dead rules and 0 dead keyframes. Diff the rule set of the original and the edited sheet (selector plus declarations, keyed by enclosing at-rules). The diff must show only removals.
8. **Format and inspect.** Run the repository formatter on the touched CSS (see Verification). Review `git diff --stat` and the full diff: only deletions, plus the `blog.css` header line. Recount with `wc -l` against the step 1 baseline.

**Verification and acceptance criteria**

All commands run from the worktree root unless stated. The scripts named here come from the root `package.json` (`format`, `format:check`, `lint`) and `apps/web/package.json` (`test`, `build`, `dev`, `typecheck`) at the snapshot. Nothing was executed against the snapshot itself, because it has no `node_modules`.

- **Structural:** the step 7 re-scan reports 0 dead rules and 0 dead keyframes in each edited sheet, and the rule-set diff shows only removals. `rg -n 'cmd-toast|company-proof|mock-bar|askq|tg-bubble|subscribe-form|tweet-|post-index|read-more' apps/web/src --glob '*.css'` returns nothing.
- **Tests:** `pnpm --filter @omnyo/web test`. It runs `vitest run --config vitest.config.ts` and includes `src/lib/theme.test.ts`, which must still find the `.dark` block. Expect it to pass with no snapshot updates.
- **Build:** `pnpm --filter @omnyo/web build` succeeds. If you want a payload number, compare the hashed `landing-*.css` and `blog-*.css` asset sizes in the build output before and after. The output directory depends on TanStack Start's build layout and was not confirmed.
- **Format:** `pnpm exec oxfmt apps/web/src/landing/landing.css apps/web/src/blog/blog.css`, then `pnpm exec oxfmt --check` on the same paths. Whether this oxfmt version formats CSS was not confirmed. If it skips CSS, leave the layout as the deletion left it. A CSS-only change needs no TypeScript lint or typecheck.
- **Visual (targeted):** run `pnpm --filter @omnyo/web dev` from the worktree root. In light and dark mode, compare these pages before and after: a `/guides/<slug>` page with a closer section, `/workflows`, a `/workflows/<slug>` page, `/plugin-guide`, `/privacy`, `/explore`, an `/explore/skills/<slug>` page and an unknown path such as `/nope` for the 404 page. Expect no visible difference. Check hover and focus on `.btn` links and the 404 `.release-link`. Under the global rules, Alex does his own UI checks, so the executor's job is the build and the structural proof. This list tells him which pages to look at.
- **Performance:** not required, because the change only deletes non-matching rules. If a number is wanted, compare the built CSS sizes as above. Do not claim a paint-time change without a measurement.

**Rollback and stop conditions**

- **Rollback:** one commit that touches only CSS. `git revert <commit>` restores it. No persisted data, API or compatibility surface is involved.
- **Stop if:**
  - the scan flags a class that a current component, plugin page, Markdown content or fixture emits, which means the corpus or the parser is wrong. Fix the scan before deleting anything.
  - any CSS or TS file outside `landing.css` names a keyframe you are about to delete.
  - `theme.test.ts` or any other web test fails.
  - a visual comparison shows a difference on a listed page. Restore the rules around the affected element and find which class matched.
  - another agent has uncommitted edits in `landing.css` or `blog.css`. Do not overwrite them; wait, or apply the deletions around their work.
- **Safer smaller alternative:** delete only the families whose names are unique to the old homepage (`company-proof-*`, `cmd-*`, `install-*`, `tg-*`, `askq*`, `sb-*`, `customize-*`, `subscribe-*`, `tweet-*`) and leave the rest for a second pass.
