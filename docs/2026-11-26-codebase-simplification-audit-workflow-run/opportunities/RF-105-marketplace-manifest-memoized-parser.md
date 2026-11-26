# RF-105 — Replace the plugin service's private stored-marketplace cache and the catalog's uncached re-parse with one memoized reader

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication and the per-request re-parse are real. The sweep overstated two points: the reduction is about 10 to 20 handwritten production lines, not 20 to 40, and Explore search already reuses a cached parse for the bundled marketplace.
- **Potential:** low. One of two stored-manifest readers disappears, along with its pruning bookkeeping. Repeated "entry was skipped" log lines stop.
- **Confidence:** high. Every anchor below was re-read at the snapshot.
- **Readiness:** ready. No product decision is needed. The only observable change is fewer log lines, and the wording of one error log line (step 3.3).
- **Effort:** small, about two hours plus the targeted tests.
- **Risk:** low. The main hazard is shared parsed objects being mutated by a caller. Inspection found no in-place mutation (see Context).
- **Prerequisites:** none.
- **Related or overlapping RF items:** none edit these symbols. RF-048 and RF-049 touch the Explore catalog contract in `apps/web` and the SDK, not the server-side stored-manifest reader. RF-103 touches `marketplace-http.ts` response-body reading, which is a different file and mechanism.
- **Why it earns a place:** this is a small, safe consolidation of duplicated knowledge (how a stored marketplace row becomes a manifest, and how a read failure is logged). It also fixes a diagnostic defect: catalog requests re-log the same skip warning every time. It should rank below the structural deletions in this audit.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree had been removed by the time this card was written, so every file was read from the commit with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` in `$OMNYO_CHECKOUT`. No later commit on `main` (HEAD `5f2d3f895`) touches these files: `git log e9e1b74c3..HEAD -- apps/server/src/services/plugin-catalog apps/server/src/services/plugins/plugin-service.ts` printed nothing.

**The subsystem.** Each plugin marketplace (the built-in `omnyo-official` bundled marketplace and any third-party marketplaces the user adds) is stored as a SQLite row whose `manifestJson` column holds the marketplace document. Two server services turn that row back into a typed `MarketplaceManifest`:

1. **Plugin service (cached path).** `apps/server/src/services/plugins/plugin-service.ts`
   - `:707-710` declares `marketplaceManifestCache: Map<string, { manifestJson; manifest: MarketplaceManifest | null }>`.
   - `:1342-1370` `cachedMarketplaceManifest(marketplace)` returns the cached value when `manifestJson` is unchanged. Otherwise it calls `parseStoredMarketplaceManifest` and logs a failure as `failed to read the stored "<name>" marketplace catalog: <message>`, caching `null` on failure.
   - `:1371` `installedCatalogData(rows)` is the only caller (`:1416`). It also prunes the cache: `:1395` clears it when no installed plugin references a marketplace, and `:1406-1410` builds `marketplaceNames` only to delete cache keys for marketplaces that no longer exist.
   - It feeds marketplace category, collection and publisher metadata into the installed-plugin list (`service.list()`).
2. **Catalog service (uncached path).** `apps/server/src/services/plugin-catalog/plugin-catalog-service.ts`
   - `:228-236` `catalogOf(row)` calls `parseStoredMarketplaceManifest(row, deps.warn)` on every call. It logs a failure as the bare error message and returns `null`.
   - Its call sites are `marketplaceView` `:248` (backs `listMarketplaces()` `:1022`), `buildReservedCollectionIndex` `:281`, `resolveEntry` `:764` and `:778` (install and detail resolution), `status()` `:971`, the bundled-icon fallback in `icon()` `:1000`, `search` `:1162` (non-reserved marketplaces only), and the detail result's `marketplaceDisplayName` `:1269`.
   - Routes: `apps/server/src/routes/plugin-catalog.ts:35` (`catalog.status()`), `:47` (`catalog.icon(...)`) and `:128` (`catalog.listMarketplaces()`).
   - `deps.warn` is wired to `deps.logger.warn` at `apps/server/src/server.ts:1512`.

**The shared parser.** `apps/server/src/services/plugin-catalog/marketplace-manifest.ts`:
- `:532-541` `parseStoredMarketplaceManifest(row, warn)` dispatches to `parseBundledMarketplaceManifestJson` for `omnyo-official` (no `warn` is passed) or to `parseMarketplaceManifestJson` otherwise.
- `:413-476` `parseMarketplaceManifestWithBundledPolicy` runs a zod `safeParse` over the whole document. For v2 documents it filters out entries whose npm or git range is not valid semver, calling `warn` once per skipped entry (`:465-468`). The output depends only on `row.name` and `row.manifestJson`, so memoizing on that pair is semantically safe (Proven by inspection).
- `:319-366` `marketplaceManifestIndexes` is a `WeakMap<MarketplaceManifest, index>` keyed by object identity. It backs `marketplaceEntryCategory`, `marketplaceEntryCollections` and `marketplaceCollections`. A fresh parse means a fresh object, so the index is rebuilt for every request that re-parses.

**Corrections to the sweep (Proven by inspection).**
- The catalog already keeps one cache: `reservedCollections` (`plugin-catalog-service.ts:195`, rebuilt at `:554` and `:628`) holds `catalogsByMarketplace` for the bundled marketplace. `search` uses it at `:1161`. So the bundled document is not re-parsed per search. It is still re-parsed per `status()`, `listMarketplaces()`, `resolveEntry`, detail and bundled-icon fallback request. Third-party documents are re-parsed on every path, search included.
- Within one request the WeakMap index is reused, because one parse serves the whole request. It is rebuilt across requests, not within one.
- The bundled path never warns, so the repeated-warning defect affects third-party v2 marketplaces only.

**Consumer search (searches run at the snapshot).**
- `git grep -n "parseStoredMarketplaceManifest\|marketplaceManifestCache\|cachedMarketplaceManifest" e9e1b74c3 -- .` found only the three files above. `parseStoredMarketplaceManifest` is internal to `apps/server`. It is not exported from the SDK or the plugin SDK, so no external plugin or older client can depend on it.
- Tests: `git grep -n "was skipped because\|failed to read the stored" e9e1b74c3 -- '*.test.ts'` found nothing. No test pins the warning count or the plugin-service failure wording. `apps/server/test/services/plugin-catalog/marketplace-manifest.test.ts:255-301` tests the raw parser's skip warnings, which stay unchanged. `apps/server/test/services/plugins/plugin-service.test.ts` around `:990-1130` ("adds marketplace discovery metadata to an installed plugin") rewrites the `acme` row with new `manifestJson` and expects `service.list()` to show the updated category. That test is the invalidation contract the new reader must keep.
- Mutation of parsed manifests: `rg -n "^\s+(catalog|manifest|entry|collection)\.[a-zA-Z.]+\s*=[^=]"` over the three source files found no field assignment. The only in-place array edit, `filteredCatalog.plugins.splice` at `plugin-catalog-service.ts:539`, runs on a `structuredClone` (`:532`). `marketplaceCollections` and `marketplaceEntryCollections` return copies, and `loadBundledMarketplace` (`bundled-marketplace.ts:43-77`) spreads. This search covers direct assignment in these files only. Callers that receive entries (`catalogEntryMetadata`, `catalogSearchResult`, `entryAuthor`) were read and only construct new objects. They were not exhaustively traced, and step 2 below re-checks them.

**Maintenance cost today.** Two readers encode the same "stored row to manifest, log on failure, return null" rule with different failure wording, and only one of them caches. Any change to how stored manifests are read, validated or logged must be made twice. The plugin service also carries pruning code (`:1395`, `:1406-1410`) whose only job is to bound its private map. The catalog re-emits each third-party skip warning on every `status()`, `listMarketplaces()`, search and install-resolution call, which buries real problems in the server log.

**Proposed end state and preservation argument**

- **Canonical owner:** `marketplace-manifest.ts` exports `readStoredMarketplaceManifest(row: { name: string; manifestJson: string }, warn?: (message: string) => void): MarketplaceManifest | null`. A module-level `Map<string, { manifestJson: string; manifest: MarketplaceManifest | null }>` backs it, keyed by marketplace name. On a hit with an equal `manifestJson` string it returns the cached value. Otherwise it calls `parseStoredMarketplaceManifest`, catches any error, sends `warn?.(error instanceof Error ? error.message : String(error))`, caches the result (or `null`) and returns it.
- **What disappears:** `marketplaceManifestCache`, `cachedMarketplaceManifest`, the `.clear()` at `:1395`, and the `marketplaceNames` set and prune loop at `:1406-1410` in `plugin-service.ts`. The catalog's `try/catch` in `catalogOf` also goes.
- **What remains:** `parseStoredMarketplaceManifest` stays as the uncached primitive, with the reader as its only production caller. `catalogOf` becomes a one-line delegate, or each call site calls the reader directly. The `reservedCollections` cache stays, because it also holds the collection and membership index and is swapped atomically on refresh.
- **Why a module-level map is enough:** the result is a pure function of `(name, manifestJson)`, so sharing it across service instances cannot return wrong data. The map holds at most one entry per marketplace name ever seen by the process. That is a handful in practice, so no pruning is needed. A removed marketplace keeps one stale entry until the process restarts. This is accepted, and it is a deliberate simplification over the plugin service's current pruning. The sweep's `prune(names)` helper is unnecessary.
- **Invalidation:** a refresh writes new `manifestJson` (`plugin-catalog-service.ts:597-619`), so the string comparison misses and the reader re-parses. Removing and re-adding a marketplace with the same name and identical JSON returns the cached result, which is correct.
- **Preserved semantics:** the same manifests come back, `null` on failure as before. Category, collection and publisher metadata in `service.list()` are unchanged. Explore search, detail, install resolution, `status()` counts and icons are unchanged. No persisted format, route or public API changes.
- **Intentional observable changes (call these out in the commit message):**
  1. A third-party skip warning and a stored-catalog read failure are logged once per distinct `manifestJson` per process, no longer once per request or per service. Whichever service reads first emits the line. In production both services log through the same server logger.
  2. The plugin service's read-failure line loses its redundant prefix. Today it reads `failed to read the stored "acme" marketplace catalog: invalid stored "acme" marketplace catalog: ...`, and it becomes the catalog's existing form `invalid stored "acme" marketplace catalog: ...`. The parser's message already names the location.
- **Non-goals:** do not cache `catalogEntryMetadata` output or its warnings. Do not replace `reservedCollections`. Do not change the `WeakMap` index. Do not memoize `parseBundledMarketplaceManifestJson` in `loadBundledMarketplace`.

**Expected gain and cost**

Line counts are nonblank lines from `sed -n <range>p <file> | grep -cv '^\s*$'` over the files extracted from the snapshot. The after-state figures are projections.

| Item | Lines |
|---|---|
| Removed from `plugin-service.ts`: cache declaration (4), `cachedMarketplaceManifest` (23), `.clear()` (1), prune set and loop (4) | about 32 |
| Removed from `plugin-catalog-service.ts`: `catalogOf` body shrinks from 8 lines to 3 | about 5 |
| Added to `marketplace-manifest.ts`: the map and `readStoredMarketplaceManifest` | about 20 to 24 |
| **Net handwritten production reduction (projection)** | **about 10 to 20** |
| Tests | Optional: about 15 to 25 added lines for one memoization test (step 4) |

- **Mechanisms:** before, two readers (one cached with its own pruning, one uncached) and two failure wordings. After, one cached reader with one wording and no pruning.
- **Maintenance effect:** a future change to stored-manifest validation, logging or caching is made in one function. The plugin service no longer owns cache lifetime logic.
- **Performance (Hypothesis, not measured):** this avoids a zod parse of each third-party document per catalog request, and of the bundled document per `status()`, `listMarketplaces()`, detail or icon-fallback request. It also keeps the identity-keyed index warm across requests. The bundled document lists every first-party plugin, so the saving is probably sub-millisecond to a few milliseconds per request. The size of a generated bundled document was not measured. The cost is retaining one parsed object per marketplace, which the plugin service already does.

**Execution steps**

1. **Reconfirm the anchors.** In the working checkout, confirm that `catalogOf` still calls `parseStoredMarketplaceManifest` directly, that `marketplaceManifestCache` and `cachedMarketplaceManifest` still exist in `plugin-service.ts`, and that `parseStoredMarketplaceManifest` has no other callers: `rg -n "parseStoredMarketplaceManifest|marketplaceManifestCache|cachedMarketplaceManifest" apps packages`. Re-plan if any of these hold:
   - a third production caller has appeared;
   - a caller now mutates a returned manifest or entry;
   - the parse now depends on anything besides `name` and `manifestJson` (for example host version, settings or the bundled plugin list).
2. **Re-check for mutation.** Read every function in `plugin-catalog-service.ts` and `plugin-service.ts` that receives a value from `catalogOf` or `cachedMarketplaceManifest`, or an entry from its `plugins` array. Confirm none assigns to, pushes into, splices or sorts that object in place. Stop and re-plan if one does: either clone at that site, or freeze the cached value.
3. **Edit `apps/server/src/services/plugin-catalog/marketplace-manifest.ts`.**
   1. Below `parseStoredMarketplaceManifest` (`:532-541`), add:
      ```ts
      const storedMarketplaceManifests = new Map<
        string,
        { manifestJson: string; manifest: MarketplaceManifest | null }
      >();

      export function readStoredMarketplaceManifest(
        row: { name: string; manifestJson: string },
        warn?: (message: string) => void,
      ): MarketplaceManifest | null {
        const cached = storedMarketplaceManifests.get(row.name);
        if (cached?.manifestJson === row.manifestJson) return cached.manifest;
        let manifest: MarketplaceManifest | null = null;
        try {
          manifest = parseStoredMarketplaceManifest(row, warn);
        } catch (error) {
          warn?.(error instanceof Error ? error.message : String(error));
        }
        storedMarketplaceManifests.set(row.name, {
          manifestJson: row.manifestJson,
          manifest,
        });
        return manifest;
      }
      ```
   2. Add a one-line comment saying that the result is a pure function of `(name, manifestJson)`, and that callers must not mutate it.
   3. The failure wording is the one-time choice in this step: use the bare error message, which is the catalog's current form (see the end state).
4. **Optional test.** Add one test to `apps/server/test/services/plugin-catalog/marketplace-manifest.test.ts`. It checks that `readStoredMarketplaceManifest` returns the same object for identical input, emits a skip warning only on the first call, and re-parses when `manifestJson` changes. Use a marketplace name unique to the test (for example `rf105-memo`), because the map is module-level and shared across tests in the same worker.
5. **Edit `apps/server/src/services/plugin-catalog/plugin-catalog-service.ts`.**
   - Replace the body of `catalogOf` (`:228-236`) with `return readStoredMarketplaceManifest(row, deps.warn);`.
   - In the import block (`:78`), swap `parseStoredMarketplaceManifest` for `readStoredMarketplaceManifest`.
   - Leave the call sites alone.
6. **Edit `apps/server/src/services/plugins/plugin-service.ts`.**
   - Delete `marketplaceManifestCache` (`:707-710`) and `cachedMarketplaceManifest` (`:1342-1370`).
   - In `installedCatalogData`, delete `marketplaceManifestCache.clear();` (`:1395`), keeping the early return. Also delete `const marketplaceNames = ...` and the prune loop (`:1406-1410`).
   - Replace `cachedMarketplaceManifest(marketplace)` (`:1416`) with `readStoredMarketplaceManifest(marketplace, (message) => logger.warn(message))`.
   - Swap the import at `:112`. Remove `MarketplaceManifest` from the imports only if nothing else in the file uses it; `:1430` still does.
   - **Checkpoint:** run `pnpm exec tsc --noEmit` in `apps/server` (the `typecheck` script).
7. **Format, lint and inspect the diff.**
   - Run `pnpm exec oxlint --fix <changed files>` and `pnpm exec oxfmt <changed files>` from the repository root, then `pnpm exec oxlint --deny-warnings --format=agent`.
   - Confirm the diff touches only the three source files and the optional test.
   - Confirm `rg -n "marketplaceManifestCache|cachedMarketplaceManifest" apps` returns nothing.
   - Recount the nonblank lines removed and added against the table above.

**Verification and acceptance criteria**

The commands below come from `apps/server/package.json` at the snapshot, which defines `"typecheck": "tsc --noEmit"` and `"test": "vitest run --config vitest.config.ts"`, and from the root `package.json`, which defines `lint`, `typecheck` and `format:check`. These tests were not run for this card because the snapshot had no `node_modules`.

- Run `pnpm run typecheck` in `apps/server`. It must pass.
- Run `pnpm exec vitest run --config vitest.config.ts test/services/plugin-catalog/marketplace-manifest.test.ts test/services/plugin-catalog/plugin-catalog-service.test.ts test/services/plugins/plugin-service.test.ts` in `apps/server`. All tests must pass with no edits to existing assertions.
  - In `plugin-service.test.ts`, the test "adds marketplace discovery metadata to an installed plugin" must still show `Updated Acme tools` after the row is rewritten. That proves invalidation on a `manifestJson` change.
  - The catalog-service search, detail, install, icon and refresh tests prove the parsed result is unchanged.
- The optional new test from step 4 must pass. It covers memoization and warn-once.
- From the repository root, `pnpm exec oxlint --deny-warnings --format=agent` and `pnpm run format:check` must be clean. `format:check` runs `oxfmt . --check`.
- **Structural check:** `rg -n "parseStoredMarketplaceManifest" apps/server/src` shows only the definition and its call inside `readStoredMarketplaceManifest`, and no service owns a stored-manifest cache.
- **Performance:** no budget exists and none is required, because this change only removes work. To quantify the gain, time `GET` on the catalog status and search routes (`apps/server/src/routes/plugin-catalog.ts`) with a large third-party marketplace added, before and after, on the same build.

**Rollback and stop conditions**

- **Rollback:** the change is confined to three source files and an optional test, with no persisted data, route, contract or SDK impact. Reverting the commit restores the previous behavior exactly.
- **Stop if** any of these is found:
  - a caller mutates a returned manifest or entry and cloning at that site is not trivial;
  - the parse gains an input besides `name` and `manifestJson`. Key the cache on that input too, or abandon the change;
  - a test or log consumer (for example a support script that greps server logs) depends on the warning appearing on every request, or on the plugin service's `failed to read the stored` prefix. In that case keep the prefix in the plugin service's `warn` wrapper;
  - module-level sharing causes cross-test interference that unique test names cannot fix.
- **Smaller safer alternative:** if any stop condition holds, give the catalog service its own per-instance reader by creating the same map inside `createPluginCatalogService`. That removes the per-request re-parse and the log spam, but it keeps two caches.
