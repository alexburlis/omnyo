# RF-028 — Delete the standalone Open 5 and Combined A homepage previews that the live homepage drags along, then move the live homepage modules out of `src/lab`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the live homepage at `/` is built from modules under `apps/web/src/lab`, and one of them (`lab/open-5/page.tsx`) also contains a whole standalone preview page. That page ships in the module that homepage visitors download, and its styles ship in the homepage stylesheet. Three parts of the sweep were corrected:
  - The gain comes from the deletions, not from the move. Moved code is not deleted complexity, so the directory move is an optional last checkpoint.
  - The scope is larger than the sweep said. This card also owns `combined-a/page.tsx`, `combined-a/content.ts` and `app-mock/glide.ts`, as agreed with RF-011, and `open-5/content.ts` can go completely.
  - The dead part of `combined-a/styles.css` is 85 rule lines, not 39.
- **Potential:** medium. About 2,000 to 2,350 handwritten production lines go: TSX, TS and CSS that no supported production page can render. Homepage visitors also stop downloading those lines.
- **Confidence:** high for reachability and the CSS scan (Proven by inspection, plus a Reproduced scan script). Medium for the bundle-size effect, which is a Hypothesis until a before-and-after `vite build` measures it.
- **Readiness:** decision-needed. Alex owns the design lab. He must confirm that the standalone `open-5` ("Open 5 · Kinetic scroll story") and `combined-a` ("Combined A · Kinetic workspace") lab previews may be retired. Ask this together with RF-011's keep-list question. The optional move (checkpoint E) also needs his preference on the target folder. It is a reversible layout choice.
- **Effort:** small to medium. The deletions (checkpoints A to D) take about half a day including the build comparison. The optional move (checkpoint E) takes about another half day plus a visual pass of `/`.
- **Risk:** low to medium. The deleted CSS rules are all scoped under `.lab-open-5`, and the scan found no live markup they can match. The main regression modes are these: a class that is built at runtime from a prefix the scan missed, a change in stylesheet order during the move, and a scroll-story regression if `story.ts` is edited beyond what this card allows.
- **Prerequisites:** the owner's decision above. No code prerequisite.
- **Related and overlapping:**
  - **RF-011** (retire the 13 unselected lab variants) edits the same `lab/designs.ts` and `routes/lab.index.tsx`. Land the two sequentially. RF-011 explicitly leaves `combined-a/page.tsx`, `combined-a/content.ts` and `app-mock/glide.ts` to this card. `glide.ts` dies only when both `combined-a/page.tsx` (this card) and `eclipse-4/page.tsx` (RF-011) are gone, so whichever card lands second deletes it, and it is counted here once. Whichever card lands second also removes the then-empty `"open"` lab group.
  - **RF-092** (define the website footer link sets once) will touch `Footer` in `lab/open-5/page.tsx:684-755`. This card keeps `Footer` unchanged. If RF-092 lands first, carry its version along during the move.
  - **RF-016** (dead `landing.css` and `blog.css` rules) uses the same scan method on different sheets. There is no overlap in counted lines.
- **Why it deserves its place:** this is dead machinery inside live code. The only homepage engine file, `lab/open-5/page.tsx`, holds 510 lines of a preview page that no production page renders, and 922 lines of `lab/open-5/styles.css` style only that preview and the Combined A preview. Homepage work landed four times in two days in these files (`1cac948e8`, `28f49d8af`, `9c2d76370`, `85c55e838`). Every such change happens next to, and must step around, a second consumer that nobody runs in production.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief had already been removed, so all evidence was read from that commit with `git archive` (into a scratch folder) and `git grep` against the commit. No tests or builds ran, because the snapshot has no `node_modules`.

The public website `apps/web` (package `@omnyo/web`, a TanStack Start app on Vite 8) serves `https://omnyohq.com`. In November 2026 its homepage evolved inside a design "lab" from "Open 5" to "Combined A" to "Combined A v2". The final version became the homepage, but the code stayed in the lab folders.

Observed facts (Proven by inspection unless labelled otherwise):

- **The homepage is lab code.** `apps/web/src/routes/index.tsx:5-6` imports `QUESTIONS` from `../lab/combined-a-v2/content` and the default `LandingPage` from `../lab/combined-a-v2/page`.
- **The Combined A v2 page depends on three other lab folders.**
  - `lab/combined-a-v2/page.tsx:1` imports `"../combined-a/styles.css"`, and `:2` imports `"./styles.css"`.
  - `:16` imports `AppMock` and `PhoneMock` from `../app-mock/app-mock`.
  - `:17` imports `PLATFORM_LINE` from `../open-5/content`.
  - `:18` imports `KineticShell`, `Mark`, `Terminal` and `at` from `../open-5/page`.
  - `lab/combined-a-v2/devices.tsx:11` and `switch.tsx:14` import `Mark`. `yours.tsx:5-6` imports `at` and `STREAM_REACH_SPAN` (from `../open-5/particles`).
  - `Page` (`combined-a-v2/page.tsx:294-315`) renders `<KineticShell className="lab-combined-kinetic lab-combined-a-v2" labels={ACT_LABELS} productStage productMorph themed>`.
- **Production feature pages also use lab code.** `apps/web/src/features/visuals/app-{overview,preview,review,schedule,split}.visual.tsx:3` import `AppMock` from `../../lab/app-mock/app-mock`.
- **`lab/open-5/page.tsx` (835 lines) is both the live shell and a dead preview.**
  - Live part, still used: the side-effect imports at `:1-5` (fonts, `./styles.css`, `./chrome-extras.css`), `at` (`:35`), `Mark` (`:38`), `GetButton` (`:55`), `Terminal` (`:69`), `Nav` (`:143-174`), `Footer` with `FOOT_FEATURES` (`:674-755`), the reduced-motion helpers (`:757-766`) and `KineticShell` (`:768-821`).
  - Preview part, dead in production: `Hero` (`:176`), `Story` (`:239`), `AppScene` (`:288`), `ReviewScene` (`:383`), `MORE` and `MoreVisual` (`:452-566`), `MoreScene` (`:568`), `YoursScene` (`:598`), `CtaScene` (`:637-672`) and `export default function Page()` (`:823-835`). None of the scene functions is exported. Only `Page` renders them.
- **Why the dead preview still ships.** `lab/designs.ts:40-46` registers `{ slug: "open-5", load: () => import("./open-5/page") }`, and `routes/lab.$design.tsx:31-33` reads `module.default`. Because of that dynamic import, the bundler must keep `Page` and everything it renders. A module is not split between chunks, so the scenes travel in the same module the homepage imports statically. That this module is part of the homepage's JavaScript is Proven by inspection from the module graph. How many bytes it adds is a Hypothesis until measured.
  - The lab routes answer 404 in production: `lab/lab-access.ts:3-5` `requireLabPreview` throws `notFound()` when `import.meta.env.PROD`. They still compile into the build, because `routeTree.gen.ts` registers them.
  - CSS is not tree-shaken. `lab/open-5/styles.css` is a side-effect import of the shell module, so all 2,496 lines reach the homepage stylesheet whether or not any markup uses them.
- **`lab/open-5/content.ts` (105 lines).** `WINDOWS` (`:16-66`) and `THREADS` (`:74-105`) are read only by the preview scenes. `STORY_LINES` (`:67-73`) is read only by the preview scenes and by `combined-a/page.tsx:16`. `ACTS` (`:5-15`) is read only as the default `labels = ACTS` of `startStory` (`lab/open-5/story.ts:2`, `:129`). Both remaining `KineticShell` callers pass `labels` explicitly: `combined-a-v2/page.tsx` and `combined-a/page.tsx:326-330`. The rest of the file re-exports `PLATFORMS` and `PLATFORM_LINE` from `../../landing/platforms` (`:1`) and `SWITCH_GUIDES` and `TOPIC_GUIDES` from `../../landing/site-links` (`:3`). Combined A v2 has its own `STORY_LINES` and `WINDOWS` in `lab/combined-a-v2/content.ts:14` and `:21`.
- **The Combined A preview.** `lab/designs.ts:103-109` registers `combined-a`, which loads `lab/combined-a/page.tsx` (339 lines). That page is the only importer of `lab/combined-a/content.ts` (141 lines). It and `lab/eclipse-4/page.tsx:22` (RF-011's scope) are the only importers of `lab/app-mock/glide.ts` (182 lines). `combined-a/page.tsx:1` imports `./styles.css`, the same sheet that the homepage imports at `combined-a-v2/page.tsx:1`, so that sheet must survive.
- **Repository-wide consumer search.** `git grep -n -E "src/lab|lab/(open-5|combined-a|app-mock|visuals)|combined-a-v2|lab-open-5|lab-combined" e9e1b74c3 -- . ':!apps/web/src/lab/**' ':!pnpm-lock.yaml'` finds only `routes/index.tsx:5-6` and the five `features/visuals/app-*.visual.tsx:3` imports. A search for `open 5|open-5|combined a|combined-a` outside the lab finds only `routes/index.tsx`. So no doc, script, Containerfile, test or configuration names these modules. `apps/landing/.containerignore:35-36` includes all of `apps/web`, and `apps/landing/Containerfile` builds the whole app. The `import.meta.glob` patterns in `apps/web/src` (`features/features.test.ts:17`, `compare/comparisons.test.ts:18`, `landing/internal-links.ts:4`, `server/sitemap.test.ts:6`, `lab/visuals/page.tsx:11`) match none of these files. `landing/content-bundle.test.ts` walks only the graph of `landing/site-chrome.tsx`.
- **CSS reachability scan (Reproduced).** A Python script, run with `python3 -I` over the extracted snapshot, worked as follows:
  1. It collected every identifier-like token, including hyphens, from all non-test `.ts`/`.tsx` files in `apps/web/src`. It excluded the 13 RF-011 variants, `lab/combined-a/`, `lab/designs.ts`, `lab/lab-access.ts` and lines `176-672` and `823-835` of `lab/open-5/page.tsx`.
  2. It treated every template prefix written as `prefix-${` or `"prefix-" +` as a wildcard. Prefixes it found include `win-`, `tile--`, `dv-glyph--`, `dv-swap--`, `dv-machine--`, `route-node--`, `am-i--`, `am-agent--`, `get-btn--` and `is-`.
  3. It marked a rule dead only when every selector in the rule's selector list contains at least one class that no kept file mentions.
  - Result for `lab/open-5/styles.css`: 133 dead rules covering 789 rule lines, or 922 file lines with their blank separators. 25 of those rules sit inside the `@media` blocks that start at `:2069`, `:2441` and `:2468`. The 80 dead classes are all preview-scene classes, for example `.app-pin`, `.mock`, `.mock-heading`, `.msg`, `.bubble`, `.card-line`, `.review-title`, `.more-card`, `.more-count`, `.viz-*`, `.cta-switch`, `.node--a`, `.pill--claude` and `.flow-draw`. The first dead rule is `.lab-open-5 .app-pin` at `:970`.
  - Every one of the 351 rule selectors in that file is scoped under `.lab-open-5`, or is a keyframe step or `::selection`. A dead rule therefore cannot affect any other page.
  - All nine `@keyframes lab-open-5-*` still have live uses after the deletion. `@property --n` (`:13-17`) has no remaining use in CSS or TS and can go too.
  - Result for `lab/combined-a/styles.css`: 14 dead rules, 85 rule lines, about 99 file lines. They style `.kinetic-clock`, `.kinetic-clock-dot`, `.kinetic-word-time`, `.yours-facts` and `.yours-foot`, which only `combined-a/page.tsx:164-174` and `:247-253` render.
  - Result for `lab/open-5/chrome-extras.css`: nothing dead.
  - Sampled checks: `review-title` appears elsewhere only as `wf-review-title` (`workflow-catalog/WorkflowListing.tsx:117`), and `bubble` only as `fv-multi-agent-bubble` (`features/visuals/multi-agent.visual.tsx:38`). Both are distinct tokens, and both sit outside `.lab-open-5` anyway.
- **`story.ts` carries scene hooks only the preview uses.** It looks up `[data-scene="review"]` and `[data-scene="more"]` (`lab/open-5/story.ts:190-191`), measures them (`:588-589`), includes them in the scene and act tables (`:776-777`, `:1102-1103`) and sets `--s` on the review scene (`:1129-1135`). The homepage renders `hero`, `story`, `app`, `yours`, `cta` and the shell's `footer`, never `review` or `more`. After this card, the only `KineticShell` caller passes `productStage`, `productMorph` and `themed` as `true` and no `onProductProgress`. The `false` branches of those flags in `story.ts` (31 references) therefore become constant too. This card deliberately does **not** edit those branches (see Non-goals).
- **Tests.** `lab/combined-a-v2/beat-stepper.test.ts`, `lab/open-5/disc-frames.test.ts` and `lab/open-5/tones.test.ts` (469 lines) test the live engine and stay. `lab/lab-access.test.ts` stays. No test covers the deleted previews. The image test `apps/landing/scripts/chibistack-test.mjs:327-352` checks the server-rendered homepage: the title, the canonical link, the macOS download link, the `github.com/get-bb/bb` credit rendered by `Footer`, a built `/assets/` reference, the consent panel and the absence of third-party scripts.
- **History.** In the public history, `combined-a/page.tsx` was touched only by the import commit `ff501adc9`. `open-5/page.tsx`, `story.ts`, `particles.ts` and `combined-a-v2/*` received homepage work in `1cac948e8`, `28f49d8af`, `9c2d76370` and `85c55e838` (2026-11-24 to 2026-11-25).

Counterevidence and assumptions:

- The lab is a supported development tool, and Alex may still compare the Open 5 and Combined A directions. The repository holds no evidence either way, which is why this card is decision-needed.
- The bundle effect is unmeasured. Because the scenes share a module with the live shell, their JavaScript ships with the homepage. If the Vite 8 bundler (Rolldown) placed that module in a chunk the homepage does not load, which module-level chunking makes very unlikely, the JavaScript gain would vanish and only the CSS gain would remain.
- Hypothesis: no external site deep-links to `/lab/open-5` or `/lab/combined-a`. Both already return 404 in production, so retiring them changes nothing for visitors.
- Foreign uncommitted work: at audit time the main checkout `$OMNYO_CHECKOUT` had uncommitted edits in `apps/web/src/features/visuals/app-*.visual.tsx` and `features/feature-frame.tsx`, among others. They remove the `import "./app.css"` line from the header of each visual file, next to the `AppMock` import that checkpoint E would rewrite. Execute in a fresh worktree from `origin/main`, and expect a trivial merge with that work if it lands first.

**Proposed end state and preservation argument**

After checkpoints A to D, which deliver the gain:

- `lab/open-5/page.tsx` keeps only the shell: `at`, `Mark`, `GetButton`, `Terminal`, `TerminalWindow`, `Nav`, `Footer`, the reduced-motion helpers and `KineticShell`. It has no default export. Its side-effect imports `:1-5` stay first, in the same order.
- `lab/open-5/content.ts` is deleted. `page.tsx` imports `SWITCH_GUIDES` and `TOPIC_GUIDES` from `../../landing/site-links` directly. `combined-a-v2/page.tsx:17` imports `PLATFORM_LINE` from `../../landing/platforms`. `startStory` and `KineticShell` take `labels` as a required prop, so no hidden default stands in for a missing value.
- `lab/open-5/styles.css` loses the 133 dead rules (about 922 lines) and the orphaned `@property --n`. Every surviving rule keeps its text and its relative order.
- `lab/combined-a/page.tsx` and `lab/combined-a/content.ts` are deleted. `lab/combined-a/styles.css` loses its 14 dead rules and stays the homepage's first stylesheet import.
- `lab/app-mock/glide.ts` is deleted once `eclipse-4` is also gone (RF-011).
- `LAB_DESIGNS` loses the `open-5` and `combined-a` entries. `combined-a-v2` and `visuals` stay registered.

After the optional checkpoint E, which moves code without deleting any: the live homepage modules live in a production folder, and `src/lab` holds only `designs.ts`, `lab-access.ts`, `visuals/` and any kept variants. The proposed layout (Alex may choose other names):

| From (snapshot) | To |
|---|---|
| `lab/combined-a-v2/*` (13 source files, 1 test) | `apps/web/src/home/*` |
| `lab/open-5/{page.tsx → shell.tsx, story.ts, particles.ts, disc-frames.ts, tones.ts, styles.css, chrome-extras.css}` and its 2 tests | `apps/web/src/home/kinetic/` |
| `lab/combined-a/styles.css` | `apps/web/src/home/kinetic-workspace.css` |
| `lab/app-mock/{app-mock.tsx, app-mock.css}` | `apps/web/src/app-mock/` (shared by the homepage and `features/visuals`) |

`routes/index.tsx`, the five `features/visuals/app-*.visual.tsx` files and `designs.ts`'s `combined-a-v2` entry point at the new paths. Production then never imports `src/lab`.

What is preserved, and why:

- **Homepage markup and behavior.** No live component, prop value, class name, data attribute or copy changes. The deleted functions are not exported and are rendered only by the deleted `Page`. The scroll story (`story.ts`), particles, disc frames, tones, beat stepper, theme toggle, nav progress, circle wipe, product morph and reduced-motion handling are untouched. The only signature change is that `labels` becomes required. Both remaining call sites already pass it, and TypeScript enforces it.
- **Homepage styling.** A deleted rule cannot match any element the homepage renders, because each one requires a class that no kept source mentions. The scope to `.lab-open-5` keeps every other page out of reach. The surviving rules keep their order. During the move, the import statements keep their order inside each module (`combined-a-v2/page.tsx:1-2` first, then the module imports in their current order, and the shell's `:1-5` side-effect imports first), so the emitted stylesheet order is unchanged.
- **SEO, structured data and the image-test contract.** `routes/index.tsx` keeps its `head`, `loader`, `QUESTIONS` and structured data. `Footer` keeps the bb credit and the download links that `chibistack-test.mjs:333-345` asserts.
- **Feature pages.** `AppMock` and `app-mock.css` are unchanged, and only their path moves in checkpoint E.
- **Lab.** `/lab/` and `/lab/$design` keep their production 404 guard. In development, `/lab/open-5` and `/lab/combined-a` render the existing unknown-slug `notFound()` (`routes/lab.$design.tsx:12`). `/lab/combined-a-v2` and `/lab/visuals` keep working.

The only intended observable changes: the two lab slugs disappear in development, and homepage visitors download less JavaScript and CSS (to be measured).

Non-goals: no edit to `story.ts` flag branches or its `review` and `more` hooks; no change to `Footer` link sets (RF-092); no change to the other lab variants (RF-011); no website deployment. A later, separately verified change could collapse the constant `productStage`, `productMorph` and `themed` branches in `story.ts`. That is a semantic edit to a scroll-driven engine. Its gain has not been measured (Hypothesis), and it needs its own visual verification, so it is not part of this plan.

Alternative if Alex wants to keep the Open 5 preview: move `Hero` through `CtaScene`, `MORE`, `MoreVisual` and the default `Page` into a new `lab/open-5/preview.tsx`. Move the 133 scene rules into a new `lab/open-5/preview.css`, imported only by `preview.tsx`, and point `designs.ts` at `./open-5/preview`. Nothing is deleted, but the homepage stops shipping the scene code and CSS, and the preview keeps working in development. The same applies to Combined A: keep `combined-a/page.tsx` and its content, and move only its 14 rules into a preview-only sheet. Combined A does not affect the homepage bundle, because it loads only through its own dynamic chunk.

**Expected gain and cost**

Handwritten production lines removed, with the method for each count:

| Item | Lines | Basis |
|---|---:|---|
| `lab/open-5/page.tsx` preview scenes and default `Page` | about 515 | Lines `176-672` (497) and `823-835` (13), plus their separators and the `DownloadPanel`, `PLATFORM_LINE`, `STORY_LINES`, `THREADS` and `WINDOWS` imports. Counted with `sed -n`. |
| `lab/open-5/content.ts` | 105, minus about 3 added import lines | `wc -l`. |
| `lab/open-5/styles.css` dead rules and `@property --n` | about 928 | Scan: 789 rule lines, 133 separators, 6 lines of `@property`. |
| `lab/combined-a/page.tsx` and `content.ts` | 480 | `wc -l`. |
| `lab/combined-a/styles.css` dead rules | about 99 | Scan: 85 rule lines plus 14 separators. |
| `lab/designs.ts` entries `open-5` and `combined-a` | 14 | 2 entries of 7 lines. |
| `lab/app-mock/glide.ts` (only after RF-011 removes `eclipse-4`) | 182 | `wc -l`. Counted here once, by agreement with RF-011. |
| **Total** | **about 2,140, or about 2,320 with `glide.ts`** | |

Lines added: about 3 import lines. The optional checkpoint E moves about 14,000 lines (the 15,840 production-reachable lines minus the deletions above). Those moved lines are not counted as a reduction. Tests: none removed, and 469 test lines move unchanged in checkpoint E. Generated code: `routeTree.gen.ts` does not change, because no route file is added or removed.

Mechanisms, before and after:

- Before: one module (`lab/open-5/page.tsx`) serves two consumers, the live homepage shell and a lab preview. Two dead preview pages (Open 5 and Combined A) share the homepage's engine, content and stylesheets. One content module re-exports landing data only to feed them.
- After: one consumer per module. The `KineticShell` engine has exactly one caller, which makes its constant option branches visible for a later decision. After checkpoint E, production code never imports `src/lab`, so deleting a lab folder no longer needs an import trace (the trace RF-011 had to run).

Maintenance effect:

- Today, a homepage edit to the nav, footer, terminal, shell or `styles.css` happens in a file named `lab/open-5/page.tsx` that still carries 510 lines of an unused page. A maintainer has to work out which of the 2,496 CSS lines are live; 922 of them are not.
- Today, every change to `KineticShell` or `startStory` options has to keep two dead callers compiling (`open-5` `Page` with all defaults, and `combined-a` with `productStage` and `onProductProgress`).
- Afterwards, those dead callers and their styles are gone. With checkpoint E, the homepage is findable under `src/home` instead of under a folder whose name signals disposable experiments.

Performance (all Hypothesis until measured): the homepage's JavaScript shrinks by the minified size of about 500 TSX lines of scene components. The homepage stylesheet loses about 870 lines of rules. The browser parses and matches fewer selectors. Build and typecheck time shrink slightly. Measure as described under Verification.

Cost: checkpoints A to D take about half a day including the build comparison. Checkpoint E takes about half a day plus a careful visual pass.

**Execution steps**

1. **Decision gate (blocking).** Ask the owner, together with RF-011's keep-list question: "May the standalone lab previews `open-5` (Open 5 · Kinetic scroll story) and `combined-a` (Combined A · Kinetic workspace) be retired? The homepage keeps all of its engine code." Also ask whether he wants the live homepage moved out of `src/lab` (checkpoint E), and under which folder name; the default is `apps/web/src/home`.
   - If he keeps both previews, use the "Alternative" in the end-state section instead of checkpoints B to D.
   - If he keeps only one, apply its part of the alternative and the deletion for the other.
   - Record the answer in the commit message.
2. **Reconfirm the baseline.** Work on a named branch in a fresh linked worktree from `origin/main` (see `~/.agents/docs/storage.md`), never in the shared main checkout, which holds foreign uncommitted website work. Check each of the following:
   - `apps/web/src/routes/index.tsx` still imports only `../lab/combined-a-v2/{content,page}` from the lab.
   - `rg -n "\.\./open-5/|\.\./combined-a/|lab/app-mock|lab/open-5|lab/combined-a" apps/web/src --glob '!apps/web/src/lab/open-5/**'` lists only the importers named in Context.
   - `rg -n "\b(Hero|Story|AppScene|ReviewScene|MoreScene|YoursScene|CtaScene|MoreVisual)\b" apps/web/src/lab/open-5/page.tsx` shows no `export` on those functions.
   - `git grep -n -E "lab/(open-5|combined-a)|combined-a-v2" -- . ':!apps/web/src/lab/**' ':!pnpm-lock.yaml'` hits only `routes/index.tsx` and `features/visuals/app-*.visual.tsx`.
   - Re-plan if a new production importer of `combined-a/page.tsx`, `combined-a/content.ts` or a scene function exists, or if `story.ts` gained logic that reads scene markup the homepage now renders.
   - Record the baselines: `pnpm --filter @omnyo/web typecheck` and `pnpm --filter @omnyo/web test` must pass. Run `pnpm --filter @omnyo/web build`, then record the size of every file under `apps/web/dist/client/assets` that the `/` route loads. One way is to list the `/assets/*.js` and `/assets/*.css` URLs in the server-rendered HTML of `/` from `node apps/web/server.mjs` or the image-test recipe, then run `gzip -c <file> | wc -c` on each. Save a set of screenshots of `/` at fixed scroll offsets: the top, each act boundary and the footer. Take them in light and dark themes, with and without `prefers-reduced-motion`, at mobile (390 px), tablet (820 px) and desktop (1440 px) widths. These are the visual baseline. Do not regenerate them later to make the change pass.
3. **Checkpoint A: retire the registry entries.** In `apps/web/src/lab/designs.ts`, delete the `open-5` entry (`:40-46`) and the `combined-a` entry (`:103-109`). If RF-011 has already removed `open-1` to `open-4`, the `"open"` group is now empty: remove `"open"` from the `LabDesign.group` union (`:5`) and the `{ id: "open", ... }` row from `GROUPS` in `apps/web/src/routes/lab.index.tsx:18`.
4. **Checkpoint B: delete the Open 5 preview code.** In `apps/web/src/lab/open-5/page.tsx`:
   - Delete `Hero`, `Story`, `AppScene`, `ReviewScene`, `MORE`, `MoreVisual`, `MoreScene`, `YoursScene` and `CtaScene` (`:176-672` at the snapshot) and `export default function Page()` (`:823-835`).
   - Remove the now-unused `DownloadPanel` import (`:18` keeps `DownloadButton`).
   - Replace the `./content` import block (`:25-32`) with `import { SWITCH_GUIDES, TOPIC_GUIDES } from "../../landing/site-links";`.
   - Make `labels` required in `KineticShell` by changing `labels?: readonly string[]` to `labels: readonly string[]`.
   - In `apps/web/src/lab/open-5/story.ts`, delete `import { ACTS } from "./content";` (`:2`) and change the options to require `labels: readonly string[]`, with no default.
   - Delete `apps/web/src/lab/open-5/content.ts`.
   - In `apps/web/src/lab/combined-a-v2/page.tsx:17`, import `PLATFORM_LINE` from `"../../landing/platforms"`. Keep the line in the same position in the import list.
   - Do not touch the `review` and `more` hooks in `story.ts`. With no such markup, `scene()` returns `null` and the code already handles that, exactly as the homepage does today.
   - Run `pnpm --filter @omnyo/web typecheck`. It must pass.
5. **Checkpoint C: delete the Combined A preview code.** Delete `apps/web/src/lab/combined-a/page.tsx` and `apps/web/src/lab/combined-a/content.ts`. Keep `apps/web/src/lab/combined-a/styles.css`. If `apps/web/src/lab/eclipse-4/` no longer exists (RF-011 landed), also delete `apps/web/src/lab/app-mock/glide.ts`; otherwise leave it for RF-011 and note that in the PR. Run `pnpm --filter @omnyo/web typecheck` again.
6. **Checkpoint D: delete the dead CSS rules.**
   - **Regenerate the scan on the new tree before deleting anything.** Collect tokens from every non-test `.ts`/`.tsx` file in `apps/web/src`, excluding any remaining RF-011 variant folders, `lab/designs.ts` and `lab/lab-access.ts`. Treat `prefix-${` and `"prefix-" +` template prefixes as wildcards. Mark a rule dead only if every selector in its list has a class that no token or prefix matches. Recurse into `@media`, `@supports` and `@container`. Keep all `@keyframes`, `@property` and at-rules unless the next bullet proves them orphaned.
   - Delete the reported rules from `apps/web/src/lab/open-5/styles.css`. Expect about 133 rules. At the snapshot they run from `.lab-open-5 .app-pin` at `:970` through the preview rules inside the `@media` blocks at `:2069`, `:2441` and `:2468`. Delete each rule together with the blank separator that follows it.
   - Delete the 14 rules for `.kinetic-clock`, `.kinetic-clock-dot`, `.kinetic-word-time`, `.yours-facts` and `.yours-foot` from `apps/web/src/lab/combined-a/styles.css`.
   - Delete `@property --n` (`open-5/styles.css:13-17`) only if `rg -n -- "--n\b" apps/web/src` finds no remaining use.
   - Keyframes are global across stylesheets: before deleting any `@keyframes`, search every `.css` and `.ts*` file in `apps/web/src` for its name. At the snapshot, all nine `lab-open-5-*` keyframes keep live uses, so none should go.
   - Stop if the regenerated scan flags a class that any kept file builds at runtime in a way the prefix rule cannot see (for example from a lookup table of fragments).
7. **Checkpoint D verification.** Run `pnpm --filter @omnyo/web typecheck`, `pnpm --filter @omnyo/web test` and `pnpm --filter @omnyo/web build`.
   - Compare the emitted homepage CSS with the baseline: every selector that survives must appear in the same relative order. One way to check this is to extract selectors from both CSS files and `diff` the lists; the new list must be the old list minus the deleted selectors.
   - Compare the homepage asset sizes with the baseline.
   - Compare the screenshot set from step 2 at the same offsets, themes, motion settings and widths. Expect no visual difference.
   - Commit checkpoints A to D as the deletion commit, or as one commit per checkpoint.
8. **Checkpoint E (optional, only if Alex chose the move): move the live modules.** Use `git mv` only, with no edits inside moved files other than import specifiers, so the history shows renames.
   - Move the files to the paths in the end-state table: `lab/combined-a-v2/*` to `apps/web/src/home/`, the shell `lab/open-5/page.tsx` to `apps/web/src/home/kinetic/shell.tsx` together with `story.ts`, `particles.ts`, `disc-frames.ts`, `tones.ts`, both CSS files and both tests, `lab/combined-a/styles.css` to `apps/web/src/home/kinetic-workspace.css`, and `lab/app-mock/app-mock.{tsx,css}` to `apps/web/src/app-mock/`.
   - Update these import specifiers:
     - `routes/index.tsx:5-6` → `../home/content` and `../home/page`.
     - `home/page.tsx:1` → `"./kinetic-workspace.css"` (still the first line).
     - `home/page.tsx:16` → `../app-mock/app-mock`.
     - `home/page.tsx:18`, `home/devices.tsx:11`, `home/switch.tsx:14` and `home/yours.tsx:5` → `./kinetic/shell`.
     - `home/yours.tsx:6` → `./kinetic/particles`.
     - `home/content.ts:1` → `../app-mock/app-mock`.
     - `../../landing/*` imports inside the shell → `../../landing/*` relative to `home/kinetic/`, which resolves to the same depth.
     - The five `features/visuals/app-*.visual.tsx:3` imports → `../../app-mock/app-mock`.
     - The `lab/designs.ts` `combined-a-v2` entry → `load: () => import("../home/page")`.
   - Keep every import statement in its current order. Keep the class names (`lab-open-5`, `lab-combined-kinetic`, `lab-combined-a-v2`): renaming them is a cosmetic change with cascade risk and is out of scope.
   - Rerun step 7's checks: typecheck, test, build, CSS selector-order diff, asset sizes and screenshots. The emitted homepage CSS must equal the checkpoint D output except for asset file names.
   - Commit the move separately from the deletion.
9. **Format and lint the changed files.** From the repository root, run `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed .ts/.tsx files>`. The root `.oxlintrc.json` and `.oxfmtrc.json` exist at the snapshot. The exact flags follow the global agent instructions and were not executed during the audit.
10. **Inspect the full diff.**
    - Expect deletions in `lab/open-5/{page.tsx,styles.css}`, `lab/combined-a/styles.css` and `lab/designs.ts`; deleted `lab/open-5/content.ts`, `lab/combined-a/{page.tsx,content.ts}` and possibly `lab/app-mock/glide.ts`; the import edits in `story.ts` and `combined-a-v2/page.tsx`; and, for checkpoint E, renames plus import specifiers only.
    - `routeTree.gen.ts` must not change.
    - Recount the deletions with `git diff --numstat origin/main -- apps/web/src` and compare them with the table above.

**Verification and acceptance criteria**

All commands run from the repository root. Their scripts were read from `apps/web/package.json:6-13` (`dev`, `build`, `start`, `typecheck`, `test`) and the root `package.json`. None was executed during the audit, because the snapshot had no `node_modules`.

- `pnpm --filter @omnyo/web typecheck` (runs `tsc --noEmit`): passes. This proves that no live file referenced a deleted symbol and that both `labels` call sites satisfy the now-required prop.
- `pnpm --filter @omnyo/web test` (runs `vitest run --config vitest.config.ts`): passes, including `beat-stepper.test.ts`, `disc-frames.test.ts`, `tones.test.ts`, `lab-access.test.ts`, `landing/content-bundle.test.ts` and `features/features.test.ts`, at their old paths or after the move. Do not edit their assertions.
- `pnpm --filter @omnyo/web build` (runs `vite build`): passes. The README also documents the equivalent `pnpm exec turbo run build --filter=@omnyo/web` (`apps/landing/README.md:29`).
  - **Performance acceptance:** the summed gzip size of the JS and CSS that `/` loads must not grow. Expect a reduction: the scene components (for example the strings `"A preview for every branch"` from `MORE`, or `viz-browser`) must no longer appear in any file under `apps/web/dist/client/assets`. Check with `rg -l "A preview for every branch|viz-browser" apps/web/dist/client`. Record both measurements in the PR. No regression allowance is set, because no budget exists. Any growth stops the change.
- **Image test** against the local build, following `apps/landing/README.md:33-35`: copy `apps/web/dist`, `apps/web/server.mjs` and `apps/landing/scripts/chibistack-test.mjs` (as `test.mjs`) into one scratch folder, then run `SITE_TEST_ROOT=<folder> SITE_TEST_PORT=<free port> node <folder>/test.mjs`. It must pass. It asserts the homepage title, canonical link, macOS download link, the bb credit in `Footer`, a built asset, the consent panel and the absence of third-party scripts. The recipe comes from the README and was not run during the audit.
- **Visual and interaction comparison of `/`:** run `pnpm --filter @omnyo/web dev` and compare against the step 2 baseline. Check light and dark themes and the theme toggle; reduced motion on and off; 390 px, 820 px and 1440 px widths; the intro reveal, the story scattered-windows act, the circle wipe and tone steps, the product morph and its arriving state, the Devices, Yours (stream), Switch, Questions and CTA sections, nav progress and act labels, and the footer links and Cookie settings button. Alex tests UI changes himself, so hand him the screenshot pairs. A single screenshot does not verify scroll timing: scroll through each act once at each width.
- **Feature pages:** `/features/<slug>` pages whose visuals use `AppMock` (`app-overview`, `app-preview`, `app-review`, `app-schedule`, `app-split`) render as before. This matters most after checkpoint E.
- **Lab in development:** `/lab/` lists no `Open 5` or `Combined A · Kinetic workspace` entry and no empty group heading. `/lab/open-5` and `/lab/combined-a` show the not-found page. `/lab/combined-a-v2` and `/lab/visuals` still load.
- **Structural completion:**
  - `rg -n "export default function Page" apps/web/src/lab/open-5 apps/web/src/home` finds only the homepage page.
  - `rg -n "open-5/content|combined-a/page|combined-a/content" apps/web/src` returns nothing.
  - `rg -c "KineticShell" apps/web/src` shows only the shell definition and the homepage.
  - After checkpoint E, `rg -n "from \"[^\"]*lab/" apps/web/src --glob '!apps/web/src/lab/**' --glob '!apps/web/src/routes/lab.*'` returns nothing, so production no longer imports the lab.
  - Rerun the CSS scan: it reports zero dead rules in the shell and workspace sheets.

**Rollback and stop conditions**

- **Rollback:** the deletion (checkpoints A to D) and the move (checkpoint E) are separate commits. `git revert` of either restores the files, rules and registry entries exactly. No persisted data, migration, public API, SDK export or route file is involved. A deployed website keeps serving its previous image until the next release. Shipping this change means a website release through the `landing-release` flow in `apps/landing/README.md`, which needs the owner's explicit authorization and is not part of this card.
- **Stop and re-plan if any of these happens:**
  - Alex wants to keep a preview: use the "Alternative" split for that preview.
  - A live (non-lab) file at the new baseline imports `combined-a/page.tsx`, `combined-a/content.ts`, `open-5/content.ts` or a scene function, or renders `data-scene="review"` or `data-scene="more"`. The `story.ts` hooks would then be live, and deleting their styles could matter.
  - The regenerated CSS scan flags a rule whose class a kept file can produce at runtime, or the selector-order diff shows a surviving rule moved.
  - Any screenshot at a fixed offset differs, or a scroll act misbehaves. Bisect between checkpoints B, C, D and E. Revert checkpoint D first, because it is the most likely cause of a visual difference, and E second.
  - The homepage's gzip JS or CSS grows.
  - The checkpoint E move conflicts with uncommitted or newer foreign work in `apps/web/src/features/visuals/*` or in the homepage modules. Rebase onto the new `origin/main` and redo the specifier edits. Never overwrite the other work. If the conflict persists, land checkpoints A to D alone; they deliver the whole reduction.
- **Safer smaller alternative:** checkpoint A plus the deletion of `Page` and the scenes from `open-5/page.tsx` delivers the JavaScript gain with almost no risk, because it is TypeScript-checked and changes no CSS. Checkpoint D is where the stylesheet risk sits, and it can follow separately after the screenshot comparison.
