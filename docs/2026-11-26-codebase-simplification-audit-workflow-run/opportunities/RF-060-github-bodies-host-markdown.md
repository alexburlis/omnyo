# RF-060 — Render GitHub issue, comment and pull request bodies with the SDK host `Markdown` and delete the plugin's own `markdown-lite` renderer

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. One hand-written Markdown dialect (384 lines) disappears, and GitHub bodies join the renderer that chat messages, Side chat and Prompt library already use.
- **Confidence:** high that the duplication is real and that the swap is mechanically small; medium on how acceptable the visible differences are, because no side-by-side comparison has been made.
- **Readiness:** decision-needed. The swap changes how GitHub bodies look and how their links open (details below). Alex must accept the host renderer's look and link behaviour for the GitHub panel and PR tab.
- **Effort:** small. About 1 hour for the edit, tests and checks, plus about 1 hour for a visual comparison of 4 to 6 real issue and PR bodies.
- **Risk:** low to medium. The blast radius is one plugin's UI. No API, persisted data or protocol changes. The regressions to look for are visual (typography, image sizing, table alignment), link activation and a brief loading skeleton.
- **Prerequisites:** none in code. One owner decision (see the investigation gate in step 2).
- **Related or overlapping:** none in this audit. RF-094 (one CommonMark fence scanner in the markdown pipeline) touches the host renderer internals but not this swap; counts do not overlap.
- **Why it deserves its place:** it removes a whole parallel mechanism (a second Markdown parser with its own fixes), not just lines. The sweep's main worry, that raw `<img>` tags would stop rendering, is false at this snapshot: the host renderer renders sanitized raw HTML. That makes the swap a likely improvement for real GitHub bodies rather than a downgrade.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The named snapshot worktree was not present on disk, so every file was read with `git show <commit>:<path>` from the canonical repository store; `plugins/github` and the host Markdown files are unchanged between that commit and the local `main` HEAD `5f2d3f895` (checked with `git diff --stat`). No tests were run (no `node_modules` in the snapshot); all claims below are Proven by inspection unless labelled otherwise.

What the GitHub plugin does today:

- `plugins/github/components/markdown-lite.tsx:236` `Markdown({ content, className })` is a line-based, regex-driven renderer. It handles fenced code (`:256`), ATX headings capped to three styles (`:279`, `HEADING_CLASSES` at `:230`), GFM tables with alignment and escaped pipes (`parseTable` `:178`, `splitTableRow` `:133`), flat `-` lists only (`:344`) and paragraphs with `whitespace-pre-wrap` (`:377`). Inline handling (`INLINE_PATTERN` `:4`, `renderInline` `:36`) covers code spans, `**bold**`, `*italic*`, `[label](url)` links through the SDK `UrlLink` with `target="_blank"` (`:86`), Markdown images and raw `<img>` tags, both limited to `http(s)` sources (`renderImage` `:13`, check at `:21`).
- Size: `wc -l plugins/github/components/markdown-lite.tsx` = 384 lines (318 non-blank, `grep -cv '^\s*$'`). Test: `plugins/github/components/markdown-lite.test.tsx` = 87 lines, three cases: GFM table markup, alignment plus escaped pipes, and a `target="_blank"` link that does not call host navigation.
- Only consumer: `plugins/github/app.tsx:56` `import { Markdown } from "./components/markdown-lite.js";`, used at `:1220` (issue body), `:1246` (issue comments), `:1577` (review-thread comments in `ReviewThreadCard`), `:1635` (PR timeline reviews and comments) and `:1800` (PR body), always as `<Markdown content={...} className="text-sm" />`. Search: `git grep -n -i "markdown-lite" <commit>` over the whole tree returns only `plugins/github/app.tsx:56` and the component and its test. No docs, manifest, build script, `scripts/forkable-plugins.json` entry or bundle test names the file. `plugins/github/package.json` `files` ships the `components` directory, which still holds `empty-state.tsx` after the deletion.

What the host already offers:

- `packages/plugin-sdk/src/app.ts:145` `export const Markdown = runtimeComponent("Markdown");` with props `MarkdownProps { content; className?; experimental_document? }` at `packages/plugin-sdk/src/app-contract.ts:4080`. The contract describes it as "Omnyo's chat message renderer".
- Host implementation: `apps/app/src/components/plugin/LazyPluginMarkdown.tsx` (`defineSplit` id `plugin-markdown`, a two-line `Skeleton` with `role="status"` while the chunk loads) loading `apps/app/src/components/plugin/PluginMarkdown.tsx` `PluginMarkdown`, which renders `<MarkdownPreview allowHtml ... linkRouting={...} />`.
- Raw HTML: `MarkdownPreview` (`apps/app/src/components/ui/markdown-preview.tsx:2257` `mayRenderHtml = allowHtml && content.includes("<")`) routes HTML-bearing content through `apps/app/src/components/ui/markdown-html.tsx` `MARKDOWN_HTML_REHYPE_PLUGINS` = `rehype-raw` plus `rehype-sanitize` with the `hast-util-sanitize` default (GitHub-derived) schema extended with `video` and Omnyo mention tags. The default schema keeps `<img src alt width height>`, `<details>`, `<summary>` and similar, allows only `http`/`https` image sources, and drops HTML comments. **This corrects the sweep report**, which concluded from a failed search that raw HTML is not rendered.
- The host renderer uses `remark-gfm` (`markdown-preview.tsx:42`, `:2385`), so ordered and nested lists, blockquotes, task lists, strikethrough and bare-URL autolinks render. Images go through `MarkdownRenderedImage` (`markdown-preview.tsx:1399`), which adds click-to-zoom and, when no width and height are given, an `aspect-video w-full` box.
- Existing SDK users with the same call shape: `plugins/prompt-library/app.tsx:555` `<Markdown content={content} className="text-sm" />`, `plugins/side-chat/app.tsx:220`, `plugins/inline-vis/app.tsx:751`.
- Test stand-in: `packages/plugin-sdk/src/testing/app.tsx:932` `TestMarkdown` renders `<div data-testid="omnyo-markdown" className={className}>{content}</div>`, so plugin tests can assert what was passed without the real renderer.
- SDK floor: the github manifest declares `"omnyoPluginSdk": ">=0.4.102 >=0.6.44"`. In the private history store (`$ARCHIVED_OMNYO_CHECKOUT`), the `Markdown` export arrived in `db500967a4` (2026-09-22) at SDK version 0.5.16, and 0.6.44 arrived in `83fd816e5f` (2026-11-02). The floor already covers `Markdown`, matching the rule in `docs/forkable-plugins.md:97`. Side chat uses `Markdown` with the same `>=0.6.44` second term.
- Forkability: the SDK is the sanctioned shared dependency, so dropping a plugin-local file in favour of an SDK runtime component keeps the plugin independently forkable.

Maintenance cost today (Proven by inspection from private history): the renderer needed a dedicated fix, `42b4b5a9f9` "Fix GFM table rendering in GitHub PR descriptions" (2026-08-07); its other edits were cross-cutting sweeps (lint, comments, forkability import paths). The 2026-09-23 forkability change `2b56c6561d` only changed an import in it and records no reason for keeping a separate renderer.

Current requirement that explains the code: readable issue, comment and PR bodies, including tables and screenshots, in the GitHub nav panel and the PR thread tab. When markdown-lite was written, no SDK Markdown existed; that reason no longer holds.

Known gaps in markdown-lite that GitHub bodies hit (Proven by inspection, not executed; recorded as an incidental issue, not as a goal of this card): HTML comments from PR templates (`<!-- ... -->`), `<details>`/`<summary>`, ordered lists, nested lists, blockquotes, task-list checkboxes and bare URLs all render as literal text, because nothing in `renderInline` or the block loop matches them and React escapes the text.

**Proposed end state and preservation argument**

End state:

- `plugins/github/app.tsx` imports `Markdown` from `@omnyo/plugin-sdk/app` in its existing SDK import block (`app.tsx:2-14`) and keeps all five call sites and their `className="text-sm"` unchanged.
- `plugins/github/components/markdown-lite.tsx` and `plugins/github/components/markdown-lite.test.tsx` are deleted.
- The host's `PluginMarkdown` is the one renderer for GitHub bodies, chat messages and other plugin quotes.

What stays the same: the props (`content`, `className`), the "(no description)" empty states (they are in `app.tsx`, outside the renderer), data fetching and the RPC contract, the plugin manifest and SDK floor, and safety (only `http(s)` images; scripts and event handlers stripped by `rehype-sanitize`).

What intentionally changes, and needs the owner's acceptance:

| Surface | Today (markdown-lite) | After (host Markdown) |
| --- | --- | --- |
| Typography and spacing | Plugin-local classes (`space-y-3`, own heading sizes, `whitespace-pre-wrap` paragraphs) | Chat message typography; single newlines inside a paragraph collapse as in CommonMark |
| Raw HTML | Only `<img>`; everything else shown as literal text | Sanitized HTML: `<img>`, `<details>`, `<summary>`, `<br>` and similar render; comments disappear |
| Lists, quotes, task lists, autolinks | Flat `-` lists only; the rest literal text | Full GFM |
| Images | `inline-block`, rounded border, natural size | Click-to-zoom, max height `max(384px,50vh)`; `aspect-video w-full` box when the source gives no width and height |
| Tables | Bordered grid, header alignment classes | Host table styling; alignment must be checked in the comparison |
| Link activation | `UrlLink` with `target="_blank"`: native new tab, no host navigation call (asserted by `markdown-lite.test.tsx` "leaves explicitly targeted markdown links native") | `navigation.openUrl` through the app navigation host, the same as chat links. In the PR thread tab, `ThreadTimelineNavigationProvider` (`apps/app/src/views/thread-detail/ThreadDetailView.tsx:3412`) also makes relative links and images resolve against the thread's workspace |
| First render | Synchronous | A two-line skeleton until the shared `plugin-markdown` chunk loads, once per app session |

Why this is the simplest sufficient option: it is a one-import swap onto an existing, tested, host-owned capability. Alternatives considered and rejected: (a) patch markdown-lite to handle comments, `<details>` and lists, which grows the duplicate instead of removing it; (b) move markdown-lite into shared-ui, which moves code without deleting a mechanism and still leaves two dialects.

Non-goals: no GitHub-specific enrichment (issue references such as `#123`, `@mentions`, commit SHA links); neither renderer does that today. No change to the host renderer.

Reachability proof for the deletion: the component is a module-local export of a plugin; the plugin is built from `plugins/github/app.tsx` (`omnyo.app` in `package.json`); the only importer is `app.tsx:56` (search above). It is not part of the SDK or any published contract, so no external plugin or older client can import it. Remaining uncertainty: none for reachability; the open question is only visual acceptance.

**Expected gain and cost**

- Handwritten production code: 384 lines removed (`markdown-lite.tsx`), net change in `app.tsx` of about 0 to -1 line (one import line removed, `Markdown,` added to the existing SDK import list). Net about -383 production lines. Additions: none in production.
- Tests: -87 lines (`markdown-lite.test.tsx`). Optional addition of about 15 to 25 lines in `plugins/github/app.test.tsx` asserting that issue and PR bodies reach the host `Markdown` with `className="text-sm"`.
- Mechanisms: before, two Markdown parsers in the product (host `MarkdownPreview` and GitHub's `markdown-lite`), each with its own rules and fixes. After, one. One plugin-local alias use (`@/lib/utils` `cn`) in that file also goes away.
- Maintenance example: before, a GitHub body feature gap (such as the 2026-08-07 table fix, or today's literal `<!-- -->` comments) needs a hand-written parser change inside the plugin. After, the GitHub panel inherits every fix to the chat renderer, and the plugin has no parser to maintain.
- Bundle: the GitHub plugin bundle loses the renderer (Hypothesis: a few KB minified). The host `plugin-markdown` chunk is shared with other plugins and is likely already loaded in sessions that open chats (Hypothesis, not measured).
- Performance: uncertain. The host pipeline (remark-gfm, math detection, rehype-raw and sanitize for HTML-bearing bodies) costs more CPU per body than a regex pass, and a PR with many comments renders one instance per comment. Measure before accepting (see verification).

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of current `main`, run `git grep -n "markdown-lite"` and `git grep -n "<Markdown" -- plugins/github`. Expect exactly the five call sites in `plugins/github/app.tsx` and the import at the top. Confirm `packages/plugin-sdk/src/app.ts` still exports `Markdown`, `apps/app/src/components/plugin/PluginMarkdown.tsx` still passes `allowHtml`, and `apps/app/src/components/ui/markdown-html.tsx` still uses `rehype-raw` with `rehype-sanitize`. Stop and re-plan if `allowHtml` was removed from `PluginMarkdown` (raw `<img>` would then stop rendering) or if markdown-lite gained a second consumer.
2. **Investigation gate: owner decision (required before step 3).** Collect 4 to 6 real bodies from repositories Alex uses: a PR description with a GFM table and aligned columns, a body with a pasted screenshot as `<img width=... height=... src=...>`, one with `![alt](url)`, one generated from a PR template with `<!-- -->` comments and a `- [ ]` task list, one with `<details>`, and an issue with 10 or more comments. Render them in the GitHub panel before and after the swap (the after build can be a local, uncommitted change) and capture paired screenshots for the nav panel issue view and the PR thread tab, light and dark theme. Present the comparison table from the end-state section plus the screenshots to Alex and ask: accept chat typography, click-to-zoom images and host link opening (instead of a native new tab) for GitHub bodies? If he declines any row, stop; see the stop conditions.
3. **Swap the import.** In `plugins/github/app.tsx`, delete line 56 `import { Markdown } from "./components/markdown-lite.js";` and add `Markdown` to the existing named import from `@omnyo/plugin-sdk/app` (lines 2-14), keeping the list's existing order convention. Leave all five `<Markdown content={...} className="text-sm" />` call sites unchanged.
4. **Delete the duplicate.** Remove `plugins/github/components/markdown-lite.tsx` and `plugins/github/components/markdown-lite.test.tsx`. Keep `plugins/github/components/empty-state.tsx`; the `components` entry in `package.json` `files` stays.
5. **Keep a contract test in the plugin (optional but recommended).** In `plugins/github/app.test.tsx`, extend an existing issue-detail or PR test that uses the fake `gh` fixture (`plugins/github/testing/fake-gh.ts`) so that a non-empty body is returned, then assert `getAllByTestId("omnyo-markdown")` contains that body text and has class `text-sm`. This replaces the three deleted renderer tests with the plugin-side obligation that still exists (bodies reach the renderer). Table, alignment and HTML behaviour are the host renderer's obligation and are covered by `apps/app/src/components/ui/markdown-preview.test.tsx`; do not duplicate them in the plugin.
6. **Clean up.** Run `git grep -n "markdown-lite"` again (expect no hits). Check `plugins/github/README.md` and `plugins/github/PLUGIN_OVERVIEW.md` for any wording about how bodies render and update it if present (none found at the snapshot). Format the changed file with the repository formatter.

Checkpoint after step 4: the plugin typechecks, lints and its tests pass. Checkpoint after step 5: the new assertion fails if the import is pointed back at a stub that drops `className`.

**Verification and acceptance criteria**

Commands (scripts confirmed in `plugins/github/package.json` and the root `package.json` at the snapshot; not executed during this audit):

- `cd plugins/github && pnpm typecheck` (`tsc --noEmit`). Expect success.
- `cd plugins/github && pnpm lint` (`oxlint --ignore-pattern node_modules --ignore-pattern dist .`). Expect no findings.
- `cd plugins/github && pnpm test` (`vitest run --config vitest.config.ts`). Expect all tests to pass, including `app.test.tsx` with the new body assertion. Per `docs/forkable-plugins.md`, the plugin test task depends on `@omnyo/plugin-sdk#build`; if vitest cannot resolve the SDK, run `pnpm --filter @omnyo/plugin-sdk build` from the repository root first.
- `cd plugins/github && pnpm build` (runs `scripts/build-official-plugins.mjs github`). Expect the bundle to build without the deleted module.
- From the repository root: `pnpm exec oxfmt plugins/github/app.tsx plugins/github/app.test.tsx`, then `pnpm format:check` (`oxfmt . --check`) limited in review to the changed files.
- From the repository root: `pnpm check:plugin-forks` (`node scripts/check-plugin-forks.mjs`), to confirm the github plugin still builds as a fork.

Behaviour and UI acceptance:

- The paired before/after screenshots from step 2 are accepted by Alex. In the after state, confirm: tables render as tables with the correct column alignment; `<img>` screenshots render at the given width and height; `![alt](url)` images render; PR-template comments are invisible; `- [ ]` items render as checkboxes; `<details>` collapses; empty bodies still show "(no description)".
- Links: in the nav panel, clicking a body link opens the URL through the host's normal URL handling (same as a chat link). In the PR thread tab, also check one relative link (for example `[readme](README.md)`) and record what happens; it now resolves against the thread workspace.
- Loading: on a cold app load, opening an issue shows the two-line Markdown skeleton at most briefly, then the body; there is no layout jump larger than the body itself.
- Performance: on the same machine and build, open a PR with a long description and 30 or more comments before and after the change and record time to first full render (for example with the React Profiler or a performance trace). Accept only if Alex considers any difference acceptable; there is no existing budget for this panel.

Structural completion: `git grep -n "markdown-lite"` returns nothing; `plugins/github/app.tsx` has no local Markdown import; only the host renderer remains.

**Rollback and stop conditions**

- Rollback boundary: one commit touching `plugins/github/app.tsx`, the two deleted files and optionally `plugins/github/app.test.tsx`. Reverting that commit restores the old renderer exactly. No data, settings, protocol or SDK compatibility implications.
- Stop if Alex rejects the visual or link behaviour change in step 2. The smaller alternative is to keep markdown-lite and fix only the literal-text issue (strip HTML comments) as a separate bug fix; that is not a simplification and should be tracked as the incidental issue, not under this card.
- Stop if link activation through the host is unacceptable but the rest is accepted. Then the next investigation is whether `MarkdownProps` should gain an SDK-level option for native external links; that is an SDK contract change and needs its own decision, not a plugin-local workaround.
- Stop if the measured render time of a long PR is clearly worse and Alex considers it noticeable. Investigate host renderer cost for many small instances before retrying.
- Stop and re-plan if step 1 finds that `PluginMarkdown` no longer passes `allowHtml`, or that markdown-lite gained another consumer.
