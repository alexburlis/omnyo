# RF-096 — Remove the showcase-hero configuration API (copy, composer and rail injection plus the BrowseHeroCarousel pass-through) by making the plugins Browse hero own its carousel

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: `apps/app/src/components/showcase-hero/` is a configurable carousel framework with exactly one consumer, and has never had a second one. The sweep's plan needed three corrections. First, the files must move under `plugin/browse-hero/`, not only lose their config props. If they stayed in `showcase-hero/` and imported plugin constants directly, a "generic" folder would depend on plugin-specific modules. Second, `ShowcaseFrame` carries five injected props of its own that should go too. Third, the projected saving is about 70 to 100 handwritten production lines, not 40 to 90.
- **Potential:** low. One needless layer disappears: a pass-through component, two configuration interfaces, and ten injected constant props across the carousel and the frame. The change is local to one UI surface.
- **Confidence:** high for the single-consumer facts, which are proven by inspection and by history. Medium for the line estimate, which is a projection. No tests were run, because the snapshot has no `node_modules`.
- **Readiness:** ready.
- **Effort:** small, about two to three hours including the focused test, typecheck, lint and a Ladle comparison.
- **Risk:** low. The change is structural. The realistic regressions are a changed visible string (for example, the trailing space in the frame title prefix "Omnyo — "), a changed composer draft key (which would orphan users' saved drafts), or a stale hook dependency list.
- **Prerequisites:** none.
- **Related and overlapping:** RF-047 ("Retire the finished Polish review Ladle story and manifest") touches `apps/app/src/polish-review/polish-review-manifest.ts`, which names `apps/app/src/components/plugin/browse-hero/BrowseArchetypeCards.tsx` at lines 8688 and 8711. That file keeps its path in this plan, so the two changes do not conflict. No other RF touches these files.
- **Why it deserves its place:** it is cheap, safe and fully proven. Today, changing the hero copy, the composer placeholder or the rail icons means editing a wrapper, which feeds a configuration object, which the framework forwards to a second component. Afterwards, each string sits in the component that renders it. The item ranks low because the saving is small and confined to one screen.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree had already been retired, so files were read with `git show e9e1b74c3:<path>`. `git diff --stat e9e1b74c3 HEAD` over `apps/app/src/components/showcase-hero`, `apps/app/src/components/plugin/browse-hero` and `apps/app/src/components/plugin/management/BrowsePluginsTab.tsx` printed nothing, so local `main` matched the snapshot for these paths at the time of the audit. Uncommitted local changes were not inspected, because `git status` writes the index.

*Subsystem.* The plugins Browse tab (`apps/app/src/components/plugin/management/BrowsePluginsTab.tsx`) opens with a hero. The hero is a carousel of six example plugin types ("archetypes"), each drawn as a small mock app scene. Picking an example seeds a new-plugin composer. Below the hero, while the user is composing, a grid of example cards (`BrowseArchetypeCards`) offers more starting prompts.

*Files* (line counts from `git show e9e1b74c3:<path> | wc -l`):

| Group | File | Lines | Kind |
|---|---|---|---|
| showcase-hero | `ShowcaseHeroCarousel.tsx` | 436 | production |
| showcase-hero | `ShowcaseFrame.tsx` | 136 | production |
| showcase-hero | `ShowcaseArchetypeCards.tsx` | 74 | production |
| showcase-hero | `scene-primitives.tsx` | 51 | production |
| showcase-hero | `showcase-archetype.ts` | 17 | production |
| showcase-hero | `showcase-tokens.ts` | 11 | production |
| browse-hero | `BrowseHeroCarousel.tsx` | 65 | production (the pass-through) |
| browse-hero | `MiniAppScenes.tsx` | 487 | production |
| browse-hero | `browse-hero-archetypes.ts` | 140 | production |
| browse-hero | `BrowseArchetypeCards.tsx` | 54 | production |
| browse-hero | `BrowseHeroCarousel.test.tsx` | 226 | test |
| browse-hero | `BrowseHeroCarousel.stories.tsx`, `BrowseArchetypeCards.stories.tsx` | 61 + 21 | Ladle stories |

In total, 725 showcase-hero production lines and 746 browse-hero production lines are in scope. Most of them move; they are not deleted complexity.

*The configuration layer* (Proven by inspection):

- `apps/app/src/components/showcase-hero/ShowcaseHeroCarousel.tsx:38-46` "ShowcaseHeroCopy" has seven string fields, and `:48-52` "ShowcaseHeroComposerConfig" has three. `:54-65` "ShowcaseHeroCarouselProps" takes `archetypes`, `scenes`, `copy`, `composer` and `rail`, plus five behavioural props.
- The carousel reads the copy at `:228` (`copy.ariaLabel`), `:240` (`copy.headlineLead`), `:254` (`copy.composingNoun`), `:258` (`copy.description`) and `:382` (`copy.tablistLabel`). It reads the composer config at `:84-89` (`composer.draftKey` in the `getPromptDraftAccessor` memo), `:184-187` (`composer.promptPrefix` in the open-request effect and its dependency list) and `:346-347` (`placeholder` and `draftKey` on `PluginNewThreadComposer`). At `:320-329`, it forwards `archetypes`, `scenes`, `copy.frameTitlePrefix`, `copy.frameBadge` and `rail` to `ShowcaseFrame`.
- `apps/app/src/components/showcase-hero/ShowcaseFrame.tsx:6-24` "ShowcaseFrame" declares those five props again and renders them at `:55` (`titlePrefix`), `:69` (`badge`), `:79` (`rail.map`) and `:109-110` (`archetypes.map` and `scenes[archetype.id]`).
- `apps/app/src/components/plugin/browse-hero/BrowseHeroCarousel.tsx:12-32` defines `PLUGIN_RAIL`, `PLUGIN_HERO_COPY` and `PLUGIN_HERO_COMPOSER` (with draft key `"plugins-browse-hero"` at `:31`). Lines `:34-65`, "BrowseHeroCarousel", only forward the constants and five behavioural props to `ShowcaseHeroCarousel`.

*Single consumer* (Proven by inspection). The search `git grep -n -E 'showcase-hero|ShowcaseHero|ShowcaseFrame|ShowcaseArchetype|ShowcaseExampleCard|showcase-tokens|scene-primitives|ShowcaseScenes' e9e1b74c3 -- .` ran over the whole snapshot, excluding the showcase-hero folder itself. It found imports only in `apps/app/src/components/plugin/browse-hero/` (`BrowseHeroCarousel.tsx:4-8`, `BrowseArchetypeCards.tsx:2`, `MiniAppScenes.tsx:1-11`, `browse-hero-archetypes.ts:2`). The only production consumer of the browse-hero components is `BrowsePluginsTab.tsx:20-21` (imports), `:279` (`<BrowseHeroCarousel openRequest={heroRequest} onComposingChange={setComposing} />`) and `:288` (`<BrowseArchetypeCards onCreate={openComposer} />`).

*Non-obvious consumers checked:*

- CSS, the Vite configs in `apps/app/*.ts` and the Ladle configuration: `git grep -i 'showcase\|browse-hero'` over `*.css`, `apps/app/*.ts`, `apps/app/*.json` and `*.mjs` found no references outside the folders above, `create-via-prompt-examples.test.ts:5` (which imports `browse-hero-archetypes`, unchanged here) and the polish-review manifest.
- `apps/app/src/polish-review/polish-review-manifest.ts:8688` and `:8711` name `BrowseArchetypeCards.tsx`. No manifest entry names a showcase-hero path.
- `apps/web`, `apps/mobile`, `plugins` and `packages`: the components live under `apps/app/src/components`, which no package exports. The search above covered the whole repository, including the plugin SDK, and found nothing.
- Persisted data: the draft key `"plugins-browse-hero"` (`BrowseHeroCarousel.tsx:31`) addresses a stored prompt draft through `getPromptDraftAccessor({ kind: "plugin-new-thread", key })`. The string must stay byte-identical, or users lose a saved hero draft. No other file contains the string.
- Docs: `git grep -i -E 'showcase|hero carousel|discovery hero' e9e1b74c3 -- docs DESIGN.md AGENTS.md` returned nothing.

*History* (Proven by inspection, private repository `$ARCHIVED_OMNYO_CHECKOUT`). `git log --all -S'<ShowcaseHeroCarousel'` lists only `fc0fa06214` (2026-08-13, "Add the Browse discovery hero and example-seeded composer (#1473)") and the public-source publish `060950255d`. The framework and its only consumer arrived in the same commit, and no second consumer ever existed. `git log --all -S'ShowcaseFrame'` also lists three archive or evidence-preservation commits (`fb7af41cc4`, `6dfe47f819`, `10722774eb`). Hypothesis: those commits copy worktree snapshots and add no consumer; they were not opened.

*Counterevidence.* The test name `BrowseHeroCarousel.test.tsx:44`, "dresses the shared engine in plugin copy, not another surface's", shows that the author meant the engine to be reused. No second hero exists at the snapshot and no document plans one. If Alex wants a Skills or Automations hero soon, the generic layer can be recreated then from this history.

*Maintenance cost today.* A reader editing the hero has to trace three files to learn where a string comes from: the wrapper constants, the carousel props and the frame props. The configuration interfaces must stay in sync with both components, and the hook dependency lists include config values that never change.

**Proposed end state and preservation argument**

What disappears:

- `apps/app/src/components/plugin/browse-hero/BrowseHeroCarousel.tsx` as a pass-through, together with `PLUGIN_HERO_COPY`, `PLUGIN_HERO_COMPOSER` and `BrowseHeroCarouselProps`.
- `ShowcaseHeroCopy`, `ShowcaseHeroComposerConfig`, and the `archetypes`, `scenes`, `copy`, `composer` and `rail` props of the carousel.
- The `archetypes`, `scenes`, `titlePrefix`, `badge` and `rail` props of `ShowcaseFrame`.
- The `apps/app/src/components/showcase-hero/` folder.

What remains, all under `apps/app/src/components/plugin/browse-hero/`:

- `BrowseHeroCarousel.tsx` holds the former `ShowcaseHeroCarousel` body, exported as `BrowseHeroCarousel` with exactly today's public props: `initialIndex?`, `autoplay?`, `composerDisabled?`, `openRequest?: { nonce: number; seed?: string; close?: boolean } | null` and `onComposingChange?`. It imports `BROWSE_ARCHETYPES`, `PLUGINS_BROWSE_DESCRIPTION` and `CREATE_PLUGIN_PROMPT` directly. It writes the five copy strings as literals and declares one module constant, `const DRAFT_KEY = "plugins-browse-hero";`, which is used twice.
- `BrowseHeroFrame.tsx` (the moved `ShowcaseFrame`) keeps `activeIndex`, `reducedMotion` and `className` as props. It imports `BROWSE_ARCHETYPES` and `MINI_APP_SCENES`, owns the `PLUGIN_RAIL` icon list, and writes the title prefix and the "Plugin" badge as literals.
- `scene-primitives.tsx`, `showcase-tokens.ts` and `showcase-archetype.ts` move unchanged. Renaming them is optional; keep them as plain moves.
- `ShowcaseExampleCard` either moves into `BrowseArchetypeCards.tsx` (its only consumer) as a non-exported component, or moves as its own file. Pick the merge only if the result stays readable; it saves about five import lines.

Dependency direction afterwards: `BrowsePluginsTab` uses `BrowseHeroCarousel`, which uses `BrowseHeroFrame`. `BrowseHeroFrame` uses `MiniAppScenes` and `browse-hero-archetypes`, and both of those use `scene-primitives`, `showcase-tokens` and `showcase-archetype`. Nothing imports upward, so no import cycle is introduced. Check that `MiniAppScenes.tsx` does not import the frame or the carousel; at the snapshot it imports only the three leaf modules.

Preservation argument. Every rendered string, aria attribute, class name, style, timer (`SLIDE_MS`), keyboard behaviour, reduced-motion rule and composer behaviour stays as it is. Only where the values come from changes. Contracts that must stay byte-identical:

- the `section` aria-label "What you can build with Omnyo plugins", the heading lead "Turn Omnyo into", the composing noun "whatever you need", the description `PLUGINS_BROWSE_DESCRIPTION`, and the tablist label "Plugin examples";
- the frame title prefix "Omnyo — ", including its trailing space, followed by `active.title`, and the badge "Plugin";
- the rail icons `MessageSquare`, `Folder` and `ListTodo`, in that order;
- the composer placeholder "Describe the plugin you want to build…" (with the Unicode ellipsis), the draft key `"plugins-browse-hero"` and the default seed `CREATE_PLUGIN_PROMPT`.

UI states to preserve: autoplaying, paused (by hover, by composing, by a hidden document or by reduced motion), composing with the composer mounted, the composer's exit animation before unmount, and the `openRequest` nonce, seed and close handling.

Why this is the simplest sufficient option: the configuration API exists only for a reuse that never happened. Deleting the wrapper alone would still leave the config interfaces. Inlining the constants without moving the folder would invert the dependency direction.

Non-goals: no visual change, no renaming of the archetype data or `MiniAppScenes`, and no change to `BrowsePluginsTab`. No new generic primitive is created.

**Expected gain and cost**

All of the following are projections; nothing was measured.

| Item | Projected production lines |
|---|---|
| Wrapper `BrowseHeroCarousel.tsx` removed (65 lines), minus about 11 lines that reappear (rail list, draft-key constant, three or four new imports) | −50 to −55 |
| `ShowcaseHeroCopy` and `ShowcaseHeroComposerConfig` removed (`ShowcaseHeroCarousel.tsx:38-52`) | −15 |
| Five carousel props: type fields and destructuring | −10 |
| Five frame props: the call site (`:321-326`), type fields and destructuring | −15 |
| Optional merge of `ShowcaseExampleCard` into `BrowseArchetypeCards.tsx` | −0 to −6 |
| Formatter wrapping of inlined literals | +0 to +5 |
| **Net** | **about −70 to −100** |

The test (226 lines) and the stories (82 lines) change only their test name and, if needed, their import paths. Expect a net test change of about 0.

Mechanisms before and after: today, a configurable framework plus an adapter serve one case, with ten injected props and two config interfaces. Afterwards, one carousel and one frame read their own constants. Performance: Hypothesis, neutral. Module constants replace stable props, and the React Compiler output should be equivalent. Bundle size changes by a few bytes. No measurement exists, and none is required for a change of this size.

Cost: about two to three hours. File moves change `git blame` paths; use `git log --follow` for history.

**Execution steps**

1. **Reconfirm the baseline.** In `$OMNYO_CHECKOUT` (or your own worktree from current `main`), run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/app/src/components/showcase-hero apps/app/src/components/plugin/browse-hero apps/app/src/components/plugin/management/BrowsePluginsTab.tsx`. Also check for uncommitted foreign edits to those paths; if any exist, work around them or stop. Rerun the consumer search from Context against `HEAD`. **Stop and re-plan** if any file outside `plugin/browse-hero/` now imports from `showcase-hero/`, or if a second hero has been added.
2. **Baseline evidence.** Run the existing test before editing (see Verification) and save its output. Open the Ladle stories `plugin/Browse Hero` and the archetype-card stories, and take reference screenshots of the autoplaying, composing and reduced-motion states. No new tests are needed: `BrowseHeroCarousel.test.tsx` already asserts the copy, the tablist label, the "Plugin" badge, tab wrapping, the open-request seeding and closing, and the cards.
3. **Checkpoint A: mechanical move, no semantic change.** Use `git mv` to move the six showcase-hero files into `apps/app/src/components/plugin/browse-hero/`. Name `ShowcaseHeroCarousel.tsx` `BrowseHeroEngine.tsx` for now, so that it does not collide with the wrapper. Name `ShowcaseFrame.tsx` `BrowseHeroFrame.tsx`, and keep the other file names. Update the imports in `BrowseHeroCarousel.tsx`, `BrowseArchetypeCards.tsx`, `MiniAppScenes.tsx` and `browse-hero-archetypes.ts` from `@/components/showcase-hero/...` to relative `./...` paths. Run typecheck and the focused test, which must still pass unchanged.
4. **Checkpoint B: remove the configuration API.**
   - In `BrowseHeroFrame.tsx` (symbol `ShowcaseFrame`, renamed `BrowseHeroFrame`): delete the `archetypes`, `scenes`, `titlePrefix`, `badge` and `rail` props from the destructuring and the type. Import `BROWSE_ARCHETYPES` from `./browse-hero-archetypes` and `MINI_APP_SCENES` from `./MiniAppScenes`. Move `PLUGIN_RAIL: readonly IconName[] = ["MessageSquare", "Folder", "ListTodo"]` here from the wrapper. Replace `{titlePrefix}{active.title}` with `{"Omnyo — "}{active.title}`. Use the explicit string expression, because JSX text that the formatter wraps loses its trailing space. Replace `{badge}` with `Plugin`.
   - In `BrowseHeroEngine.tsx` (symbol `ShowcaseHeroCarousel`): rename the export to `BrowseHeroCarousel`. Delete `ShowcaseHeroCopy`, `ShowcaseHeroComposerConfig` and the five config props. Import `BROWSE_ARCHETYPES`, `PLUGINS_BROWSE_DESCRIPTION` (from `@/components/plugin/plugins-collection-copy`) and `CREATE_PLUGIN_PROMPT` (from `@omnyo/client-core`). Add `const DRAFT_KEY = "plugins-browse-hero";`. Replace every `archetypes` use with `BROWSE_ARCHETYPES`, and every `copy.*` use with its literal from the old `PLUGIN_HERO_COPY`. Replace `composer.promptPrefix` with `CREATE_PLUGIN_PROMPT`, `composer.placeholder` with the literal placeholder, and `composer.draftKey` with `DRAFT_KEY`. Fix the hook dependency lists: the `promptDraft` memo deps become `[]`, and the open-request effect drops `composer.promptPrefix`. Module-scope values are not valid dependencies, and the lint rule may flag them. Remove the five props from the `<BrowseHeroFrame>` call. Keep `openRequest`'s inline type as the exported props type.
   - Delete the old wrapper `BrowseHeroCarousel.tsx`, then `git mv BrowseHeroEngine.tsx BrowseHeroCarousel.tsx`. `BrowsePluginsTab.tsx:21`, the test and the stories keep their import path `./BrowseHeroCarousel` or `@/components/plugin/browse-hero/BrowseHeroCarousel` unchanged.
   - Optionally, move `ShowcaseExampleCard` into `BrowseArchetypeCards.tsx` as a local component and delete `ShowcaseArchetypeCards.tsx`.
   - Rename the test at `BrowseHeroCarousel.test.tsx:44` to, for example, "renders the plugin hero copy". Keep every assertion.
5. **Clean up.** Confirm that the `apps/app/src/components/showcase-hero/` folder is gone and that `rg -n "showcase-hero|ShowcaseHeroCopy|ShowcaseHeroComposerConfig|ShowcaseHeroCarousel|ShowcaseFrame" apps packages plugins` returns nothing. `ShowcaseArchetype`, `ShowcaseScenes` and `ShowcaseExampleCard` may remain as type or component names if you did not rename them.
6. **Final check.** Run the verification below and read the full diff. It should contain only these moves and edits. Recount production lines with `wc -l apps/app/src/components/plugin/browse-hero/*.ts*`, excluding tests and stories, and compare with the baseline of 1,471 lines (725 + 746).

**Verification and acceptance criteria**

Commands. The scripts were confirmed in `apps/app/package.json` and the root `package.json` at the snapshot; they were not run, because the snapshot has no `node_modules`.

- Working directory `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/components/plugin/browse-hero src/components/plugin/management/BrowsePluginsTab.test.tsx src/components/create-via-prompt-examples.test.ts`. The `test` script is `vitest run --config vitest.config.ts`; the path filter is standard Vitest usage. Expected result: all tests pass, with the same assertions as the baseline.
- Working directory `apps/app`: `pnpm run typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). Expected result: no errors.
- Repository root: `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`, following the global Oxc routine. The `apps/app` `lint` script is `oxlint src ...`. Expected result: no warnings, and in particular no hook-dependency warnings.
- Visual check. In `apps/app`, run `pnpm run storybook` (`ladle serve`) and compare the `plugin/Browse Hero` stories with the baseline screenshots: the autoplaying story, the composing or open-request story, and reduced motion (toggle the operating-system setting). Check the frame title, which should read, for example, "Omnyo — Kanban board", with exactly one space after the dash. Check the "Plugin" badge, the three rail icons, the tablist keyboard (ArrowLeft, ArrowRight, Home and End) and the composer placeholder.
- Draft persistence. In the running app, type a draft into the Browse hero composer before the change, apply the change, reload, and confirm that the draft is restored. This proves that the `"plugins-browse-hero"` key survived. Alternatively, confirm by `rg -n '"plugins-browse-hero"' apps/app/src` that the string appears exactly once and is passed to both `getPromptDraftAccessor` and `PluginNewThreadComposer`.
- Structural completion: the `showcase-hero` folder and both config interfaces are gone; `BrowseHeroCarousel` and `BrowseHeroFrame` take no content props; `BrowsePluginsTab.tsx` is untouched.

**Rollback and stop conditions**

The change is a single commit confined to `apps/app/src/components/plugin/browse-hero/` and the deleted `showcase-hero/` folder. It changes no persisted format, API or published package. To undo it, revert that commit. Stop if any of the following happens:

- A consumer outside `plugin/browse-hero/` appears, or The owner confirms that a second hero (Skills, Automations or similar) is planned. In that case, keep the generic layer and delete only the duplicated config plumbing in `ShowcaseFrame`, or drop the item.
- Any visible string, aria label or the draft key differs from the baseline, and the difference cannot be fixed within the change.
- An import cycle appears between `BrowseHeroFrame`, `MiniAppScenes` and `browse-hero-archetypes`. In that case, keep `archetypes` and `scenes` as frame props, and remove only the copy and rail props.
- The focused test needs any assertion weakened. Treat that as a behaviour change, and investigate instead of editing the test.
