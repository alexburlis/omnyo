# RF-104 — Delete connect-db's Durable Object presence lookup, its D1 migration applier and the `./testing` package entry

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed, with small scope corrections (see "Context and evidence").
- **Potential:** low to medium. The change removes two dormant mechanisms and one package export, about 79 handwritten production lines. It is small, but every removed line is dead machinery from a platform the product no longer runs on.
- **Confidence:** high. Every removed symbol was searched across the whole snapshot tree, and `@omnyo/connect-db` is a private workspace package with a single consumer (`apps/relay`).
- **Readiness:** ready. No owner decision is needed, because no supported capability is retired.
- **Effort:** small, about 1 to 2 hours including verification.
- **Risk:** low. No persisted format, migration file, route, setting or published package changes.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none overlap. RF-077 (the relay's unused second HMAC token scheme) and RF-111 (relay base-URL policy) are in the same relay area but touch different files. RF-079 (small orphaned helpers kept alive only by their own tests) is the same class of cleanup, but its scope does not include these files.
- **Why it deserves its place:** a reader who changes relay liveness or migration application currently meets a second presence-lookup implementation (a Cloudflare Durable Object fetch behind a `PRESENCE_WRITES` environment flag) and a second migration applier (Cloudflare D1). Neither can run anywhere in the repository. Deleting them leaves one implementation of each.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named by the audit run had been removed by the time this card was written, so all reads used `git -C $OMNYO_CHECKOUT show <commit>:<path>` and `git grep <commit>` against that exact commit.

`packages/connect-db` holds the Drizzle schema, SQL migrations and small shared helpers for the Omnyo account and Connect database. It started life serving Cloudflare Workers (a connect gate worker and a web worker) backed by D1 and Durable Objects. The self-hosted relay in `apps/relay` (Node, `better-sqlite3`) now owns that database. The relay applies migrations with its own journaled applier, `apps/relay/src/migrations.ts:99` `readConnectDbMigrations`, and its build copies `packages/connect-db/migrations` into `dist/migrations/connect-db` (`apps/relay/package.json:13` `build`).

Observed facts (Proven by inspection unless stated otherwise):

1. **Single consumer.** `git grep -l -F "@omnyo/connect-db" <commit>` returns only `apps/relay/**`, `packages/connect-db/package.json` and `pnpm-lock.yaml`. The package is `"private": true` (`packages/connect-db/package.json:5`), so there is no external or published consumer.
2. **No Cloudflare runtime remains.** `git ls-tree -r --name-only <commit> | grep -i "wrangler\|durable\|workers/"` returns nothing. `git grep -n -i "idFromName\|DurableObject\|D1Database" <commit>` matches only `packages/connect-db/src/tunnel-status.ts` and its test.
3. **`packages/connect-db/src/tunnel-status.ts` (64 lines).** Lines 1-4 and 9-52 hold the Durable Object presence lookup: `TUNNEL_STATUS_URL` (`https://tunnel/__control/status`), `TUNNEL_STATUS_HEADER` (`x-omnyo-tunnel-status`), the `TunnelStatusNamespace<Id>` interface, `presenceWritesOnChange`, `readTunnelConnected` and `tunnelConnectedLookup`. Searches for each name, for `PRESENCE_WRITES`, for the header string `x-omnyo-tunnel-status` and for the URL fragment `__control/status` across the whole snapshot match only this file and `packages/connect-db/test/tunnel-status.test.ts`. No config, environment example, Containerfile or doc names `PRESENCE_WRITES`.
4. **What the relay still uses from tunnel-status.ts.** `TunnelConnectedLookup` (lines 5-7) is imported at `apps/relay/src/account/api.ts:23` and `apps/relay/src/account/servers.ts:7`. `isLive` (lines 53-64) is imported at `apps/relay/src/account/api.ts:9`, `apps/relay/src/account/servers.ts:4` and `apps/relay/src/gate/account-routes.ts:2`. The relay supplies its own lookup at `apps/relay/src/account/deps.ts:46` `accountDepsFrom` (`tunnelConnected: async (routingKey) => tunnels.has(routingKey)`), so `tunnelConnectedLookup` has no production caller.
5. **`packages/connect-db/src/testing.ts` (49 lines).** Lines 19-49 (`withoutLineComments`, `connectDbMigrationStatements`, `D1LikeDatabase`, `applyConnectDbMigrationsToD1`) have no reference outside this file. Lines 1-17 (`CONNECT_DB_MIGRATIONS_DIR`, `connectDbMigrationFiles`, `readConnectDbMigration`) are used only by `packages/connect-db/test/account-link-migration.test.ts:16-19` through a relative import (`../src/testing.js`). The near-match `readConnectDbMigrations` in `apps/relay/src/migrations.ts:99` is a different, relay-owned function.
6. **The `./testing` export has no importer.** `packages/connect-db/package.json:12-16` declares `"./testing"`. `git grep -n -F "connect-db/testing" <commit>` returns nothing. The other `./testing` and `src/testing` matches in the tree (`.oxlintrc.json:70,334-335`, `packages/plugin-sdk/scripts/runtime-entries.mjs:16`, `packages/plugin-sdk/src/__tests__/package-exports.test.ts:52`) belong to the plugin SDK.
7. **Correction to the sweep: the migration-reading helper is duplicated in a second test.** `packages/connect-db/test/schema.test.ts:22` defines its own `MIGRATIONS_DIR`, with `migrationFiles` and `applyMigration` at lines 36-44 and an inline loop in `beforeEach` at lines 50-57. These repeat the logic in `testing.ts:5-17`. Moving the two kept helpers into one test-only module lets both tests share it.
8. **Optional, lower value: the D1 branch in `rowsChanged`.** `packages/connect-db/src/write-result.ts:4-12` reads `result.meta.changes`, the D1 result shape. The relay opens its database with `drizzle-orm/better-sqlite3` (`apps/relay/src/db.ts:1-6`), whose run results carry a top-level `changes`, handled at `write-result.ts:14-16`. `git grep -n "meta\.changes\|meta: *{"` over `apps/relay` and `packages/connect-db` matches only `write-result.ts`. However, the `ConnectDb` type (`packages/connect-db/src/availability.ts:7-11`, `BaseSQLiteDatabase<"sync" | "async", ...>`) still admits async drivers, so the compiler would not flag a future D1-shaped caller. This branch is 9 non-blank lines; treat it as optional.
9. **`MAX_PER_ACCOUNT` is test-only, but the move is not worth doing.** `packages/connect-db/src/constants.ts:103` (`500`) is referenced only by `apps/relay/src/account/account.test.ts`. Production passes `MAX_SERVERS_PER_USER` (`apps/relay/src/contracts.ts:27`, `5`) at `apps/relay/src/account/routes.ts:628`. Moving one constant into a test file is cosmetic, so it is excluded from this card.
10. **History.** `git log` at the snapshot shows `1018d5621` (2026-10-01) "Let the connect gate hold visitor responses in the Worker and read presence from tunnel objects (off in production) (#4597)" as the origin of the presence helpers, and `060950255` (2026-11-24) "Publish Omnyo source" as the latest change. The sweep cited commit `e233452617` for the worker removal; that object does not exist in this repository (`git log -1 e233452617` fails), so the removal date of 2026-11-11 is unverified here. The current tree state in facts 2 to 6 is what proves the code is dead.

Counterevidence considered: `packages/connect-db/migrations/README.md` and several SQL comments still describe D1 and worker deploy ordering. They are migration history for persisted schema and must stay. `apps/relay/scripts/load-smoke.mjs:117` reads the migrations directory directly and does not use `testing.ts`.

Maintenance cost today: two presence-lookup paths (a Durable Object fetch plus an environment flag, and the relay's in-process tunnel registry), two migration appliers (D1 statement splitting, and the relay's journaled applier), about 95 non-blank test lines that keep the dead path green, and a package export that implies an external testing contract that does not exist.

**Proposed end state and preservation argument**

- `packages/connect-db/src/tunnel-status.ts` keeps only `TunnelConnectedLookup` and `isLive`, unchanged in signature and behavior. The relay's `apps/relay/src/account/deps.ts:46` `tunnelConnected` remains the single presence lookup.
- `packages/connect-db/src/testing.ts` is deleted, and the `"./testing"` entry is removed from `packages/connect-db/package.json`. The relay's `apps/relay/src/migrations.ts` remains the single migration applier.
- A new test-only module `packages/connect-db/test/migration-files.ts` holds `connectDbMigrationFiles` and `readConnectDbMigration` (moved from `testing.ts:5-17`). `account-link-migration.test.ts` and `schema.test.ts` both import it. The file name does not end in `.test.ts`, so `packages/connect-db/vitest.config.ts` (`include: ["test/**/*.test.ts"]`) does not collect it as a test, and `packages/connect-db/tsconfig.json` (`include: ["src", "test"]`) still type-checks it.
- `packages/connect-db/test/tunnel-status.test.ts` keeps only the `isLive` cases (lines 117-140). Their wording about "the tunnel object" can say "the tunnel registry", but that is optional.
- Optional: `rowsChanged` keeps only the top-level `changes` branch.

Preservation argument: no relay import changes, because `isLive`, `TunnelConnectedLookup`, `rowsChanged` and every other root export stay in place. No migration SQL, journal, snapshot or README changes, so persisted databases and the relay's journaled applier are untouched. No route, header, environment variable or UI state depends on the removed code (facts 3 and 6).

Non-goals: changing `ConnectDb`'s `"sync" | "async"` type, editing migration files or `migrations/README.md`, touching `app-links.ts` or the `ai_*` schema, and moving `MAX_PER_ACCOUNT`.

Remaining uncertainty: a developer could hold an out-of-tree script that imports `@omnyo/connect-db/testing`. That is a Hypothesis with no evidence. The package is private and unpublished, so such a script could only exist inside this monorepo, and the search in fact 6 covers the whole monorepo.

**Expected gain and cost**

Counts are from `git show <commit>:<file> | sed -n '<a>,<b>p' | grep -cv '^\s*$'` (non-blank lines) and physical line ranges.

| Item | Physical lines | Non-blank lines | Kind |
|---|---|---|---|
| `tunnel-status.ts` lines 1-4 and 9-52 | 48 | 38 | production, deleted |
| `testing.ts` lines 19-49 | 31 | 26 | production, deleted |
| `testing.ts` lines 1-17 | 17 | 14 | moved from production to a test helper, not deleted complexity |
| `package.json` `"./testing"` entry | 5 | 5 | package manifest |
| `write-result.ts` lines 4-13 (optional) | 10 | 9 | production, deleted |
| `tunnel-status.test.ts` lines 2-115 (keeping an `isLive` import) | about 112 | about 94 | test, deleted |
| `schema.test.ts` duplicate helpers (lines 22, 36-44, 50-57) | about 15 removed, about 2 import lines added | | test dedup |

- Production: about 79 handwritten lines deleted (64 non-blank), or about 89 with the optional `rowsChanged` step. The `src` directory shrinks from 765 to about 670 lines, because the 17 moved lines also leave `src`.
- Tests: about 112 lines deleted, plus about 13 net lines from sharing the migration helper.
- Mechanisms: two presence lookups become one, two migration appliers become one, and one package export disappears.
- Cost: one new test helper file of about 17 lines.
- Performance: neutral. No runtime code path in the relay changes.

**Execution steps**

1. **Reconfirm the baseline.** In the working checkout, run `git grep -n -e TUNNEL_STATUS_URL -e TUNNEL_STATUS_HEADER -e presenceWritesOnChange -e readTunnelConnected -e tunnelConnectedLookup -e PRESENCE_WRITES -e applyConnectDbMigrationsToD1 -e connectDbMigrationStatements -e D1LikeDatabase -e "connect-db/testing"` and `git grep -l -F "@omnyo/connect-db"`. Expect matches only in `packages/connect-db/src`, `packages/connect-db/test`, `apps/relay` (for the package name) and `pnpm-lock.yaml`. Re-plan if any match appears in another app, a plugin, a script, a Containerfile, a `.env` example or docs, or if a Cloudflare worker (`wrangler.*`) has returned to the tree.
2. **Missing evidence.** None needs to be created. The `isLive` cases in `tunnel-status.test.ts`, `account-link-migration.test.ts`, `schema.test.ts` and the relay test suite already cover everything that remains.
3. **Checkpoint A: the presence lookup.**
   - In `packages/connect-db/src/tunnel-status.ts`, delete `TUNNEL_STATUS_URL`, `TUNNEL_STATUS_HEADER`, `TunnelStatusNamespace`, `presenceWritesOnChange`, `readTunnelConnected` and `tunnelConnectedLookup`. Keep `TunnelConnectedLookup` and `isLive` byte-for-byte.
   - In `packages/connect-db/test/tunnel-status.test.ts`, delete `namespaceAnswering`, `statusResponse` and the `readTunnelConnected` and `presence mode` describe blocks. Reduce the import to `import { isLive } from "../src/index.js";`. Keep the `isLive` describe block and its assertions unchanged.
   - Keep `packages/connect-db/src/index.ts:15` (`export * from "./tunnel-status.js";`).
   - Verify with the connect-db typecheck and test commands below.
4. **Checkpoint B: the D1 applier and the `./testing` entry.**
   - Create `packages/connect-db/test/migration-files.ts` containing `CONNECT_DB_MIGRATIONS_DIR` (pointing at `new URL("../migrations", import.meta.url)`, which resolves the same from `test/` as from `src/`), `connectDbMigrationFiles()` and `readConnectDbMigration(file)`, moved verbatim from `testing.ts:1-17`.
   - In `packages/connect-db/test/account-link-migration.test.ts:16-19`, change the import to `from "./migration-files.js"`.
   - In `packages/connect-db/test/schema.test.ts`, replace `MIGRATIONS_DIR` (line 22), `migrationFiles` (lines 36-40) and the body of `applyMigration` (lines 42-44) with the shared helpers: `migrationFiles` becomes `connectDbMigrationFiles`, and `applyMigration(sqlite, file)` calls `sqlite.exec(readConnectDbMigration(file))`. Replace the inline loop in `beforeEach` (lines 54-57) with `for (const file of connectDbMigrationFiles()) applyMigration(sqlite, file);`. The order and filter are the same: sorted `.sql` files. Remove `readdirSync`, `readFileSync`, `join` and `fileURLToPath` from the imports if nothing else in the file uses them.
   - Delete `packages/connect-db/src/testing.ts`.
   - Remove the `"./testing"` block from `packages/connect-db/package.json` `exports`, keeping `"."` and the `"files": ["migrations"]` entry.
   - No install is needed, because `pnpm-lock.yaml` does not record package exports. Confirm that `git diff pnpm-lock.yaml` is empty.
   - Verify with the connect-db typecheck and test commands below.
5. **Optional checkpoint C: the D1 result shape in `rowsChanged`.** In `packages/connect-db/src/write-result.ts`, delete the `meta.changes` branch (lines 4-12) and keep the top-level `changes` branch. Skip this step if any caller is found that passes a D1 or async-driver result. Verify with the relay test suite, which exercises `rowsChanged` through `apps/relay/src/account/account.ts` (lines 249, 362, 435, 445, 475, 801, 830) and `apps/relay/src/account/api.ts:280` against `better-sqlite3`.
6. **Clean up and recount.** Format and lint the touched files. Inspect `git diff --stat` for unrelated changes. Recount with `wc -l packages/connect-db/src/*.ts` (expected about 670 lines, or about 660 with step 5) and confirm the step 1 search now returns nothing for the removed symbols.

**Verification and acceptance criteria**

These commands were read from `package.json` scripts at the snapshot but not run, because the audit snapshot has no `node_modules`.

- From `packages/connect-db`: `pnpm typecheck` (script `tsc --noEmit`) and `pnpm test` (script `vitest run --config vitest.config.ts`). Expected result: all remaining tests pass, including the `isLive` cases, every `schema.test.ts` case and the `0006 account link and AI usage` cases. Equivalent from the repository root: `pnpm --filter @omnyo/connect-db typecheck` and `pnpm --filter @omnyo/connect-db test`.
- From `apps/relay`: `pnpm typecheck`, `pnpm test` and `pnpm lint` (script `oxlint --deny-warnings src scripts`). Expected result: no import errors and no test changes. The relay must not need any edit.
- From `$OMNYO_CHECKOUT`: `pnpm exec oxfmt <touched files>` and `pnpm exec oxlint --deny-warnings --format=agent packages/connect-db`. `packages/connect-db` has no `lint` script of its own, so the root `oxlint` invocation is the check.
- Optional build proof that migrations still ship: from `apps/relay`, `pnpm build` (script `build`), then confirm `dist/migrations/connect-db/0008_credential_hash_indexes.sql` exists. Remove the `dist` output afterwards if it was not already present.
- Structural completion: `git grep -n -e presenceWritesOnChange -e readTunnelConnected -e tunnelConnectedLookup -e TUNNEL_STATUS -e PRESENCE_WRITES -e applyConnectDbMigrationsToD1 -e D1LikeDatabase -e connectDbMigrationStatements` returns nothing. `packages/connect-db/src/testing.ts` is gone. `packages/connect-db/package.json` has one export. `packages/connect-db/test/schema.test.ts` no longer defines its own migrations directory.
- Behavior and contract checks: `isLive` semantics (a non-null `tunnelConnected` wins, otherwise the strict `< offlineAfterMs` window applies) are pinned by the kept `isLive` cases. Migration order and content are pinned by `schema.test.ts` and `account-link-migration.test.ts`, which must pass without changes to their assertions.
- No UI, visual or performance comparison applies, because no UI or runtime hot path changes.

**Rollback and stop conditions**

- Rollback boundary: each checkpoint is one self-contained commit that touches only files under `packages/connect-db`, with no diff in `apps/relay`. Reverting the commit restores the previous state exactly. There are no data or compatibility implications, because no persisted format changes.
- Stop if the step 1 search finds a consumer outside `packages/connect-db` for any removed symbol or for `@omnyo/connect-db/testing`, if a Cloudflare worker or D1 deployment has been reintroduced, or if Alex reports a planned return to Workers. In that case keep the code and record the consumer.
- Stop at checkpoint C, and keep the `meta.changes` branch, if any relay or future caller is found that uses an async or D1 driver with `ConnectDb`.
- If `schema.test.ts` fails after the helper swap, revert only that file's helper change and keep the shared helper for `account-link-migration.test.ts`. The failure would mean the migration order or filter differed, which must be investigated before retrying.
