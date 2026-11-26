# RF-092 — Define the website footers' shared link data, credit and copyright line once instead of in three footer components

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and has already drifted twice, but the sweep overstated the line saving and one part of its plan does not hold. Deriving `TOPIC_GUIDES` and `SWITCH_GUIDES` from the guide meta files is refuted: the metas do not carry those labels or that membership. The realistic net saving is about 10 to 25 handwritten production lines, not 40 to 70. The value is duplicated knowledge that disappears, not line count.
- **Potential:** low. Five pieces of footer knowledge stop being restated: the legal link list, the Guides column composition, the "Switch to Omnyo" column composition, the bb credit and the copyright-year rule. The tagline also gets one owner.
- **Confidence:** high for the duplication and the drift, which are proven by inspection. Medium for the line estimate, which is a projection. No test was run because the snapshot has no `node_modules`.
- **Readiness:** ready for checkpoints 1 to 3, which keep the rendered HTML identical in 2026. Checkpoint 4 (moving the content-page footer onto the shared legal list) changes the visible link order on content pages, so it needs the owner's choice of one legal-link order before it runs.
- **Effort:** small, about two to three hours including the focused tests and a before/after HTML comparison.
- **Risk:** low. The change is presentational data on a public marketing website. The realistic regressions are a reordered, relabelled or missing footer link, a lost `data-cookie-settings` button (which opens the consent dialog), or a larger content-page bundle if the wrong module is imported.
- **Prerequisites:** none.
- **Related and overlapping:** RF-028 ("Move the live homepage out of src/lab and drop the Open 5 and Combined A standalone previews it bundles") moves the homepage `Footer` in `apps/web/src/lab/open-5/page.tsx`. If RF-028 lands first, locate the homepage footer by the symbol `Footer` inside the file that exports `KineticShell`; the plan is otherwise unchanged. The two changes can land in either order. RF-011 ("Retire the unselected landing-lab variants") removes many more private copies of `SWITCH_GUIDES` in unselected lab pages (`apps/web/src/lab/eclipse-*`, `o-*`, `open-1` to `open-4`, `combined-b`). Those copies are out of scope here and should simply be deleted by RF-011. RF-016 (dead homepage and blog CSS) touches nearby website styling but not these components.
- **Why it deserves its place:** it is a small, safe change, and the copies have already diverged. Two footers hard-code `© 2026 Omnyo` while the third computes the year, and the content-page footer lists Privacy before Terms while the other two list Terms first. Each future change to the legal pages, the guide lists or the credit currently needs two or three matching edits.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). Files were read with `git show e9e1b74c3:<path>` because the snapshot worktree had already been retired. The four footer source files show no committed change between the snapshot and local `main` except a 4-line removal in `apps/web/src/lab/open-5/page.tsx` outside the footer. Local `main` also had another agent's uncommitted change in `apps/web/src/landing/site-chrome.tsx`, inside `SiteNav` (the scroll-hide logic around line 395), not in `SiteFooter`. Rebase onto it and do not touch it.

*Subsystem.* `apps/web` is the public Omnyo website, a TanStack Start app rendered on the server at request time (`apps/web/vite.config.ts` uses `tanstackStart`, and `apps/web/package.json` "start" runs `node server.mjs`; no prerender step was found). It has three page families, and each has its own footer component:

| Footer | Used by | Location |
|---|---|---|
| `SiteFooter` | content pages: guides, explore, marketplace, workflows, legal, plugin guide, root layout | `apps/web/src/landing/site-chrome.tsx:464-535` |
| `FeatureFooter` (private, rendered by `FeatureShell`) | feature pages, the feature index and comparison pages | `apps/web/src/features/feature-chrome.tsx:47-112` |
| `Footer` (private, rendered by `KineticShell`) | the live homepage: `apps/web/src/routes/index.tsx:6` imports `../lab/combined-a-v2/page`, whose default export wraps `KineticShell` from `../open-5/page` (`combined-a-v2/page.tsx:18`, `:296`) | `apps/web/src/lab/open-5/page.tsx:684-755` |

*Duplicated knowledge* (Proven by inspection):

1. **Legal links.** `SiteFooter` passes `[{"/privacy","Privacy"}, {TERMS_URL,"Terms"}, {"/imprint","Imprint"}, {"/cookies","Cookies"}]` to `FooterLinks` (`site-chrome.tsx:507-512`), followed by a `Cookie settings` button with `className="site-footer-button"` and `data-cookie-settings` (`:516-523`). `FeatureFooter` hand-writes `/terms`, `/privacy`, `/imprint`, `/cookies` as anchors (`feature-chrome.tsx:89-92`) and a button with `className="fx-foot-button"` (`:93-99`). The homepage `Footer` does the same (`open-5/page.tsx:734-737`) with an unclassed button (`:738-740`). `TERMS_URL` is `"/terms"` (`apps/web/src/landing/site.ts:17`). **Drift observed:** `SiteFooter` lists Privacy first; the other two list Terms first.
2. **Guides column.** `FeatureFooter` (`feature-chrome.tsx:66-78`) and `Footer` (`open-5/page.tsx:711-723`) both render `comparisonMetas()` as `comparisonPath(slug)` links labelled `name`, then `TOPIC_GUIDES` as `/guides/${slug}` links labelled `label`. The 13 lines match exactly except the heading class (`fx-foot-head` versus `foot-head`). `SiteFooter`'s Guides column is deliberately different: it uses `guideFooterLinks()` from the guide metas' `nav` field (`site-chrome.tsx:503-505`, `apps/web/src/landing/content-links.ts:46-51`).
3. **"Switch to Omnyo" column.** `feature-chrome.tsx:79-86` and `open-5/page.tsx:724-731` both map `SWITCH_GUIDES` to `/guides/${slug}` links labelled `From ${label}`. They are identical except the heading class.
4. **Credit.** `Built on <a href={BB_URL}>bb</a> (MIT License)` appears at `site-chrome.tsx:528-530`, `feature-chrome.tsx:104-106` and `open-5/page.tsx:748-750`.
5. **Copyright line.** `site-chrome.tsx:531` renders `© {new Date().getFullYear()} Omnyo`. `feature-chrome.tsx:108` and `open-5/page.tsx:751` hard-code `© 2026 Omnyo`. **Drift observed:** from 1 January 2027 the feature, comparison and home pages will show 2026 while content pages show 2027 (incidental issue ISS-S19-01).
6. **Tagline.** `"The unified interface for coding agents."` appears at `site-chrome.tsx:482-483`, `feature-chrome.tsx:53` and `open-5/page.tsx:692`.

Search used: `git grep -n "data-cookie-settings\|MIT License\|© \|getFullYear\|The unified interface for coding agents" e9e1b74c3 -- apps/web/src`, with the unselected lab variants excluded. Outside the three footers, hits are only the consent controller (`apps/web/src/analytics/SiteConsent.tsx:27` selects `[data-cookie-settings]`), legal-page buttons (`apps/web/src/legal/legal-page.tsx:64-73` "CookieSettingsButton", `:101-111` "CookieSettingsLink"), the OG image alt text in `site.ts:43`, and tests. The consent banner's own Privacy/Cookies links (`SiteConsent.tsx:209-210`) are a different, two-link surface and stay out of scope.

*Guide-list ownership, where the sweep was wrong* (Proven by inspection): `apps/web/src/landing/site-links.ts:1-21` holds `SWITCH_GUIDES` (7 entries) and `TOPIC_GUIDES` (6 entries). The sweep proposed deriving them from `apps/web/src/guides/pages/*.meta.ts`. That cannot preserve output:
- `GuideMeta` (`apps/web/src/guides/guide-types.ts:18-23`) has only `slug`, `title`, `nav` and `canonical`.
- All seven `switch-from-*.meta.ts` files and `claude-code-and-codex-together.meta.ts` have `nav: null`, but the latter is in `TOPIC_GUIDES`.
- `agent-browser-for-work.meta.ts` has a `nav` entry but is not in `TOPIC_GUIDES`.
- The labels differ. `TOPIC_GUIDES` says "Orchestrate coding agents" while the meta `nav.label` says "Orchestrate agents". `SWITCH_GUIDES` says "Claude Code" while the meta `title` says "Switch from Claude Code to Omnyo".

Deriving the lists would mean adding new meta fields, which moves data rather than removing it. `site-links.ts` therefore stays the single owner of those two lists. It already is the only definition for the live pages: `apps/web/src/lab/open-5/content.ts:3` re-exports it. The existing guard `apps/web/src/features/features.test.ts:90-94` ("links only guides that exist from the shared footer lists") already catches a slug that drifts from the guide pages.

*Consumers.* `site-links.ts` is imported only by `feature-chrome.tsx:10`, `open-5/content.ts:3` and `features.test.ts:8`. Through `open-5/content.ts` it also reaches `open-5/page.tsx:28-30` (including the CTA sentence at `:654-667`, which uses `SWITCH_GUIDES` labels without "From" and must stay unchanged) and `apps/web/src/lab/combined-a/page.tsx:16`. `site-chrome.tsx` is imported by both other footers (`feature-chrome.tsx:12-17`, `open-5/page.tsx:23`), so it can host shared JSX without adding an import edge. There are no SDK, plugin, CLI, persisted-data or route-string consumers: these are private React components and constants inside `apps/web`.

*Bundle constraint* (Proven by inspection): `apps/web/src/compare/comparisons.ts:3-6` eagerly globs every comparison meta. `SiteFooter` pages do not import it today. The shared Guides-column builder must therefore live in `site-links.ts`, which only feature and home pages import, and not in `site-chrome.tsx`.

*Tests today.* `apps/web/src/landing/site-chrome.test.tsx:98-125` ("site footer") asserts `SiteFooter`'s credit, `© \d{4} Omnyo`, the legal hrefs, `aria-current` on the current legal page, the exact button markup `<button type="button" class="site-footer-button" data-cookie-settings="true">Cookie settings</button>`, and the column titles. Searching the web tests for `fx-foot`, `foot-cols`, `Switch to Omnyo` and `2026 Omnyo` found nothing, so neither `FeatureFooter` nor the homepage `Footer` has footer-content coverage. `apps/web/src/legal/cookies-route.test.tsx:81` and `apps/web/src/privacy-route.test.tsx:65` check that `data-cookie-settings` is rendered.

*Line counts* (command: `git show e9e1b74c3:<file> | wc -l`): `site-chrome.tsx` has 537 lines, `feature-chrome.tsx` 128, `open-5/page.tsx` 835 and `site-links.ts` 21. The duplicated footer blocks in scope come to roughly 21 + 21 lines of Guides and Switch columns, 21 + 14 + 10 lines of legal columns, 3 × 3 credit lines, 3 copyright lines and 3 tagline lines.

**Proposed end state and preservation argument**

What remains: three footer components, each with its own layout, classes and extra columns (Product, Features, the giant `omnyo` wordmark, the `Releases` link and the `GetButton`). Their designs are separate on purpose and stay separate. Non-goal: merging the three footers, or changing any class, heading, column order or styling.

Canonical owners after the change:

- `apps/web/src/landing/site-links.ts` (already the owner of the guide lists) adds two builders over its own lists and the comparison metas:
  ```ts
  export function footerGuideLinks(): ContentLink[]   // comparisonMetas() as {href: comparisonPath(slug), label: name}, then TOPIC_GUIDES as {href: `/guides/${slug}`, label}
  export function footerSwitchLinks(): ContentLink[]  // SWITCH_GUIDES as {href: `/guides/${slug}`, label: `From ${label}`}
  ```
  `ContentLink` is the existing `{label, href}` type in `apps/web/src/landing/content-links.ts:3-6`.
- `apps/web/src/landing/site-chrome.tsx` (already imported by every footer) adds:
  ```ts
  export const FOOTER_TAGLINE = "The unified interface for coding agents.";
  export const LEGAL_LINKS: readonly ContentLink[] = [
    { href: TERMS_URL, label: "Terms" },
    { href: "/privacy", label: "Privacy" },
    { href: "/imprint", label: "Imprint" },
    { href: "/cookies", label: "Cookies" },
  ];
  export function FooterCredit()     // <span>Built on <a href={BB_URL}>bb</a> (MIT License)</span>
  export function FooterCopyright()  // <span>© {new Date().getFullYear()} Omnyo</span>
  ```
  `LEGAL_LINKS` uses the Terms-first order that two of the three footers already show.
- Optionally (checkpoint 3), a small exported `LinkColumn({ title, headClassName, links, children })` in `feature-chrome.tsx`. It renders `<div><p className={headClassName}>{title}</p>{links as <a>}{children}</div>`, which is the exact column markup that `FeatureFooter` and the homepage `Footer` share. The homepage imports it, or it moves to `site-chrome.tsx` if importing from `features/` into the homepage is unwanted. This is what turns the data sharing into a real line saving. Skip it if the reviewer prefers the explicit markup.

Preservation argument:
- **Same HTML in 2026.** Each footer keeps its own wrappers and classes and maps the shared data into the same `<a href>` elements, in the same order, with the same text. React keys may change from `slug` to `href`, which does not affect the DOM. Through 31 December 2026 the rendered footer HTML of `FeatureShell` and the homepage is byte-identical. After that, the year becomes current, which is the intended bug fix.
- **Cookie settings.** Every footer keeps its own button element with its own class and `data-cookie-settings`, because `SiteConsent.tsx:27` finds the button by that attribute. The button is not moved into shared data.
- **`aria-current`.** `SiteFooter` keeps passing its links through `FooterLinks`, which sets `aria-current="page"` on the current page. The other footers have no `current` prop and stay that way.
- **Homepage CTA sentence.** `CtaScene` (`open-5/page.tsx:654-667`) keeps reading raw `SWITCH_GUIDES` labels, because it shows "Claude Code" without the "From" prefix.
- **Bundles.** `site-chrome.tsx` gains no new imports beyond `TERMS_URL` and `BB_URL`, which it already imports (`site-chrome.tsx:20`). `site-links.ts` gains `../compare/comparisons`, which both of its live importers already load. Content pages therefore do not pick up the comparison metas.
- **Retained known behavior.** `new Date().getFullYear()` runs during the server render and again during client hydration. Within minutes of New Year, or across a server/client time-zone difference on 31 December or 1 January, React can report a text hydration mismatch and patch the text on the client. `SiteFooter` already behaves this way. The change extends that existing, harmless behavior to the other two footers and does not add a new mechanism.

Checkpoint 4 (decision-gated): `SiteFooter` switches to `LEGAL_LINKS`. Its visible legal order would change from Privacy, Terms to Terms, Privacy. Alternatively, Alex picks Privacy first and the other two footers change instead. Both outcomes are visible UI changes and need his choice. Without that decision, `SiteFooter` keeps its own inline list and a comment pointing at `LEGAL_LINKS`.

**Expected gain and cost**

Observed today: 3 legal-link lists, 3 credits, 3 copyright rules (two hard-coded), 3 taglines, 2 identical Guides-column compositions and 2 identical Switch-column compositions.

Projected after checkpoints 1 to 3: 1 legal list (used by 2 footers, or by 3 after checkpoint 4), 1 credit, 1 copyright rule, 1 tagline constant, 1 Guides-column builder and 1 Switch-column builder.

Projected handwritten production lines (estimate, formatted with oxfmt):
- Removed: about 42 lines of Guides and Switch columns in two footers become about 12 lines of `LinkColumn` calls. Legal columns lose about 8 lines. The credits lose about 6 lines. Checkpoint 4 would save about 6 more in `SiteFooter`.
- Added: about 14 lines of builders in `site-links.ts`, about 18 lines for `LEGAL_LINKS`, `FOOTER_TAGLINE`, `FooterCredit` and `FooterCopyright`, and about 12 lines for `LinkColumn`.
- Net: about 10 to 25 fewer production lines with `LinkColumn`, and about zero without it. Data-only sharing mainly centralizes knowledge.

Tests: one new characterization assertion block for `FeatureShell`'s footer, about 15 to 25 test lines (see verification). No generated code, assets or persisted data change.

Maintenance effect: adding a legal page (for example an abuse page), renaming a topic guide, adding a "switch from" guide, changing the bb credit or the tagline becomes one edit instead of two or three. The year can no longer go stale. Performance is neutral by construction (same elements, one extra function call per render); it was not measured.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree off current `main`, check that the anchors above still hold: `rg -n "function FeatureFooter|function Footer\(|export function SiteFooter|© 2026|data-cookie-settings" apps/web/src/features/feature-chrome.tsx apps/web/src/lab apps/web/src/landing/site-chrome.tsx`. Re-plan if any of these is true:
   - RF-028 has moved the homepage footer. Follow the `KineticShell` export instead.
   - The footers already share data.
   - `TOPIC_GUIDES` or `SWITCH_GUIDES` have moved into guide metas.
   - A fourth live footer exists.

   Do not edit `SiteNav`, which may hold another agent's uncommitted change.
2. **Capture baseline HTML** (scratch only, not committed). Under `~/scratch/omnyo/<owner-id>--rf092/`, render and save the footer HTML before any edit:
   - `renderToStaticMarkup(<FeatureShell><p /></FeatureShell>)`, keeping the `<footer class="fx-foot">…</footer>` slice.
   - `renderToStaticMarkup(<SiteFooter current="/privacy" />)`.
   - The homepage footer, rendered through `KineticShell` (exported at `open-5/page.tsx:768`), keeping the `<footer class="foot"…>` slice.

   A throwaway vitest file run with `pnpm --filter @omnyo/web exec vitest run --config vitest.config.ts <file>` is the simplest harness. Unverified: whether `KineticShell` renders under `renderToStaticMarkup` without a DOM. It calls `useSyncExternalStore` for reduced motion at `:787`. If it does not render, compare the homepage footer by reading the code diff and checking the live page in a browser.
3. **Checkpoint 1: column data in `site-links.ts`.** Add `footerGuideLinks()` and `footerSwitchLinks()` as specified above. Import `comparisonMetas` and `comparisonPath` from `../compare/comparisons` and `type ContentLink` from `./content-links`. Keep `SWITCH_GUIDES` and `TOPIC_GUIDES` exported unchanged, because `CtaScene`, `combined-a/page.tsx` and `features.test.ts` read them. In `feature-chrome.tsx` "FeatureFooter", replace the bodies of the Guides and Switch columns with `footerGuideLinks().map((link) => <a href={link.href} key={link.href}>{link.label}</a>)` and the matching Switch call. Remove the now-unused imports of `comparisonMetas`, `comparisonPath`, `SWITCH_GUIDES` and `TOPIC_GUIDES`. Do the same in `open-5/page.tsx` "Footer". `comparisonMetas` stays imported there only if something else still uses it; check with `rg -n comparisonMetas apps/web/src/lab/open-5/page.tsx`. Re-run the step 2 capture and diff it. Expect no difference.
4. **Checkpoint 2: credit, copyright, tagline and legal list in `site-chrome.tsx`.** Add `FOOTER_TAGLINE`, `LEGAL_LINKS`, `FooterCredit` and `FooterCopyright`. In `SiteFooter`, use `FOOTER_TAGLINE`, `<FooterCredit />` and `<FooterCopyright />`, and leave its inline legal list alone (checkpoint 4 owns it). In `FeatureFooter` and the homepage `Footer`, use the same three, and render the legal anchors from `LEGAL_LINKS`, keeping each footer's own `<button type="button" data-cookie-settings …>Cookie settings</button>` with its existing class or lack of one. Drop the `BB_URL` imports that become unused (`feature-chrome.tsx:11` keeps `GITHUB_URL`; `open-5/page.tsx:20` loses its only named import). Diff again. Expect no difference in 2026.
5. **Checkpoint 3 (optional): `LinkColumn`.** Add `LinkColumn` and use it for the Guides, Switch and Legal columns in `FeatureFooter` and the homepage `Footer`. Pass the Cookie settings button as `children` of the Legal column. Leave the homepage Features column inline, because it appends conditional links. Diff again. Expect no difference.
6. **Checkpoint 4 (needs the owner's decision): `SiteFooter` legal order.** Only after Alex chooses one order, either pass `LEGAL_LINKS` to `FooterLinks` in `SiteFooter` or reorder `LEGAL_LINKS` and accept the change on the other two footers. Expect a one-line order difference in the captured HTML, and nothing else.
7. **Tests.** Add a "feature footer" characterization block to an existing feature test file, for example `apps/web/src/features/features.test.ts`. It should render `FeatureShell` and assert the following:
   - Every `footerGuideLinks()` and `footerSwitchLinks()` href appears in order.
   - The four legal hrefs appear.
   - The text `Built on` and `(MIT License)` appears.
   - `© ${new Date().getFullYear()} Omnyo` appears.
   - `data-cookie-settings` appears.

   This gives the two untested footers coverage and pins the year fix. Keep the `site-chrome.test.tsx` "site footer" assertions unchanged. If checkpoint 4 runs, no assertion there depends on the legal order.
8. **Close out.** Format and lint the touched files, run the focused tests (next section), and inspect `git diff` for leftovers. No `© 2026` should remain in live footers, the duplicated column blocks should be gone, and no unrelated file should be touched. Recount with `wc -l` on the four files against the baseline numbers above. Delete the scratch capture directory.

**Verification and acceptance criteria**

Commands, run from the repository root (the worktree used for the change) unless stated otherwise. The scripts were confirmed in `package.json` files at the snapshot; the commands themselves were not executed.
- `pnpm --filter @omnyo/web test` runs `vitest run --config vitest.config.ts` (`apps/web/package.json` "test"). Expected to pass, including `src/landing/site-chrome.test.tsx`, `src/features/features.test.ts` (with the new block), `src/legal/cookies-route.test.tsx` and `src/privacy-route.test.tsx`.
- `pnpm --filter @omnyo/web typecheck` runs `tsc --noEmit`. Expected to pass.
- `pnpm exec oxlint --fix <touched files>`, then `pnpm exec oxfmt <touched files>`, then `pnpm exec oxlint --deny-warnings --format=agent` (root `.oxlintrc.json`). `apps/web/package.json` has no `lint` script, so root `pnpm lint` (turbo) may not cover `apps/web`; use the direct oxlint call.
- `pnpm --filter @omnyo/web build` ("build": `vite build`) checks that the website still bundles. Optionally compare the size of the content-page chunk containing `SiteFooter` before and after. It must not grow by the comparison metas.

Acceptance:
- **Behavior.** The before/after footer HTML captured in step 2 is identical for `FeatureShell` and `SiteFooter` after checkpoints 1 to 3, and for the homepage footer if it rendered. After checkpoint 4, the only difference is the approved legal order.
- **Interaction.** On a local `pnpm --filter @omnyo/web dev` server, open `/features`, a `/compare/<slug>` page, `/` and `/privacy`. Click "Cookie settings" in each footer and confirm the consent dialog opens. Alex does the visual check of UI changes himself; give him those four URLs.
- **Structure.** `rg -n "© 2026" apps/web/src/features apps/web/src/landing apps/web/src/lab/open-5` returns nothing. `rg -n "TOPIC_GUIDES.map|SWITCH_GUIDES.map" apps/web/src/features apps/web/src/lab/open-5/page.tsx` returns only the `CtaScene` sentence. `rg -n "MIT License" apps/web/src --glob '!**/lab/{eclipse,o-,open-1,open-2,open-3,open-4,combined-b}*'` returns `FooterCredit`, `routes/terms.tsx` and tests only.
- **Performance.** No measurement is required: the change renders the same elements, and the bundle check above covers the one plausible regression.

**Rollback and stop conditions**

Each checkpoint is a separate local commit touching only `site-links.ts`, `site-chrome.tsx` (footer section), `feature-chrome.tsx`, the homepage footer file and one test file, so any checkpoint can be reverted on its own. Nothing is persisted, and no API or route changes, so rollback has no data or compatibility implications.

Stop and re-plan if:
- The captured footer HTML differs in any way other than the approved year or order change.
- The content-page bundle grows because `site-chrome.tsx` ended up importing `comparisons`.
- `KineticShell` or the homepage footer has been redesigned since the snapshot so that its columns no longer match `FeatureFooter`. In that case share only the data from checkpoints 1 and 2.
- Alex declines a single legal order. Then skip checkpoint 4 and keep `SiteFooter`'s own list.

The smaller safe alternative is checkpoint 2 alone (shared credit and copyright line), which fixes ISS-S19-01 with about four touched lines per footer.
