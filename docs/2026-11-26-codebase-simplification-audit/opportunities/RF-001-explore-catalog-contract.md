# RF-001 — Own the Explore catalog vocabulary and search in one place

## Rank and disposition

Ready for planning against a fresh checkout. High confidence in the duplicate rule, medium maintenance benefit, small effort, low to medium risk. This can ship independently of the CLI settings and design-lab work.

## Context and evidence

Proven by inspection at `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. `apps/web/src/explore/catalog.ts` exports `EXPLORE_KINDS`, `EXPLORE_QUERY_MAX_LENGTH`, `ExploreCta`, `ExplorePreview`, `ExploreItem`, `normalizeExploreQuery` and generic `filterExploreItems`. `packages/sdk/src/explore.ts` defines all seven independently. The filter bodies match, including term ordering, title/summary/tag search, whitespace collapse, 80-character cap and case folding. Consumers include `apps/web/src/explore/ExploreIndex.tsx`, site route search validation, and `apps/cli/src/commands/explore.ts` (`readExploreCatalog` and `filterExploreItems`). The web parity tests already exercise both implementations and read producer responses through the SDK. The web `marketplace-view.ts`, `marketplace.ts` and `public-skills.ts` use the normalizer with their own fields, labels and featured/sort rules. Their distinct policies have active consumers.

## Proposed end state and preservation argument

Put only the shared literal list, types and pure functions in a narrow `@omnyo/domain/explore-catalog` entry point. Both packages already depend on `@omnyo/domain`, and the landing Containerfile copies the package manifest and source. Use the web generic filter signature to preserve all input properties. Re-export the existing names from both current modules, preserving present import paths and the published SDK. Keep web route paths, CTA labels and href building in the site. Keep untrusted HTTP reads, v1/v2 format rules, catalog limits, slug/path validation, and errors in the SDK. Keep separate marketplace/skills filter policies where they cover different fields and ordering.

## Expected gain and cost

Approximately 64–68 duplicate declaration and function lines can disappear after relocating one copy. Allow 12–25 new import, re-export and package-export lines, for roughly 40–55 net handwritten lines. The basis is the two bounded declaration groups and the 23-line normalizer/filter groups in each current module. A new Explore kind or change to term matching would require one shared edit. Build and runtime effects should be small given a side-effect-free domain entry point. Verify the actual landing build because the site has a separate container build path.

## Execution steps

1. Compare the current source and supported catalog contracts with this snapshot. First capture expected ordered IDs for kind filters, repeated whitespace, overlong queries and a v1 feed. Preserve the existing independent catalog/request fixtures.
2. Move the vocabulary and generic functions into `packages/domain/src/explore-catalog.ts`, add a subpath export mirroring `./site-usage`, then redirect the site and SDK imports. Keep `isExploreKind`, `parseExploreKey`, site-only search parsing and all network checks at their existing boundaries unless an actual shared caller needs the predicate.
3. Verify website and SDK outputs against the captured expectations. Once parity tests exercise the emitted payload and fixed expected results, remove any assertion that only compares two imports of the same function. Keep actual producer/consumer coverage.
4. Inspect the web build graph, package export and published SDK declaration shape. Confirm one kind declaration and one base filter remain.

## Verification and acceptance criteria

From the repository root, run `pnpm --filter @omnyo/web test src/explore/catalog.test.ts src/explore/sdk-contract.test.ts`, `pnpm --filter @omnyo/sdk test test/explore.test.ts`, and `pnpm --filter @omnyo/cli test src/__tests__/command-output/explore.test.ts`. Run `pnpm --filter @omnyo/web build` and inspect the web route and packed SDK exports as part of implementation. These scripts/fixtures were identified by inspection. The public page order and links, v1/v2 parsing, search output and invalid response behavior must match the baseline. No new browser import should pull in SDK transport.

## Rollback and stop conditions

Revert the extraction as one local change. It has no data migration. Stop if the site build requires pulling SDK networking into the browser or an older catalog version requires a different vocabulary. Keep case-specific admission in the parser and reconsider which pure rules can be shared.
