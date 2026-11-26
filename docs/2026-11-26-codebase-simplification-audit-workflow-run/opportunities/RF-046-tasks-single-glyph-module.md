# RF-046 — Replace the Tasks plugin's three StatusIcon and PriorityIcon copies with one glyph module

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict after adversarial verification:** adjusted. The duplication and the drift are real. Two parts of the sweep report were wrong or incomplete: the "knockout surface" difference (`var(--background)` against `var(--canvas)`) is not visible under any built-in theme, so no surface prop is needed; and the sweep missed that the board copy already matches the per-attribute majority of the three copies, which makes it the natural canonical candidate.
- **Potential:** low. This is presentational knowledge duplicated inside one plugin. The change removes about 320–330 handwritten production lines and two of three glyph definitions, but no state, contract or cross-package coupling.
- **Confidence:** high. All three copies, all 9 consumer files and the token values were read at the snapshot.
- **Readiness:** decision-needed. Alex must choose one glyph set. Any choice changes pixels on at least one surface, because the copies have drifted in four visible ways (see the decision table below).
- **Effort:** small, about 1–3 hours including a visual pass over list, board, detail rail and chat embed in light and dark.
- **Risk:** low. Only rendered SVG/HTML changes. No API, persisted data, plugin SDK export or test contract is involved.
- **Prerequisites:** the owner's glyph decision (Step 2). Nothing else.
- **Related or overlapping RF ids:** none. RF-069, RF-071 and RF-125 also touch `plugins/tasks` but not these files.
- **Why it deserves its place:** The plugin draws the same status of the same task three different ways depending on the view, and every future glyph or tone change has to be made three times in three code styles. The change is cheap and local, but it is a quick win rather than a structural reduction, so it belongs low in the ranking.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only worktree named in the audit brief had been removed, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. The snapshot has no `node_modules`; no test, typecheck or Ladle run was possible.

The Tasks plugin (`plugins/tasks`, package `omnyo-plugin-tasks`) shows a task's status (backlog, todo, in progress, in review, done, canceled; `TaskStatus` in `plugins/tasks/shared/contract.ts`) and priority (none, low, medium, high, urgent; `TaskPriority`) as 14×14 glyphs in its list, board, detail and chat-embed views. Three files each define their own `StatusIcon` and `PriorityIcon`.

Observed facts (Proven by inspection):

| Copy | Location | Lines | Consumers |
|---|---|---|---|
| List | `plugins/tasks/views/list/icons.tsx` `STATUS_COLOR_CLASS` :4, `StatusIcon` :13, `ACTIVE_BARS` :81, `PriorityIcon` :88 | 154 (whole file) | `views/list/filter-bar.tsx:17` (uses at :177, :207 with `className="size-3"`), `views/list/property-menus.tsx:33` (:151, :176, :213, :238, :279, :293, :309, :323), `views/list/status-group.tsx:10` (:55), `views/embed/index.tsx:19` (:204, :266, :286) |
| Board | `plugins/tasks/views/board/icons.tsx` `STATUS_CLASS` :4, `statusArtwork` :13, `StatusIcon` :94, `PRIORITY_LIT_BARS` :113, `PriorityIcon` :120 | 179 (whole file) | `views/board/index.tsx:31` only (:383 priority on cards, :787 status in column headers) |
| Detail | `plugins/tasks/views/detail/meta.tsx` `STATUS_COLORS` :10, `StatusIcon` :19, `PriorityIcon` :99–155 | 146 (lines 10–155), plus the `TaskPriority`, `TaskStatus` and `cn` imports at :2, :4, :8 that only the glyphs use | `views/detail/rail.tsx:15-16` (:99, :106, :131, :141), `views/detail/sections.tsx:4` (:116, :136), `views/detail/index.tsx:21` (:371 with `className="size-3"`) |

Line counts: `git show <commit>:<file> | wc -l` gives 154, 179 and 249 for the three files; lines 10–155 of `meta.tsx` hold the glyph code. Total glyph code: 154 + 179 + 146 = 479 handwritten production lines. (The sweep said 477 because it ended the detail range at line 153; `PriorityIcon` closes at line 155.)

`meta.tsx` also owns `THREAD_STATUS_META` :157, `PR_STATE_META` :188, `isActiveThread` :214, `formatRelativeTime` :218 and `formatDueDate` :238. Those are not glyphs and stay. `views/board/index.tsx:32` and `views/list/data.ts:17` import `isActiveThread` from `meta.js`, and `views/detail/threads.tsx:16` imports other `meta.js` exports; none of them import the glyphs.

How the copies differ (Proven by inspection, comparing the three files line by line):

| Attribute | List | Board | Detail | Visible today? |
|---|---|---|---|---|
| Neutral tone (backlog, todo, canceled) | `text-subtle-foreground` | `text-muted-foreground` | `var(--muted-foreground)` inline | Yes. `apps/app/src/components/ui/theme.css:762-763` sets `--muted-foreground` L 0.44 and `--subtle-foreground` L 0.50 in light, and :1037-1038 sets 0.78 and 0.68 in dark, so the list glyphs are lower contrast in both themes. Board and detail match each other, because `--color-muted-foreground: var(--muted-foreground)` (:36). |
| Colour mechanism | `currentColor` from a class | `currentColor` from a class | Inline `stroke`/`fill` | No. No caller passes a colour class (all `className` arguments are `size-3`). |
| In-review glyph | wedge arc `A4.6 4.6 0 1 1 6.99 2.4`: an almost full disc | same as list | `A4.6 4.6 0 1 1 2.4 7`: a three-quarter wedge | Yes. With the in-progress wedge at about one third (arc to `11.2 9.5`), detail reads one third, three quarters, full; list and board read one third, nearly full, full. |
| Done/canceled knockout | `var(--background)` | `var(--canvas)` | `var(--canvas)` | No under built-in themes: `theme.css:739` and :1019 define `--background: var(--canvas)`, and the bundled themes in `apps/app/src/lib/themes/*.ts` set only `--canvas` (search: `git grep -n -E -- '--background\s*:|--canvas\s*:' <commit> -- '*.css' '*.ts' '*.tsx'`). A user-authored theme that set `--background` separately could make them differ (Hypothesis; the theme-authoring skill at `plugins/theme-preview/skills/omnyo-theme-authoring/SKILL.md:60` names `--canvas` as the anchor). |
| Urgent glyph | SVG, `text-warning`, 13×13 rect inset 0.5, `rx 3`, bar as a 1.6×5.2 rect, dot r 1 | SVG, `fill-warning`, full 14×14 rect, bar as a stroked path of width 1.8, dot r 1.1 | HTML `span`, `rounded-xs bg-warning`, a font-rendered `!` in `text-2xs font-extrabold` | Yes, all three differ; detail differs most. |
| Priority bars | x 1.5 / 5.5 / 9.5, baseline y 13 | same as list | x 1.5 / 6 / 10.5 (`1.5 + index * 4.5`), baseline y 12.5 | Yes, a half-pixel shift that is slight at 14 px. |
| `data-status-icon` / `data-priority-icon` | none | on every SVG | none | No consumers: `git grep -n -E 'data-(status|priority)-icon|dataStatusIcon' <commit>` matches only the three definitions in `board/icons.tsx`. |

Per attribute, the board copy matches the majority: muted tone (board and detail), near-full in-review disc (list and board), 1.5/5.5/9.5 bars on a y 13 baseline (list and board), an SVG urgent glyph (list and board), and `var(--canvas)` (board and detail).

Non-obvious consumers checked:

- Tests and stories: `git grep -n -E 'svg|"!"|>!<|urgent|aria-hidden|opacity-40|fill-' <commit> -- 'plugins/tasks/**/*.test.*' 'plugins/tasks/*.stories.*'` finds no glyph geometry, colour or `!` assertion. The one structural check is `plugins/tasks/views/embed/embed.test.tsx:114`: with priority `none`, the embed contains exactly one `svg`. It holds under any choice, because the embed omits the priority glyph when priority is none (`views/embed/index.tsx:280`). `views/detail/rail.test.tsx` makes no status or priority assertions.
- Cross-package imports: `git grep -n -E 'views/(list/icons|board/icons|detail/meta)' <commit>` finds nothing outside `plugins/tasks`. The plugin's published entry points are `server.ts` and `app.tsx` (`plugins/tasks/package.json` `omnyo` block); the glyphs are not part of any SDK or plugin-SDK export.
- Shared-UI descendant styling: `packages/shared-ui/src/components/ui/dropdown-menu.tsx` and `button.tsx` have no `[&_svg…]` rules, so moving the detail urgent glyph from a `span` to an `svg` picks up no extra menu or button styles.
- Forkability (`docs/forkable-plugins.md`): the new module lives inside the Tasks plugin, so no sibling-plugin import and no SDK change is needed.
- History: `git log <commit> -- <the three files>` shows only the squashed `060950255 Publish Omnyo source`, and `PLUGIN_OVERVIEW.md` and `README.md` say nothing about glyphs, so no recorded intent explains any difference.

Maintenance cost today: changing a glyph, a tone or the urgent mark means three edits in three styles (conditional JSX, a `switch`, inline colours). The `Record<TaskStatus, …>` colour maps make TypeScript flag a new status in all three maps, but nothing makes the three drawings agree, and they already disagree in four visible ways.

**Proposed end state and preservation argument**

End state:

- One module, `plugins/tasks/components/task-glyphs.tsx`, exports `StatusIcon({ status, className })` and `PriorityIcon({ priority, className })` with today's signatures. `plugins/tasks/components/` already holds the plugin's cross-view pieces (`empty-state.tsx`, `hint.tsx`, `working-dot.tsx`).
- `views/board/icons.tsx` and `views/list/icons.tsx` are gone. `views/detail/meta.tsx` keeps only `THREAD_STATUS_META`, `PR_STATE_META`, `isActiveThread`, `formatRelativeTime` and `formatDueDate`.
- All 9 consumer files import the glyphs from `../../components/task-glyphs.js`.
- No variant prop. The knockout token is the only true "surface" difference, and it renders identically under built-in themes, so one token (`var(--canvas)`) serves every view.
- The SVG keeps `aria-hidden`, the `size-3.5 shrink-0` default size and `className` merging through `cn`, so callers' `size-3` overrides and their surrounding labels, `title` attributes and `sr-only` text keep working unchanged.

Decision for Alex. The default is the board look, because it already matches the majority on every attribute, so it changes the fewest pixels:

| Attribute | Default (board look) | Alternative | Pixels that change under the default |
|---|---|---|---|
| Neutral tone | `text-muted-foreground` | `text-subtle-foreground` (list) | List rows, filter bar, status groups, property menus and chat embed get higher-contrast backlog, todo and canceled glyphs. |
| In-review glyph | near-full disc | three-quarter wedge (detail), which reads as a clearer step between in progress and done | Detail rail, sub-task list and parent link switch from the wedge to the disc. If Alex picks the wedge, list, board and embed change instead. |
| Urgent glyph | board SVG | list SVG (inset rect) or detail `!` span | List and embed change slightly; the detail rail changes from a font-rendered `!` to the SVG mark. |
| Priority bars | x 1.5 / 5.5 / 9.5, baseline 13 | detail geometry | Detail rail bars move by half a pixel. |
| Board `data-*` attributes | dropped (no consumer) | keep | None. |

What stays the same: status and priority values and labels, every accessible name (the glyphs are `aria-hidden`, and the labels and `sr-only` text live in the callers), menu shortcuts, sizes, layout and every non-glyph element of each view.

Non-goals: no change to `TASK_STATUSES`, `TASK_PRIORITIES`, `STATUS_LABELS`, `PRIORITY_LABELS`, `THREAD_STATUS_META`, the shared-ui `StatusDot`, or any other plugin. Do not restyle anything near a glyph.

Why this is the simplest sufficient option: a shared module with no props replaces three. Keeping three copies and only syncing their values would still leave three drawings to keep in step. A variant prop would keep the drift alive under a new name.

**Expected gain and cost**

- **Handwritten production lines (projection):** about 325 deleted (board file 179, detail glyph block 146, plus 2–3 now-unused import lines in `meta.tsx`). The list file's 154 lines move to `components/task-glyphs.tsx`; moved code is not counted as removed. Its contents are edited toward the chosen look, which takes a few lines either way. The 9 consumer files change one import line each, and `rail.tsx` gains one import line. **Net: about −320 to −330 lines.**
- **Tests, generated code, docs, assets:** none removed or added.
- **Mechanisms:** three glyph definitions and three tone maps become one of each. Two near-identical priority-bar tables (`ACTIVE_BARS`, `PRIORITY_LIT_BARS`) and the inline ternary chain become one table.
- **Maintenance:** changing the in-review glyph, the urgent mark or a tone takes one edit in one file instead of three edits in three styles. Adding a status keeps TypeScript's exhaustiveness check on a single map.
- **User-visible effect:** the same task looks the same in every Tasks view. That is a deliberate visual change on the surfaces the owner's choice does not keep.
- **Performance:** neutral; the same number of SVG elements renders per glyph. The detail urgent glyph changes from a text node to SVG shapes, which makes no measurable difference.
- **Cost:** about 1–3 hours, most of it the visual pass.

**Execution steps**

1. **Reconfirm the baseline.** In the checkout you will edit, confirm that `plugins/tasks/views/list/icons.tsx`, `plugins/tasks/views/board/icons.tsx` and `plugins/tasks/views/detail/meta.tsx` still contain the symbols cited above, and rerun `rg -n 'StatusIcon|PriorityIcon' plugins/tasks` from the repository root. Stop and re-plan if a consumer outside `plugins/tasks` now imports these glyphs, if a test now asserts glyph geometry or colour, or if a product note now explains one of the differences.
2. **Decision gate (do not edit before this).** Get the owner's answer on the four rows of the decision table: neutral tone, in-review glyph, urgent glyph, bar geometry. If he gives no preference, use the board look. Record the choice in the commit message.
3. **Create the module (mechanical move).** Move `views/list/icons.tsx` to `plugins/tasks/components/task-glyphs.tsx` with `git mv`, so the move stays visible in history. Fix its relative import to `../shared/contract.js` (from `../../shared/contract.js`). Keep `import { cn } from "@/lib/utils"`.
4. **Apply the chosen look (semantic edit, separate from the move).** In `task-glyphs.tsx`:
   - Set `STATUS_COLOR_CLASS` neutral entries to the chosen token (default `text-muted-foreground`).
   - Replace both `stroke="var(--background)"` knockouts and the urgent `fill="var(--background)"` values with `var(--canvas)`.
   - Set the `in_review` wedge path to the chosen arc (default keeps `M7 7 L7 2.4 A4.6 4.6 0 1 1 6.99 2.4 Z`; the wedge alternative is `M7 7 L7 2.4 A4.6 4.6 0 1 1 2.4 7 Z`).
   - Replace the urgent branch with the chosen artwork. The default copies the board's branch from `views/board/icons.tsx:127-145`: `<rect width="14" height="14" rx="3" className="fill-warning" />`, the stroked path `M7 3.2v4.4` with width 1.8, and the circle at r 1.1, all knocked out with `var(--canvas)`. Do not copy the `data-priority-icon` attribute.
   - Keep the bar table at x 1.5 / 5.5 / 9.5 on baseline 13 unless Alex chose the detail geometry. In that case use `x = 1.5 + index * 4.5` and `y = 12.5 - height`.
5. **Repoint the consumers.** Change the import to `../../components/task-glyphs.js` in `views/list/filter-bar.tsx`, `views/list/property-menus.tsx`, `views/list/status-group.tsx`, `views/embed/index.tsx`, `views/board/index.tsx` (line 31 only; keep line 32's `isActiveThread` import), `views/detail/index.tsx`, `views/detail/sections.tsx` and `views/detail/rail.tsx`. In `rail.tsx`, remove `PriorityIcon` and `StatusIcon` from the `./meta.js` import (keep `formatDueDate` and `isActiveThread`) and add a separate import from the new module. Change no call site's props.
6. **Delete the superseded copies.** Delete `views/board/icons.tsx`. In `views/detail/meta.tsx`, delete lines 10–155 (`STATUS_COLORS`, `StatusIcon`, `PriorityIcon`), the now-unused `TaskPriority` and `TaskStatus` type imports and `import { cn } from "@/lib/utils"`. Keep the `IconName` import, which `PR_STATE_META` uses.
7. **Checkpoint.** Run `rg -n 'StatusIcon|PriorityIcon|data-status-icon|data-priority-icon|views/board/icons|list/icons' plugins/tasks`. Expect hits only in `components/task-glyphs.tsx` and the 9 consumer files, and no other glyph definitions. Then run the verification below.
8. **Format and recount.** Format only the changed files (see Verification), check that the diff has nothing unrelated, and recount with `git diff --stat` against the baseline commit. Expect about 320–330 net production lines removed.

**Verification and acceptance criteria**

Commands (scripts confirmed in `plugins/tasks/package.json`, `apps/app/package.json` and the root `package.json` at the snapshot; not run here because the snapshot has no `node_modules`):

- Typecheck, from the repository root: `pnpm --filter omnyo-plugin-tasks typecheck` (`tsc --noEmit`). Expect it to pass, which proves every import resolves and no call site's props changed.
- Focused tests, from the repository root: `pnpm --filter omnyo-plugin-tasks test -- views/embed views/detail views/list` (the script is `vitest run --config vitest.config.ts`; passing file filters after `--` is standard Vitest usage but was not run here). Expect them to pass unchanged, including `views/embed/embed.test.tsx:114`. Do not edit any assertion to make them pass.
- Lint, from the repository root: `pnpm --filter omnyo-plugin-tasks lint`. Format only the changed files with `pnpm exec oxfmt <changed files>` (the root `format` script is `oxfmt .`; do not format the whole repository).
- Visual pass (Alex tests UI changes himself, so hand this over with the list of affected places). Run `pnpm storybook` from the root (`turbo run storybook --filter=@omnyo/app`, which serves `../../plugins/tasks/*.stories.tsx` according to `apps/app/.ladle/config.mjs:48`). The stories `ListGroups`, `ListRowsNarrow` and `DetailSubTasks` in `plugins/tasks/tasks.stories.tsx` cover status-group headers, rows and the sub-task list. No story covers the board, the detail rail menus, the filter bar or the chat embed, so check those in the running app. In light and dark, compare every status and every priority (including urgent) against the chosen look. Only the glyph pixels named in the decision table may change.
- Structural completion: exactly one `StatusIcon` and one `PriorityIcon` definition remain in `plugins/tasks` (`rg -n 'export function (StatusIcon|PriorityIcon)' plugins/tasks` returns 2 lines, both in `components/task-glyphs.tsx`); `views/board/icons.tsx` and `views/list/icons.tsx` no longer exist; `views/detail/meta.tsx` contains no SVG.

**Rollback and stop conditions**

- Rollback boundary: one commit that touches only `plugins/tasks`. Reverting it restores the three copies exactly. No data, migrations or compatibility surfaces are involved.
- Stop if Alex wants each view to keep its current look. The only honest consolidation then is a variant prop per drifted attribute, which keeps the drift under another name. In that case drop the opportunity, or share only the shapes that are already identical, which is a much smaller gain.
- Stop if Step 1 finds a consumer outside `plugins/tasks`, such as a fork in `$OMNYO_PLUGIN_CHECKOUT` that imports these paths, or a test that encodes glyph geometry. Re-plan around that consumer.
- Stop if a supported user theme is found that sets `--background` apart from `--canvas` and the knockout visibly changes. In that case pick the token that matches the surface the glyphs sit on, and re-check board cards and list rows.
