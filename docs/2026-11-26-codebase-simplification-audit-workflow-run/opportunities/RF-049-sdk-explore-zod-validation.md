# RF-049 — Replace the SDK's hand-written Explore catalog reader family with one zod schema and inferred types

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but the sweep's plan to make the item type a kind-bound discriminated union would change the exported `ExploreItem` type and break the website's typecheck. This card keeps every exported type structurally identical and enforces the kind-to-CTA rule in a refinement instead.
- **Potential:** medium. One module stops carrying two validation mechanisms and two declarations of the same item shape.
- **Confidence:** high. The schema was prototyped against the current reader on 33 representative inputs, and the inferred types were type-checked for equality with the current declarations (see Context).
- **Readiness:** ready. The one visible change is the wording of the error message for a malformed catalog. No test, doc or consumer depends on that wording. The default below matches the wording the two sibling parsers in the same file already use. If Alex wants the current location-prefixed wording kept, use the alternative formatter in step 4; it costs about 10 lines.
- **Effort:** small, about half a day including the characterization checks.
- **Risk:** low. Three small validation differences are documented and accepted below: string lengths are counted in code points instead of UTF-16 units, dimensions above `Number.MAX_SAFE_INTEGER` are rejected, and parsing a 500-item catalog takes about 1.8 ms longer.
- **Prerequisites:** none.
- **Related and overlapping:** RF-048 ("Share the Explore catalog vocabulary and filters between apps/web and the SDK") moves `ExploreCta`, `ExplorePreview`, `ExploreItem` and the filter into one shared module. The two changes touch the same declarations, so land them in separate commits, in either order (see step 1). RF-110 ("Build the SDK setting-descriptor validator from the server-contract schema") applies the same "one schema, inferred types" idea in another SDK area. It does not overlap this card.
- **Why it deserves its place:** `packages/sdk/src/explore.ts` already validates the skills and marketplace catalogs with zod. Only the main catalog keeps a private family of eleven reader helpers and a hand-declared type that must be kept in step with them. Today, adding or tightening one catalog field means editing the interface, a `read*` call and sometimes a new helper. After this change it is one schema field. The saving is modest, about 130 to 170 lines, but the change has low risk and removes a whole mechanism.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The main checkout's `packages/sdk/src/explore.ts` and `packages/sdk/test/explore.test.ts` were byte-identical to it when this card was written (`git diff --stat e9e1b74c3 -- <both paths>` printed nothing).

What the module does: `omnyo explore` (`apps/cli/src/commands/explore.ts`) reads the public catalog at `https://omnyohq.com/explore/catalog.json?version=2` through `readExploreCatalog`. That function enforces a 1 MiB byte cap, then calls `parseExploreCatalog`. The parser must reject malformed or hostile catalogs and must accept both catalog versions 1 and 2.

Observed facts (Proven by inspection unless marked otherwise):

- `packages/sdk/src/explore.ts` is 926 lines (`git show e9e1b74c3:packages/sdk/src/explore.ts | wc -l`). It imports zod at line 1. It uses zod for `exploreSkillSchema` (:72), `exploreSkillsSchema` (:174), `marketplaceItemSchema` (:225, already a `z.discriminatedUnion("kind", …)`) and `marketplaceSchema` (:274). Their types are inferred with `z.infer` (:193, :195, :298, :300).
- The main catalog uses a second, hand-written mechanism:
  - Hand-declared types: `ExplorePreview` (:35-40), `ExploreCta` (:42-53), `ExploreItem` (:55-65) and `ExploreCatalog` (:67-70).
  - A reader family at :419-603: `JsonObject`, `isObject`, `invalid`, `readObject`, `readString`, `isSlug`, `readSlug`, `readPath`, `readKind`, `readDimension`, `readPreview`, `readTags`, `readCta` and `readItem`.
  - `parseExploreCatalog` (:605-648). It checks the version (1 or `EXPLORE_SCHEMA_VERSION`), checks that `items` is an array of at most `CATALOG_MAX_ITEMS` (500), rejects `skill` items in version 1, and rejects duplicate `kind/slug` pairs.
- Line counts, from `git show … | sed -n 'a,bp' | grep -c -v '^\s*$'`: 33 non-blank lines in :35-70 and 182 in :419-648. Of those, `isSlug` (:456-458, 3 lines) must stay, because `parseExploreKey` (:686) and `readExplorePromptText` (:916) use it. In total, about 262 lines (212 non-blank) are in scope for removal.
- Error behavior: `invalid` throws `ExploreFormatError` with `Invalid Explore catalog at <location>: <reason>`. The sibling parsers throw `ExploreFormatError` with `` `Invalid Explore marketplace: ${result.error.message}` `` (:309) and `` `Invalid Explore skills catalog: ${result.error.message}` `` (:357).
- Consumers of the parser and its types (`git grep -n -E "ExploreItem|ExploreCta|ExplorePreview|parseExploreCatalog|ExploreCatalog\b|ExploreFormatError" e9e1b74c3`, whole repository):
  - `apps/cli/src/commands/explore.ts`. `ExploreRow = ExploreItem & { url: string }` (:39), `toRow` (:44), the `nextStep` switch on `cta.kind` (:86-101), `printItems` and `printItem`. `unavailable` (:62-69) maps both error classes to CLI code `explore_unavailable` and prints `error.message`.
  - `apps/web/src/explore/sdk-contract.test.ts` (imports `../../../../packages/sdk/src/explore`). It checks a lossless round trip of the real v2 and v1 website output (:100-116). It also passes the website's own `ExploreItem[]` into the SDK's `filterExploreItems` (:133). The website type is declared separately in `apps/web/src/explore/catalog.ts:45-75` with `kind: ExploreKind` and `cta: ExploreCta` not bound to each other. `apps/web/tsconfig.json` includes `src`, so `pnpm --filter @omnyo/web typecheck` checks this test file.
  - `packages/sdk/test/explore.test.ts`.
  - No other importer: `git grep -n -E "sdk/explore|src/explore(\.js)?\""` finds only those three files. `packages/sdk/package.json` is `"private": true` and exposes `./explore` as a workspace subpath. No published package re-exports it (a search of `package.json` files and `scripts/*.mjs` for `explore` found only the SDK's own export entry).
- Tests pin the error class, not the message text. `expectFormatError` (`packages/sdk/test/explore.test.ts:131-133`) uses `toThrow(ExploreFormatError)`. The rejection tables at :204-212 and :222-299, plus :301-345, cover every reader rule. `readExploreCatalog` failures are checked with `rejects.toBeInstanceOf(ExploreFormatError)` (:588-607). The CLI test `apps/cli/src/__tests__/command-output/explore.test.ts:617-634` asserts only `error.code === "explore_unavailable"`. The only documentation, `plugins/omnyo-guide/skills/omnyo-cli/references/command-index.md:412`, names the code, not the message.
- Output shape: the test at :166 pins `Object.keys(catalog)` to `["schemaVersion", "items"]`. The test at :136-167 requires unknown fields to be dropped at every level.

Reproduced (in scratch, using the main checkout's installed `zod@4.6.7` and Node 24 type stripping; no repository file was changed):

- A prototype schema (the shape in the next section) was run beside the current `parseExploreCatalog` on 33 inputs. The inputs covered every rejection class in the SDK test file, both versions, all five kinds, extra fields, 500 versus 501 items, the 64/65 slug and 200/201 path boundaries, duplicates, `null` and `Date` items, and a CTA bound to the wrong kind. Accept or reject matched on 31 of 33, and accepted outputs were JSON-identical. The two differences:
  1. **Astral characters:** a 121-UTF-16-unit title made of 60 emoji plus one letter is rejected by the current reader and accepted by zod. In zod 4.6.7, `$ZodCheckMaxLength` (`node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/checks.js:273`) counts code points once the UTF-16 length exceeds the maximum. All other zod string limits in this module already behave this way.
  2. **Huge integers:** `width: 1e20` is accepted by `readDimension` (`Number.isInteger`) and rejected by zod's `.int()`, which limits values to the safe-integer range.
- Type equality: with `typescript@5.9.3` under `--strict`, `z.infer` of the prototype's preview, CTA, item and catalog schemas is mutually assignable with the current `ExplorePreview`, `ExploreCta`, `ExploreItem` and `ExploreCatalog`. A negative control (CTA compared with preview) failed as expected.
- A reduced model of the sweep's plan, where `ExploreItem` is a union binding each item kind to its CTA type, fails to type-check when the website's unbound item type is passed to the SDK filter (`TS2345 … Types of property 'kind' are incompatible`). This is the reason this card does not use that plan.
- Timing, measured on the owner's Mac with a 500-item v2 catalog and 200 timed iterations after 50 warm-ups: the current reader takes 1.04 ms per parse, and the zod prototype takes 2.84 ms. This is one sample on one machine. One parse happens per `omnyo explore` command, after a network request.

Maintenance cost today: an item field must be kept in step across the interface, a `read*` call, the location strings and sometimes a new helper. That is a second validation style beside the zod schemas that the same file and the same reviewers already maintain.

**Proposed end state and preservation argument**

What disappears: `JsonObject`, `isObject`, `invalid`, `readObject`, `readString`, `readSlug`, `readPath`, `readKind`, `readDimension`, `readPreview`, `readTags`, `readCta` and `readItem`. The hand-written bodies of `ExplorePreview`, `ExploreCta`, `ExploreItem` and `ExploreCatalog` are replaced by `z.infer` aliases with the same names.

What remains: all constants (`SLUG_PATTERN`, `SLUG_MAX_LENGTH`, `PATH_MAX_LENGTH`, `PATH_FORBIDDEN_PATTERN`, `CATALOG_MAX_ITEMS`, `CATALOG_MAX_BYTES`), `isSlug`, `ExploreFormatError`, `ExploreUnavailableError`, the `parseExploreCatalog(value: unknown): ExploreCatalog` signature, `readExploreCatalog` and the transport. The SDK stays the owner of the parser.

Target schema (pseudocode in the module's style):

```ts
const exploreSlugSchema = z.string().min(1).max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, "expected a lowercase slug");
const explorePathSchema = z.string().min(1).max(PATH_MAX_LENGTH).refine(
  (value) => value.startsWith("/") && !value.startsWith("//") &&
    !PATH_FORBIDDEN_PATTERN.test(value),
  "expected a site-relative path");
const ctaLabel = z.string().min(1).max(40);
const exploreCtaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("copy-prompt"), label: ctaLabel, textPath: explorePathSchema }),
  z.object({ kind: z.literal("get-workflow"), label: ctaLabel, path: explorePathSchema }),
  z.object({ kind: z.literal("get-skill-pack"), label: ctaLabel, path: explorePathSchema }),
  z.object({ kind: z.literal("find-in-omnyo"), label: ctaLabel,
    pluginId: exploreSlugSchema, marketplace: exploreSlugSchema,
    install: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("read-guide"), label: ctaLabel, path: explorePathSchema }),
]);
const CTA_KIND_BY_ITEM_KIND = { prompt: "copy-prompt", workflow: "get-workflow",
  skill: "get-skill-pack", plugin: "find-in-omnyo", guide: "read-guide",
} as const satisfies Record<ExploreKind, ExploreCta["kind"]>;
const dimension = z.number().int().positive();
const explorePreviewSchema = z.object({ path: explorePathSchema,
  alt: z.string().min(1).max(300), width: dimension, height: dimension });
const exploreItemSchema = z.object({
  kind: z.enum(EXPLORE_KINDS), slug: exploreSlugSchema,
  title: z.string().min(1).max(120), summary: z.string().min(1).max(400),
  publisher: z.string().min(1).max(80),
  tags: z.array(z.string().min(1).max(32)).max(12),
  path: explorePathSchema, preview: explorePreviewSchema.nullable(),
  cta: exploreCtaSchema,
}).superRefine((item, context) => {
  if (item.cta.kind !== CTA_KIND_BY_ITEM_KIND[item.kind])
    context.addIssue({ code: "custom", path: ["cta", "kind"],
      message: `does not match item kind ${item.kind}` });
});
const exploreCatalogSchema = z.object({
  schemaVersion: z.literal([1, EXPLORE_SCHEMA_VERSION]),   // keep this key first
  items: z.array(exploreItemSchema).max(CATALOG_MAX_ITEMS),
}).superRefine((catalog, context) => {
  const seen = new Set<string>();
  for (const [index, item] of catalog.items.entries()) {
    if (catalog.schemaVersion === 1 && item.kind === "skill")
      context.addIssue({ code: "custom", path: ["items", index, "kind"],
        message: "skill packs require version 2" });
    const key = `${item.kind}/${item.slug}`;
    if (seen.has(key))
      context.addIssue({ code: "custom", path: ["items", index],
        message: `duplicate item ${key}` });
    seen.add(key);
  }
});
export type ExplorePreview = z.infer<typeof explorePreviewSchema>;
export type ExploreCta = z.infer<typeof exploreCtaSchema>;
export type ExploreItem = z.infer<typeof exploreItemSchema>;
export type ExploreCatalog = z.infer<typeof exploreCatalogSchema>;
```

`CTA_KIND_BY_ITEM_KIND` is typed against `ExploreCta`, which is inferred from `exploreCtaSchema`. Declare the map after that schema; type aliases are hoisted, so this works.

Why this shape: the item keeps `kind: ExploreKind` and an unbound `cta: ExploreCta`, so the inferred types equal the current declarations (Reproduced above). The binding of each item kind to its CTA moves into one refinement backed by a typed lookup table. That table replaces the five-arm `switch` in `readCta`. A per-kind `z.discriminatedUnion` for items would also be valid zod, but it narrows the exported type and breaks `apps/web/src/explore/sdk-contract.test.ts:133` (Reproduced in a reduced model), so it is a non-goal here. RF-048 may revisit it once the website and the SDK share one item type.

Preserved contracts:

- **Accepted and rejected inputs:** every rejection case in `packages/sdk/test/explore.test.ts` stays rejected; 31 of 33 inputs matched exactly, as described above.
- **Unknown fields:** zod's default `z.object` strips unknown keys at every level, as the readers did.
- **Required preview:** `preview` must be present, and `.nullable()` without `.optional()` rejects a missing key, matching `readPreview(undefined)`.
- **Key order:** the catalog's output keys stay in `schemaVersion`, `items` order because zod builds output in shape order.
- **Error type:** parse failure still throws `ExploreFormatError`, so the CLI code `explore_unavailable` and the `readExploreCatalog` error contract are unchanged.
- **Size limits:** the 1 MiB byte cap and the 500-item limit stay.

Intentional, documented differences (accepted, no separate issue needed):

1. **String limits are counted in code points.** Strings made of astral characters such as emoji may be up to twice as long in UTF-16 units. The byte cap still bounds the whole catalog, and the skills and marketplace parsers already count this way.
2. **Image dimensions above 2^53 − 1 are rejected.** No real preview has such dimensions.
3. **Parsing is about 1.8 ms slower per 500-item catalog** in one local sample. This is negligible beside the network fetch.
4. **The error message wording changes.** The default `` `Invalid Explore catalog: ${result.error.message}` `` matches the sibling parsers. It reports all issues, where the old reader stopped at the first.
5. **An oversized `items` array is checked element by element before its length is checked.** Through `readExploreCatalog` the input is already capped at 1 MiB, and no other production caller exists.

Non-goals: sharing types with `apps/web` (RF-048), changing the skills or marketplace schemas (beyond optionally reusing `SLUG_PATTERN` in `exploreSkillSchema.slug` at :74-78), and changing `parseExploreKey`, `exploreUrl` or the transport.

**Expected gain and cost**

- **Removed (observed count):** about 262 handwritten production lines (212 non-blank) in `packages/sdk/src/explore.ts`, from the ranges :35-70 and :419-648, keeping `isSlug`.
- **Added (projection):** about 90 to 120 lines for the schemas, the lookup table, four type aliases and the four-line `safeParse` wrapper, after `oxfmt` at the file's 80-column style. The unformatted prototype was 21 dense non-blank lines.
- **Net (projection):** about 130 to 170 fewer handwritten SDK production lines. There are no test, generated-code or asset changes, apart from optional added characterization cases.
- **Mechanisms:** before, two validation mechanisms in one module, and the item shape declared twice (interface plus reader). After, one mechanism, with the types derived from it.
- **Maintenance effect:** a new field or limit becomes one schema edit. The kind-to-CTA binding becomes one data table instead of a five-arm switch.
- **Cost:** half a day of work, plus the accepted differences listed above.
- **Unknown:** the exact line count after formatting.

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of current `main`, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- packages/sdk/src/explore.ts packages/sdk/test/explore.test.ts apps/web/src/explore/catalog.ts apps/cli/src/commands/explore.ts`.
   - If RF-048 has landed, the shared types now live in its new module. Put the item, CTA and preview schemas and their `z.infer` types there instead of in the SDK, if that module's package already depends on zod. `@omnyo/domain` does: `packages/domain/package.json` lists `zod ^4.3.6`. Otherwise keep the schemas in the SDK and make the shared declarations aliases of the SDK types.
   - Re-plan if any new importer of these types or of `parseExploreCatalog` appears. Find importers with `git grep -n -E "ExploreItem|ExploreCta|ExplorePreview|parseExploreCatalog"`.
   - Re-plan if a test or doc starts pinning the `Invalid Explore catalog at …` wording.
   - Re-plan if the installed zod major version changes (`pnpm-lock.yaml`, entry `zod@4.x`).
2. **Add the missing characterization coverage before the switch**, in `packages/sdk/test/explore.test.ts` under `describe("parseExploreCatalog")`:
   - a null item: `catalogOf(null)` must be rejected;
   - a non-object CTA: `promptItem({ cta: "x" })` must be rejected;
   - a CTA with an unknown kind: `promptItem({ cta: { kind: "x", label: "l" } })` must be rejected;
   - a version-2 catalog with all five kinds that round-trips with `toEqual`.

   Run the SDK test file against the current reader; all cases must pass. The existing tables already cover the other rules, so do not duplicate them.
3. **Replace the declarations in `packages/sdk/src/explore.ts`.**
   - Delete the interface bodies at :35-70.
   - Add `exploreSlugSchema`, `explorePathSchema`, `exploreCtaSchema`, `CTA_KIND_BY_ITEM_KIND`, `explorePreviewSchema`, `exploreItemSchema` and `exploreCatalogSchema` as shown above, placed after the constants and before `exploreSkillSchema`.
   - Export `ExplorePreview`, `ExploreCta`, `ExploreItem` and `ExploreCatalog` as `z.infer` aliases with the same names.
   - Keep `schemaVersion` as the first key of the catalog schema.
   - If `z.literal([1, EXPLORE_SCHEMA_VERSION])` does not type-check under the repository's TypeScript, use `z.union([z.literal(1), z.literal(EXPLORE_SCHEMA_VERSION)])`.
4. **Replace `parseExploreCatalog`** (:605-648) with:

   ```ts
   export function parseExploreCatalog(value: unknown): ExploreCatalog {
     const result = exploreCatalogSchema.safeParse(value);
     if (!result.success)
       throw new ExploreFormatError(`Invalid Explore catalog: ${result.error.message}`);
     return result.data;
   }
   ```

   This is the default and matches :305-312. Alternative, only if Alex asks to keep the old wording: format the first issue as `` `Invalid Explore catalog at ${location}: ${issue.message}` ``. Build `location` from `issue.path`, starting from `catalog`, with `.<key>` for strings and `[<n>]` for numbers. Add one test that pins that string.
5. **Delete the reader family** at :419-603: `JsonObject`, `isObject`, `invalid`, `readObject`, `readString`, `readSlug`, `readPath`, `readKind`, `readDimension`, `readPreview`, `readTags`, `readCta` and `readItem`. Keep `isSlug` (:456-458) beside the constants, because `parseExploreKey` and `readExplorePromptText` still use it. Optionally replace the inline slug regex in `exploreSkillSchema.slug` (:78) with `SLUG_PATTERN`; it is the same pattern.
6. **Checkpoint.**
   - Run the SDK tests and typecheck, the CLI explore test and the web contract test (commands below).
   - Inspect the full diff: only `packages/sdk/src/explore.ts` and the added test cases should change.
   - Run `rg -n "readItem|readCta|readPreview|readTags|readDimension|readKind|readPath|readSlug|readString|readObject|invalid\(" packages/sdk/src/explore.ts`; it must print nothing.
   - Recount with `wc -l packages/sdk/src/explore.ts` against the baseline of 926 lines.

**Verification and acceptance criteria**

Run all commands from the repository root of the implementation worktree. The script names come from `packages/sdk/package.json`, `apps/cli/package.json`, `apps/web/package.json` and the root `package.json`. They were read, not executed, because the audit snapshot has no `node_modules`.

- `pnpm --filter @omnyo/sdk test test/explore.test.ts`: all existing and new cases pass. In particular, every row of the rejection tables still throws `ExploreFormatError`, and the extra-field test still passes, including `Object.keys(catalog)`.
- `pnpm --filter @omnyo/sdk typecheck`: passes.
- `pnpm --filter @omnyo/web test src/explore/sdk-contract.test.ts`: the v2 and v1 round trips of the real website output stay `toEqual`, and filter parity holds.
- `pnpm --filter @omnyo/web typecheck`: passes. This catches an accidentally narrowed `ExploreItem`.
- `pnpm --filter @omnyo/cli test src/__tests__/command-output/explore.test.ts` and `pnpm --filter @omnyo/cli typecheck`: pass. The invalid-catalog case still reports `explore_unavailable`, and `nextStep` still narrows on `cta.kind`.
- Formatting and lint, following the global Oxc rule (not confirmed as a per-package script): `pnpm exec oxfmt packages/sdk/src/explore.ts packages/sdk/test/explore.test.ts`, then `pnpm exec oxlint --deny-warnings --format=agent packages/sdk/src/explore.ts packages/sdk/test/explore.test.ts`. The root also defines `pnpm format:check` and `pnpm lint` (the latter runs `turbo run lint`).
- Performance: no budget exists. One local sample showed a 1.8 ms increase per 500-item parse, and one parse runs per CLI command, so no further benchmark is required. If a reviewer disputes this, repeat the same micro-benchmark: 500 prompt items with a preview, 50 warm-ups, then 200 timed parses of the old and new parser in the same Node process.
- Structural completion:
  - `packages/sdk/src/explore.ts` contains exactly one validation style (zod).
  - The four exported Explore types are `z.infer` aliases.
  - No `read*` helper remains.
  - The file is about 130 to 170 lines shorter than 926.

**Rollback and stop conditions**

The change is confined to one source file and one test file in a private workspace package, and nothing is persisted. Rolling back is reverting that commit; no data or compatibility migration is involved.

Stop and re-plan if any of these happens:

- An existing rejection case is accepted by the new schema.
- The web round trip stops being `toEqual`.
- `pnpm --filter @omnyo/web typecheck` fails because the inferred `ExploreItem` no longer matches the website's type.
- Alex asks to keep UTF-16 length limits exactly. In that case, add a tiny `boundedString(min, max)` refinement using `value.length` for the main catalog's strings and re-measure the saving. If the saving falls below about 80 lines, drop the item.
- An external consumer of `@omnyo/sdk/explore` types appears, such as a newly published SDK build that exports this entry. Then treat the switch from interface to type alias as an API review item before proceeding.

The safer smaller alternative, if the full switch stalls, is to keep the readers and only derive the four types from zod schemas. That alternative is not recommended, because it keeps both mechanisms.
