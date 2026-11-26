# RF-048 — Define the Explore catalog vocabulary and keyword search once, in `@omnyo/domain/explore`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and byte-identical, but the sweep reports overstated its size. Only the vocabulary, the item types and the term-matching core can be shared. The per-filter field rules differ between the website and the SDK and must stay where they are. The marketplace item interfaces should not be shared yet (see the non-goals).
- **Potential:** low. About 45–70 net handwritten production lines disappear. The more important gain is that the Explore kinds, the nine categories, the 80-character query rule and the keyword-match rule each get one definition instead of two or three.
- **Confidence:** high. The duplicated blocks were byte-compared (Reproduced, see Context).
- **Readiness:** ready. Both sweep reports called this conditional on choosing a shared home. The home is not an open decision: `@omnyo/domain` is already a dependency of both sides, the website already imports two pure `@omnyo/domain` subpaths, and the website image already copies `packages/domain/src`.
- **Effort:** small, about half a day to one day including typechecks, the explore tests in three packages, a web build and a CLI build.
- **Risk:** low. All shared code is pure and synchronous. The realistic regressions are a change to website search results (for example, if a website-only `source`/`license` filter or the website's truthy-filter semantics were folded into shared code) and a larger website client bundle (if the shared module imported zod or SDK code).
- **Prerequisites:** none.
- **Related and overlapping items:**
  - **RF-049** ("Validate the SDK Explore catalog with zod and infer its types") touches the same SDK types. Do RF-048 first. RF-049 should then type its schema against the domain interfaces, for example `const exploreItemSchema: z.ZodType<ExploreItem> = …`, instead of inferring a second `ExploreItem` definition. If RF-049 lands first, step 3 below must import the interfaces it produced, or re-plan.
  - RF-063 (typed public route table) may touch the same website route files, but it does not touch the definitions here.
  - Another card in this directory, `RF-001-explore-catalog-contract.md`, comes from a separate numbering pass and covers the same mechanism. Treat it as a duplicate of this card, and count the savings once.
- **Why it deserves its place:** this is a cheap, safe and complete consolidation of duplicated wire-format knowledge. At present a parity test exists only to catch drift between two copies of the same rules. It ranks below the large dead-machinery retirements because the line gain is modest.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26), read with `git show <commit>:<path>`. The snapshot worktree named in the audit brief no longer existed. The Explore files are unchanged between that commit and the later local checkout, except for three test lines in `catalog.test.ts` and `pages.test.tsx`.

*What the subsystem does.* The public website (`apps/web`) renders `/explore` and serves three JSON catalogs: `catalog.json` (v1/v2), the skills catalog and `marketplace.json`. `omnyo explore` in the CLI reads the same JSON through `@omnyo/sdk/explore`, validates it, and filters it locally with the same keyword rules. The website is the emitter and the SDK is the reader.

*Observed duplicates (Proven by inspection; byte identity Reproduced with `cmp` over the extracted line ranges):*

| Knowledge | Website copy | SDK copy | Result |
| --- | --- | --- | --- |
| Catalog kinds `"prompt","workflow","skill","plugin","guide"` | `apps/web/src/explore/catalog.ts:3` `EXPLORE_KINDS`, `:11` `ExploreKind` | `packages/sdk/src/explore.ts:7` `EXPLORE_KINDS`, `:33` `ExploreKind` | byte-identical |
| Query cap of 80 characters | `catalog.ts:24` `EXPLORE_QUERY_MAX_LENGTH`; also restated inline in `apps/web/src/explore/public-skills.ts:57-64` `validatePublicSkillsSearch` (collapse whitespace, trim, slice to 80, trim, with no lowercasing) | `explore.ts:15` | same value |
| CTA union | `catalog.ts:45-56` `ExploreCta` | `explore.ts:42-53` | byte-identical |
| Preview | `catalog.ts:58-63` `ExplorePreview` | `explore.ts:35-40` | byte-identical |
| Item | `catalog.ts:65-75` `ExploreItem` | `explore.ts:55-65` | byte-identical |
| Query normalization | `catalog.ts:102-109` `normalizeExploreQuery` | `explore.ts:650-657` | byte-identical |
| Catalog filter | `catalog.ts:125-141` `filterExploreItems` (generic over `Pick<ExploreItem, "kind"\|"title"\|"summary"\|"tags">`) | `explore.ts:659-676` (takes `ExploreItem[]`) | bodies byte-identical (lines 128-140 compared with 663-675) |
| Marketplace kinds `"skill","workflow","connector"` | `apps/web/src/explore/marketplace.ts:10` `marketplaceKinds` | `explore.ts:197-201` `EXPLORE_MARKETPLACE_KINDS` | same list, same order |
| Nine categories | `public-skills.ts:10-20` `publicSkillCategories` | `explore.ts:203-213` `EXPLORE_MARKETPLACE_CATEGORIES` | byte-identical strings, same order |
| Marketplace keyword haystack: `slug, title, summary, publisher, category, ...keywords` | `marketplace.ts:135-146` inside `filterMarketplaceItems` | `explore.ts:337-348` inside `filterExploreMarketplace` | same fields, same order |
| Skills keyword haystack: `slug, title, publisher, category, summary, ...keywords` | `public-skills.ts:118-129` inside `filterPublicSkills` | `explore.ts:372-383` inside `filterExploreSkills` | same fields, same order |
| Term split `normalizeExploreQuery(q ?? "").split(" ").filter(Boolean)` | `catalog.ts:128`, `marketplace.ts:118`, `public-skills.ts:109`, `apps/web/src/explore/marketplace-view.ts:241` `highlightParts` | `explore.ts:324`, `:367`, `:663` | 7 copies |

*Divergences that must survive (Proven by inspection):*

- The website filters use truthy checks. For example, `marketplace.ts:123-133` uses `if (type && …)`, `if (publisher && …)`, and also filters by `source` and `license`. The SDK filters use `!== undefined` (`explore.ts:329-335`). An empty-string `publisher` therefore means "no filter" on the website but "match publisher === ''" in the SDK. The CLI passes `opts.publisher` through unchanged (`apps/cli/src/commands/explore.ts:185-190`).
- The website's `filterPublicSkills` (`public-skills.ts:105-131`) also filters by `category` and `publisher`. The SDK's `filterExploreSkills` (`explore.ts:363-385`) filters by query only.
- The SDK's skill and marketplace item types are inferred from zod schemas (`explore.ts:193` `ExploreSkill`, `:298` `ExploreMarketplaceItem`). The website's `PublicSkill` (`public-skills.ts:24-39`), `MarketplaceWorkflow` and `MarketplaceConnector` (`marketplace.ts:22-49`) are plain interfaces. Neither form is a byte copy of the other.

*Consumers (searches run over the snapshot with `git grep`, excluding `*.md`):*

- `git grep -n -E "sdk/explore|sdk/src/explore"` found only `apps/cli/src/commands/explore.ts:20` (production), `packages/sdk/test/explore.test.ts:19` and `apps/web/src/explore/sdk-contract.test.ts:12` (relative import). The CLI loads that command lazily from `apps/cli/src/command-groups.ts:150`.
- `@omnyo/sdk` is `"private": true` and declares `./explore` in `packages/sdk/package.json:20-25`. The published launcher `packages/omnyo-app` exports only `.` (`src/public-sdk.ts`), and `git grep -i explore -- packages/omnyo-app/src` finds nothing, so no external client imports these names. Older installed CLIs carry their own bundled copy, so version skew is handled by the catalog `schemaVersion` negotiation, not by this duplication.
- Website consumers of the shared names: `ExploreIndex.tsx:3,5,9,72,80,133`, `MarketplaceDirectory.tsx:4,8,34,115,139,147,224`, `MarketplaceStorefront.tsx:4,28,58,144,501`, `PublicSkillsPage.tsx:3,66`, `marketplace-view.ts:1,5,14,62,241`, `marketplace-loaders.ts:3,12-13`, `marketplace-detail.server.ts:1,41`, `marketplace.server.ts:9,11,41,45,56`, `public-skill-catalog.server.ts:3,103`. The tests are `catalog.test.ts`, `marketplace.test.ts`, `MarketplaceIndex.test.tsx` and `sdk-contract.test.ts`.
- `git grep -E "sdk/explore|domain/explore" -- '*.md'` returns no hits, so no docs need updating.

*Why the shared home is settled (Proven by inspection):*

- `apps/web/package.json:16` and `packages/sdk/package.json` both depend on `@omnyo/domain`.
- The website already imports pure domain subpaths: `apps/web/src/analytics/usage.ts:4` (`@omnyo/domain/site-usage`) and `apps/web/src/legal/product-data-dictionary.ts:4` (`@omnyo/domain/usage-telemetry`).
- The website image `apps/landing/Containerfile:9,16` copies `packages/domain/package.json` and `packages/domain/src`, but not `packages/sdk`. Importing the SDK from the website would therefore break the image build.
- Each `@omnyo/domain` subpath points straight at TypeScript source (`packages/domain/package.json`, for example `"./site-usage": { "source": "./src/site-usage.ts", "types": …, "default": … }`), and the package declares `"sideEffects": false`.

*Line counts (non-blank lines, counted with `git show <commit>:<file> | sed -n '<range>p' | grep -cv '^\s*$'`):*

- Website duplicate declarations in `catalog.ts`: 60.
- Website categories: 12.
- Website keyword cores inside `filterPublicSkills` and `filterMarketplaceItems`: about 18 of their 23 + 28 lines.
- SDK vocabulary and types: 57.
- SDK normalize and filter: 23.
- SDK keyword cores inside its two filters: about 18 of their 31 + 21 lines.

*Maintenance cost today:* adding an Explore kind, changing the 80-character cap or changing how queries are tokenized means coordinated edits in `catalog.ts`, `public-skills.ts`, `marketplace.ts`, `marketplace-view.ts` and `packages/sdk/src/explore.ts`. Only the parity test in `sdk-contract.test.ts:118-141` catches a missed edit, and it covers only the catalog normalizer and filter, not the skills filter or the category list.

**Proposed end state and preservation argument**

*New canonical owner:* `packages/domain/src/explore.ts`, exported as `@omnyo/domain/explore`. The module has no imports. It contains:

```ts
export const EXPLORE_KINDS = ["prompt", "workflow", "skill", "plugin", "guide"] as const;
export type ExploreKind = (typeof EXPLORE_KINDS)[number];
export const EXPLORE_QUERY_MAX_LENGTH = 80;
export const EXPLORE_MARKETPLACE_KINDS = ["skill", "workflow", "connector"] as const;
export type ExploreMarketplaceKind = (typeof EXPLORE_MARKETPLACE_KINDS)[number];
export const EXPLORE_MARKETPLACE_CATEGORIES = [/* the nine strings, same order */] as const;
export type ExploreMarketplaceCategory = (typeof EXPLORE_MARKETPLACE_CATEGORIES)[number];
export interface ExplorePreview { /* moved verbatim */ }
export type ExploreCta = /* moved verbatim */;
export interface ExploreItem { /* moved verbatim */ }

/** Collapse whitespace, trim, cap at EXPLORE_QUERY_MAX_LENGTH and trim again. Keeps case. */
export function collapseExploreQuery(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim().slice(0, EXPLORE_QUERY_MAX_LENGTH).trim();
}
export function normalizeExploreQuery(raw: string): string {
  return collapseExploreQuery(raw).toLowerCase();
}
export function exploreQueryTerms(query: string | undefined): string[] {
  return normalizeExploreQuery(query ?? "").split(" ").filter(Boolean);
}
/** True when every term occurs in the space-joined, lowercased fields. `undefined` fields join as "" (Array.join semantics). */
export function matchesExploreTerms(
  fields: readonly (string | undefined)[],
  terms: readonly string[],
): boolean {
  const haystack = fields.join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
export function filterExploreItems<
  Item extends Pick<ExploreItem, "kind" | "title" | "summary" | "tags">,
>(items: readonly Item[], filter: { kind?: ExploreKind; query?: string }): Item[] {
  const terms = exploreQueryTerms(filter.query);
  return items.filter(
    (item) =>
      (filter.kind === undefined || item.kind === filter.kind) &&
      matchesExploreTerms([item.title, item.summary, ...item.tags], terms),
  );
}
```

Each filter keeps its own field list, in its current order, and passes it to `matchesExploreTerms`. The two field lists are each defined twice today (once on the website, once in the SDK). Optionally, they can also become two named helpers in the domain module: `exploreMarketplaceSearchFields(item)` and `exploreSkillSearchFields(item)`, each taking a structural `{ slug; title; summary?; publisher; category; keywords }`. Keep the existing order in both, so there is no need to argue that reordering is harmless.

*What remains where:*

- `packages/sdk/src/explore.ts` re-exports every moved name (`export * from "@omnyo/domain/explore";` or a named re-export list) and imports the names it uses locally: `EXPLORE_KINDS` in `readKind` and `parseExploreKey`, `EXPLORE_MARKETPLACE_CATEGORIES` in `z.enum`, the item types in the readers, and `exploreQueryTerms` and `matchesExploreTerms` in `filterExploreMarketplace` and `filterExploreSkills`. The SDK keeps all network reading, size and time limits, slug and path validation, zod schemas, the v1/v2 `parseExploreCatalog` rules, error classes, `parseExploreKey` and `exploreUrl`. Its `filterExploreMarketplace` and `filterExploreSkills` keep their signatures and their `!== undefined` field checks. The `@omnyo/sdk/explore` export surface stays the same name for name, so the CLI does not change.
- `apps/web/src/explore/catalog.ts` imports and re-exports `EXPLORE_KINDS`, `ExploreKind`, `EXPLORE_QUERY_MAX_LENGTH`, `ExploreCta`, `ExplorePreview`, `ExploreItem`, `normalizeExploreQuery` and `filterExploreItems`, so the website files that import them from `./catalog` do not change. It keeps `EXPLORE_KIND_LABELS`, the paths, `canonicalExploreUrl`, `ExploreItemKey`, `ExploreLink`, `ExploreSearch`, `exploreKey`, `isExploreKind`, `validateExploreSearch` and `exploreSearchHref`.
- `apps/web/src/explore/public-skills.ts` keeps its exported names as aliases: `export const publicSkillCategories = EXPLORE_MARKETPLACE_CATEGORIES;` and `export type PublicSkillCategory = ExploreMarketplaceCategory;`. Its `validatePublicSkillsSearch` calls `collapseExploreQuery(String(search.q))`, and `filterPublicSkills` keeps its truthy `category` and `publisher` checks but uses `exploreQueryTerms` and `matchesExploreTerms`.
- `apps/web/src/explore/marketplace.ts` aliases `marketplaceKinds` and `MarketplaceKind` in the same way. `filterMarketplaceItems` keeps every truthy field check, including `source` and `license`, and uses the shared term helpers.
- In `apps/web/src/explore/marketplace-view.ts:241`, `highlightParts` uses `exploreQueryTerms(query)`.

*Preservation argument:*

- The constants keep their order, which drives the order of UI chips and facets (`MarketplaceDirectory.tsx:139,147`, `PublicSkillsPage.tsx:66`, `MarketplaceStorefront.tsx:501`) and the CLI's `Use one of:` messages (`explore.ts:165,178`).
- `normalizeExploreQuery` and `filterExploreItems` are moved verbatim. Splitting the normalizer into `collapseExploreQuery` and `.toLowerCase()` gives the same result, and `validatePublicSkillsSearch` already applies exactly the steps of `collapseExploreQuery`.
- `matchesExploreTerms` keeps the `[...].join(" ").toLowerCase()` and `terms.every(includes)` semantics, including `undefined` summaries joining as an empty string.
- Catalog JSON, schema versions, URLs, labels and search-parameter validation do not change.
- The website bundle gains no zod or SDK code because the domain module has no imports.

*Non-goals:*

- No change to catalog JSON, the v1/v2 negotiation, the SDK's network validation, CLI flags or output.
- No unification of the truthy and `!== undefined` field-filter semantics. That would change behavior.
- No sharing of `PublicSkill`, `MarketplaceWorkflow`, `MarketplaceConnector` or `MarketplaceItem` with the SDK's zod-inferred types. On the SDK side this would only replace an inferred type with an interface plus a compile-time equality assertion, without removing a definition. The runtime check `parseExploreMarketplace(json)` toEqual `marketplaceItems` in `sdk-contract.test.ts:65-68` already guards that shape. Revisit after RF-049.
- No sharing of the `${kind}/${slug}` key format (`catalog.ts:93`, `explore.ts:632`). It is a one-line rule with no maintenance benefit.

**Expected gain and cost**

*Measured inputs (non-blank lines):* the website duplicates total about 90 lines (catalog 60, categories 12, keyword cores about 18). The SDK duplicates total about 98 lines (vocabulary 57, normalize and filter 23, keyword cores about 18).

*Projection:*

- The SDK copy of the declarations (about 80 lines) moves into domain. Moved lines are not counted as savings.
- The website copy (about 90 lines) is deleted.
- The term helpers collapse 7 term-split sites and 4 haystack bodies into 2 helpers.
- New plumbing is about 25–35 lines: the domain `package.json` export entry (5), the SDK re-export and imports (about 8–12), the website imports, re-exports and aliases (about 12–18), and roughly 10 added helper lines.

*Net:* about **45–70 handwritten production lines removed**. The sweep report S12's figure of 100–150 is too high, because it ignored the new imports and the parts that must stay local. S19's 50–80 is close.

*Tests:* the `"filters identically on the site and in the SDK"` case (`sdk-contract.test.ts:118-141`, 24 lines) becomes tautological, because both names resolve to one function. Delete it together with the `sdkFilter`/`sdkNormalize` imports. Every other `sdk-contract.test.ts` case stays, including the marketplace filter parity at `:81-97`, which still compares two distinct filters. The behavior tests in `catalog.test.ts:441-465` and `packages/sdk/test/explore.test.ts:348-407` stay. Generated code, docs and assets: none.

*Mechanisms:*

| | Before | After |
| --- | --- | --- |
| Kind list | 2 definitions | 1 |
| Categories | 2 definitions | 1 |
| 80-character query rule | 3 definitions (two normalizers and the inline skills validator) | 1 |
| Term split | 7 copies | 1 |
| Keyword match body | 5 copies | 1 |
| Item, CTA and preview shapes | 2 definitions | 1 |

The parity test keeps its producer/consumer role over real v1/v2 and marketplace responses.

*Maintenance example:* adding an Explore kind today means editing `catalog.ts` (the list and its labels) and `packages/sdk/src/explore.ts`, and hoping the parity test notices a missed edit. Afterwards it means one edit in `packages/domain/src/explore.ts`. The `Record<ExploreKind, …>` type of `EXPLORE_KIND_LABELS` then forces the label edit at compile time. Changing tokenization becomes one edit instead of seven.

*Costs and tradeoffs:* `@omnyo/domain` gains one more subpath of website-catalog vocabulary. This matches the existing `site-usage` and `plugin-marketplace-entry` modules. Performance: neutral (Hypothesis). The functions are the same pure code. Website bundle size should be neutral because the module has no imports; confirm with the build comparison below.

**Execution steps**

1. **Reconfirm the baseline.** Check that the anchors in Context still match: the line ranges, the `cmp` identity and the consumer list from `git grep -n -E "sdk/explore|sdk/src/explore"`. Re-plan in any of these cases:
   - RF-049 has landed and changed how SDK types are defined. Follow the RF-049 note in the disposition.
   - A new production importer of `@omnyo/sdk/explore` exists outside `apps/cli`.
   - `packages/domain` has stopped being copied by `apps/landing/Containerfile`.
   - The website and SDK copies have diverged in behavior. Treat that as a bug to report separately, not something to merge silently.
2. **Baseline evidence.** Run the explore tests listed under Verification in all three packages and record the results. Record the website client bundle: run `pnpm build` in `apps/web`, then list file sizes under `apps/web/dist` (for example with `find apps/web/dist -name '*.js' -exec wc -c {} +`). Keep the totals.
3. **Checkpoint A: create the domain module (additive only).** Add `packages/domain/src/explore.ts` with the content in the end-state sketch. Copy the definitions verbatim from `packages/sdk/src/explore.ts:7-15,33-65,197-213,293-296,650-676`, using the website's generic `filterExploreItems` signature. Add `"./explore": { "source": "./src/explore.ts", "types": "./src/explore.ts", "default": "./src/explore.ts" }` to `packages/domain/package.json` `exports`. Optionally add `packages/domain/test/explore.test.ts` covering `collapseExploreQuery` versus `normalizeExploreQuery` and `undefined` fields in `matchesExploreTerms`. Run the domain typecheck.
4. **Checkpoint B: the SDK becomes a re-exporter.** In `packages/sdk/src/explore.ts`:
   - Delete lines 7-13 (`EXPLORE_KINDS`), 15 (`EXPLORE_QUERY_MAX_LENGTH`), 33-65 (`ExploreKind`, `ExplorePreview`, `ExploreCta`, `ExploreItem`), 197-213 (`EXPLORE_MARKETPLACE_KINDS`, `EXPLORE_MARKETPLACE_CATEGORIES`), 293-296 (the two derived types) and 650-676 (`normalizeExploreQuery`, `filterExploreItems`).
   - Add the re-export, plus a local `import { EXPLORE_KINDS, EXPLORE_MARKETPLACE_CATEGORIES, exploreQueryTerms, matchesExploreTerms, type ExploreItem, type ExploreKind, type ExploreCta, type ExplorePreview, type ExploreMarketplaceKind, type ExploreMarketplaceCategory } from "@omnyo/domain/explore";`.
   - Rewrite only the term and haystack lines of `filterExploreMarketplace` (`:324-326`, `:337-348`) and `filterExploreSkills` (`:367-369`, `:372-383`) to use the helpers. Keep the field lists in their current order and keep every `!== undefined` check.
   - Run the SDK typecheck and `packages/sdk/test/explore.test.ts`, then the CLI typecheck and CLI explore tests. They must pass unchanged.
5. **Checkpoint C: the website imports the shared module.**
   - In `apps/web/src/explore/catalog.ts`, delete lines 3-9, 11, 24, 45-75, 102-109 and 125-141, and add an import plus a named re-export of the eight names. Keep `isExploreKind` and `validateExploreSearch` as they are.
   - In `public-skills.ts`, replace lines 10-22 with the aliases, replace the inline chain at 57-64 with `collapseExploreQuery(String(search.q))` (keeping the `typeof` guard), and rewrite the term and haystack lines of `filterPublicSkills` (`:109-111`, `:118-129`) with the helpers. Keep the truthy checks at 114-116.
   - In `marketplace.ts`, alias `marketplaceKinds` and `MarketplaceKind` at lines 10 and 20, and rewrite lines 118-120 and 135-146 with the helpers. Keep the truthy checks at 123-133.
   - In `marketplace-view.ts:241`, use `exploreQueryTerms(query)`.
   - Run the website typecheck and the explore tests.
6. **Checkpoint D: remove superseded test machinery.** Delete the `"filters identically on the site and in the SDK"` case (`sdk-contract.test.ts:118-141`) and the now-unused imports (`sdkFilter`, `sdkNormalize`, plus `EXPLORE_KINDS`, `filterExploreItems` and `normalizeExploreQuery` from `./catalog`, if they are unused). Keep every other case.
7. **Format and lint the changed files.** From the repository root, run `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>`.
8. **Final review.** Inspect the full diff. `git grep -n "\.slice(0, EXPLORE_QUERY_MAX_LENGTH)"` must hit only `packages/domain/src/explore.ts`. `git grep -n "export const EXPLORE_KINDS"` must hit only the domain file. No `.split(" ").filter(Boolean)` should remain in `apps/web/src/explore` or `packages/sdk/src/explore.ts`. Recount net lines with `git diff --stat`, separating production files from tests.

**Verification and acceptance criteria**

The package scripts were confirmed from each `package.json` at the snapshot. Passing individual file paths to `vitest run` is standard vitest usage, but it was not run here: the snapshot has no `node_modules`.

- `cd packages/domain && pnpm typecheck && pnpm test` (scripts `typecheck` and `test` exist).
- `cd packages/sdk && pnpm typecheck && pnpm exec vitest run --config vitest.config.ts test/explore.test.ts`.
- `cd apps/cli && pnpm typecheck && pnpm exec vitest run src/__tests__/command-output/explore.test.ts src/__tests__/json-flag-enforcement.test.ts`. Not confirmed: whether these tests need `@omnyo/cli#build` first, as the turbo task `@omnyo/cli#test` declares (`turbo.json:558`). If they fail on a missing build, run `pnpm build` in `apps/cli` first.
- `cd apps/web && pnpm typecheck && pnpm exec vitest run --config vitest.config.ts src/explore`. This must cover `catalog.test.ts`, `marketplace.test.ts`, `MarketplaceIndex.test.tsx`, `public-skill-catalog.test.ts`, `pages.test.tsx` and `sdk-contract.test.ts`.
- `cd apps/web && pnpm build`, then compare the `.js` byte totals under `apps/web/dist` with the step-2 baseline. Acceptance: no new zod or SDK chunk, and a total within the build's normal run-to-run variation. If no repeat baseline exists, build twice before the change to see the variation. Do not assume an allowance.
- `cd apps/cli && pnpm build`. It must succeed, which proves the CLI bundle resolves `@omnyo/domain/explore` through the SDK.
- Website image: optional and not run here. `apps/landing/Containerfile` already copies `packages/domain/src`, so no Containerfile change is expected. An image build is needed only if a deployment is planned.
- **Behavior acceptance.** All existing assertions pass without edits, except the deleted tautological case. In particular, the marketplace parity loop (`sdk-contract.test.ts:81-97`) and the v1/v2 round-trips (`:100-116`) pass. The `MarketplaceIndex.test.tsx` `source` and `license` filter cases still pass.
- **Structural acceptance.** One definition each of the kinds, the categories, the 80-character cap, the term split and the keyword match, all in `packages/domain/src/explore.ts`. `@omnyo/sdk/explore` exports the same names as before. Compare `git show <base>:packages/sdk/src/explore.ts | rg -o "^export (const|function|type|interface|class|async function) \w+"` with the new names exported directly or through the re-export.
- No UI change is expected. Alex tests UI changes himself, so no screenshot round is required for this dev change.

**Rollback and stop conditions**

- *Rollback:* the change touches source only, and no persisted data or wire format changes. Revert the commit, or each checkpoint commit in reverse order. Checkpoint A alone is harmless.
- *Stop and re-plan if:*
  - Any existing explore test needs an expectation change. That signals a semantic difference; report it separately instead of adjusting the test.
  - The website build pulls zod or SDK code into the client because of the new import.
  - A production consumer of `@omnyo/sdk/explore` exists outside the CLI and depends on a name that moves.
  - RF-049 has redefined the SDK item types first.
  - A reviewer requires the emitter and reader to stay deliberately independent copies. The safer smaller alternative is then to share only the constants and the term helpers, which still removes the seven term-split copies and the three 80-character definitions.
