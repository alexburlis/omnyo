# RF-063 — Declare the 44 SDK-called plugin, marketplace and skills-registry routes once in `publicApiRoutes` and retire the SDK's two hand-built request helpers

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: these routes are the only large untyped JSON cluster left on `/api/v1`, and the SDK re-encodes their paths and methods by hand. The sweep's plan and numbers needed three corrections. First, the server must keep its own validation and error bodies, because tests and the CLI pin them. Second, the descriptor system needs a small extension. Third, the net line change is clearly positive, not neutral.
- **Potential:** low. This is a consistency and safety consolidation, not a burden deletion. The path and method of each route are declared once and checked by the compiler instead of being matched by hand. Server response bodies become type-checked against the declared contract. Handwritten production lines grow.
- **Confidence:** medium. The facts are proven by inspection, and the hc URL behaviour was reproduced. The type-check cost of 44 more hc routes and the exact descriptor line count remain projections.
- **Readiness:** conditional. Two gates come before any edit. Gate A: decide how to keep the SDK's trailing-slash base-URL behaviour (see ISS candidate below). Gate B: a one-group pilot must show that handler-validated descriptors, `prefer` headers and a 204 response work and that type-check time stays acceptable.
- **Effort:** medium to large, about 3 to 5 working days. Most of that time is per-route response typing (the 2 to 4 status and body shapes each route returns) and keeping the pinned error contracts.
- **Risk:** medium. This touches every plugin lifecycle, marketplace and skills-registry HTTP contract used by the web app, mobile, the CLI and plugins, through the private `@omnyo/sdk`. The regressions most likely to slip in are a changed 400/422 status or error text, base-URL double slashes, unencoded path parameters and a dropped `prefer: respond-async` header.
- **Prerequisites:** Gate A and Gate B below.
- **Related or overlapping work:**
  - RF-108 (derive route path parameters from the descriptor path) would shorten every descriptor here. Do it first if it is scheduled.
  - RF-109 (keep one typed-route registration form) is compatible as long as this card uses the descriptor form `post(routes.x, handler)`, which it does.
  - RF-107 (route CLI plugin settings and lifecycle commands through the SDK) is complementary. After RF-063, `apps/cli/src/commands/plugin.ts` `callPlugins` would gain typed paths through the SDK. RF-063 does not remove `callPlugins`.
  - RF-033 (one serial job-queue core for install and update jobs) touches the services behind two of these route files. Its edits do not conflict with this card.
  - RF-032 (the app's second HTTP client) is unrelated except that `apps/app` direct fetches stay out of scope here.
- **Why this rank:** the work removes a second route convention that maintainers must otherwise know about, plus two private SDK fetch helpers. It adds roughly 350 to 500 net lines, and current runtime zod parsing and SDK URL tests already catch much of the drift it guards against. It belongs below every item that deletes machinery.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26), inspected from a `git archive` extraction because the audit worktree was absent. No `node_modules` exist in the snapshot, so no test suite ran. All test claims below come from reading test files.

How the typed route table works, proven by inspection:

- `packages/server-contract/src/public-api.ts:617` `publicApiRoutes` holds about 297 `defineRoute({ path, method, request, response })` descriptors. `PublicApiSchema` (line 2905) derives the Hono schema from them. `packages/server-contract/src/api-client.ts:29` `createApiClient` builds an `hc<PublicApiRoutes>` client at `` `${baseUrl}/api/v1` ``.
- The SDK reaches typed routes through `transport.api.v1.*` plus `transport.readJson` (`packages/sdk/src/transport.ts`, `packages/sdk/src/transport-http.ts:11` `createHttpTransport`).
- Server route files register descriptors through `typedRoutes<PublicApiSchema>(app, { onValidationError: (msg) => new ApiError(400, "invalid_request", msg) })`, for example `apps/server/src/routes/projects.ts:385`.
- `packages/hono-typed-routes/src/typed-routes.ts` `typedRoutes` parses the `json` and `query` sources with zod. It throws `onValidationError` on a parse failure and throws `"Invalid JSON request body"` when the body is empty or invalid. The `none` and `form` sources pass the handler through untouched.
- `packages/hono-typed-routes/src/route-descriptor.ts` `RouteResponseDescriptor` limits `Status` to `ContentfulStatusCode`, so there is no 204 response kind. `noRequest<Input>()` lets the hc input type be any shape while the server parses nothing.

The untyped cluster, proven by inspection with `rg -n "\b(app|publicApi)\.(get|post|put|patch|delete|all)\(\s*\"/"` over `apps/server/src`:

| File | Raw registrations |
|---|---|
| `apps/server/src/routes/plugins.ts` | 28 |
| `apps/server/src/routes/skills-registry.ts` | 12 |
| `apps/server/src/routes/plugin-catalog.ts` | 9 |
| `apps/server/src/routes/plugin-install-jobs.ts` | 3 |
| `apps/server/src/routes/plugin-update-jobs.ts` | 2 |

That is 54 raw registrations. Outside these files only a handful of raw routes remain on the public API (`apps/server/src/routes/server-maintenance.ts:88`, `apps/server/src/routes/web-error-reporting.ts:154`), plus non-API routes in `apps/server/src/server.ts`. All five files are mounted on `publicApi` in `apps/server/src/server.ts:1553-1568`.

How the SDK re-encodes these routes, proven by inspection:

- `packages/sdk/src/areas/plugins.ts` (870 lines, 25 `/api/v1/` literals):
  - `pluginPath` (line 386) and `installJobPath` (line 418) build the paths by hand.
  - `createPluginsArea` (line 392) holds a private `requestParsed` (line 395) that calls `transport.fetch` directly and then `transport.resolve`. It holds `jsonInit` (line 410) for request bodies.
  - `requestUpdate` (line 446) and `requestInstall` (line 496) add `prefer: respond-async`.
  - Runtime compatibility defaults live in `installedPluginResponseSchema` (line 76, `.default([])` and `.default({})` fields) and `pluginCatalogSearchResponseCompatibilitySchema` (line 104). These must survive the change.
- `packages/sdk/src/areas/skills.ts` (369 lines, 12 literals) has a second `requestParsed` (line 132) and `jsonPost` (line 146). `registry.discardStage` (line 173) builds its own URL and expects a 204.
- The SDK calls 44 distinct routes:
  - Plugins (32): `GET /plugins`, `GET /plugins/rpc`, `POST /plugins/:id/rpc/:method`, `POST /plugins/updates/check`, `GET /plugins/updates`, `POST /plugins/cache/prune`, `POST /plugins/relocate`, `POST /plugins/:id/update`, `POST /plugins/install`, `GET /plugins/:id/source`, `POST /plugins/reload`, `GET` and `PUT /plugins/safe-mode`, `POST /plugins/:id/enable`, `POST /plugins/:id/disable`, `GET` and `PUT /plugins/:id/settings`, `DELETE /plugins/:id`, `POST /plugins/:id/token`, `GET /plugins/install-jobs`, `GET /plugins/install-jobs/:jobId`, `POST /plugins/install-jobs/:jobId/cancel`, `GET /plugins/update-jobs`, `GET /plugins/update-jobs/:jobId`, `GET /plugin-catalog`, `GET /plugin-catalog/search`, `GET /plugin-catalog/install-plan`, `POST /plugin-catalog/install`, `GET` and `POST /marketplaces`, `POST /marketplaces/refresh`, `DELETE /marketplaces/:name`.
  - Skills registry (12): `GET /skills-registry`, and `POST` for `search`, `entries`, `stage`, `stage/file`, `stage/discard`, `installed`, `commit` and `install`. `GET` for `entry`, `repository-stars` and `detail`.
- The request and response zod schemas already exist in `packages/server-contract/src/api/plugins.ts` (834 lines) and `packages/server-contract/src/api/skills.ts` (137 lines).

Routes that stay raw because they are not JSON request/response endpoints, or because the SDK does not call them:

- `apps/server/src/routes/plugins.ts`:
  - `/plugins/:id/cli` (line 572) streams.
  - `/plugin-app-assets/:hash/:file` (line 623), `/plugins/:id/assets/icons/:file` (line 667) and `/plugins/:id/assets/:file` (line 687) serve assets.
  - `/plugins/:id/http/*` is the websocket upgrade and passthrough (lines 1099 and 1106).
  - `/plugins/contributions` (line 528) and `/plugins/mentions/search` (line 535) are fetched directly by `apps/app/src/hooks/queries/plugin-contribution-queries.ts:51` and `:141`.
  - `/plugins/:id/logs` (line 747) is called only by the CLI.
- `/plugin-catalog/icons/:marketplace/:entryId` (`apps/server/src/routes/plugin-catalog.ts:46`) returns binary icons.

Error contracts the change must preserve, proven by inspection:

- The handlers use three different error envelopes and several statuses:
  - `{ ok: false, error }` with 400, 404 or 409, for example `plugins.ts:984` enable, `:1018` settings and `:1047` delete.
  - `{ error }` with 400, 404, 413 or 422, for example `plugins.ts:763` updates/check, `:838` update and all of `plugin-catalog.ts`.
  - The standard `ApiError` body `{ code, message }`, as in `skills-registry.ts`.
- Validation failures return route-specific text. Some return 422 rather than 400, for example `plugins.ts:912` install and every `plugin-catalog.ts` body or param check.
- Several handlers accept input that `typedRoutes` would reject:
  - `POST /marketplaces/refresh` (`plugin-catalog.ts:155`) accepts an empty body (`json ?? {}`).
  - `POST /plugins/:id/token` (`plugins.ts:1066`) accepts an empty text body.
  - `POST /plugins/:id/update` (`plugins.ts:838`) streams the body with a `MAX_BUNDLED_PLUGIN_REQUEST_BYTES` 413 cap.
  - `POST /plugins/:id/rpc/:method` (`plugins.ts:1160`) accepts an empty body and returns its own `invalid_json` envelope.
  - `POST /plugins/reload` (`plugins.ts:957`) and `POST /skills-registry/search` (`skills-registry.ts:81`) combine query parameters with a POST body.
- Tests pin these bodies:
  - `apps/server/test/services/plugin-catalog/plugin-catalog-routes.test.ts` asserts 422 and error text at lines 105, 116, 293-346 and 378-412.
  - `apps/server/test/services/plugins/plugin-safe-mode-route.test.ts:84-87` asserts 400 with `error: "expected { enabled: boolean }"`.
  - `apps/server/test/services/plugins/plugin-reload-route.test.ts:73` asserts 422.
- The CLI reads these bodies directly. `apps/cli/src/commands/plugin.ts:431` `callPlugins` accepts 400, 404, 409 and 422 responses and prints their `error`. It is used for reload, enable, disable, settings, token, logs and remove (lines 1994-2485).

Base-URL and encoding behaviour, reproduced with the locally installed `hono@4.13.18` (the version `packages/server-contract/package.json` requires):

- With a base of `"http://omnyo.test/"`, `hc` produced `http://omnyo.test//api/v1/plugins`.
- A vanilla Hono app returned 404 for the `//api/v1/plugins` path.
- `hc` inserted the path parameter `"a b"` unencoded.
- The current SDK helpers strip the trailing slash and call `encodeURIComponent`. `packages/sdk/test/sdk.test.ts:2250` and `:2381` deliberately use `baseUrl: "http://omnyo.test/"` and expect single-slash URLs for plugin routes.
- `packages/sdk/src/areas/previews.ts:69` shows the existing convention for typed routes: pass `encodeURIComponent(id)` as the `param` value.

Other consumers checked:

- `rg` over `apps`, `packages` and `plugins` for these path prefixes found the CLI proxy (`apps/cli/src/plugin-cli-proxy.ts:212`, `:273`, `:466`), desktop and plugin RPC fetches, app direct fetches (`apps/app/src/lib/plugin-sdk-hooks.ts:211`, `:285`), and the boot dispatcher's `BOOT_PART_PATHS` (`packages/server-contract/src/api/boot.ts:24`). That dispatcher replays `/plugins`, `/plugins/install-jobs`, `/plugins/update-jobs` and `/plugins/safe-mode` through `app.fetch`.
- Usage telemetry matches the pathname `/api/v1/plugins/install` (`packages/domain/src/usage-telemetry.ts:229`).
- None of these depend on how the routes are registered, only on the unchanged paths, methods and bodies.
- `packages/plugin-sdk/scripts/public-api-stub.d.ts` stubs `publicApiRoutes`, so the packed plugin SDK does not expose these types.
- `@omnyo/sdk` is `"private": true`, version 0.0.1.
- The SDK imports `public-api.ts` only as types (`api-client.ts` uses `import type`), so SDK and app bundles should not grow. This is a hypothesis until a build confirms it.

Maintenance cost today: adding or renaming one of these routes means editing a string path in the server and in the SDK. Nothing fails at compile time if they diverge. Runtime zod parsing in the SDK and the roughly 15 URL assertions in `packages/sdk/test/sdk.test.ts` (about lines 2419-2470 and 2695-2770) catch some drift. Server handlers return untyped bodies that the SDK's schemas only check at runtime.

**Proposed end state and preservation argument**

What disappears:

- In the SDK, both private `requestParsed` helpers, `jsonInit`, `jsonPost`, `pluginPath`, `installJobPath` and the hand-built URL in `discardStage`.
- All 37 `/api/v1/` path literals in `packages/sdk/src/areas/plugins.ts` and `packages/sdk/src/areas/skills.ts`.
- The string paths in the 44 server registrations.

What remains:

- One descriptor per route under `publicApiRoutes.plugins`, `publicApiRoutes.pluginCatalog`, `publicApiRoutes.marketplaces` and `publicApiRoutes.skillsRegistry`. Each is registered by the existing server handler through `typedRoutes` descriptor form, and the SDK calls it through `transport.api.v1.*`.
- The SDK still runs its zod response schemas on the JSON that `readJson` returns. That keeps the compatibility defaults (`installedPluginResponseSchema`, `pluginCatalogSearchResponseCompatibilitySchema`).
- The 10 non-JSON or non-SDK routes listed above stay raw.

Preservation rule: the server keeps handler-owned validation for every route in this card, so every status, envelope and message stays byte-identical. This needs one explicit request kind in `packages/hono-typed-routes/src/route-descriptor.ts`, for example `handlerParsedRequest<Input>()`. It returns `{ source: "none" }` but carries the hc input type (`param`, `query`, `json`). It is equivalent to `noRequest<Input>()` but named for its purpose. The handler goes on reading `context.req.json()`, `context.req.text()` or the raw stream exactly as today. A `noContentResponse()` kind (status 204, format `"binary"` or a new `"empty"` format) covers `stage/discard`. Moving any route to zod-parsed `jsonRequest` or `queryRequest` would change its observable 400/422 behaviour. That is a separate product decision and a non-goal here.

Every response descriptor lists each status and body the handler returns. For example, enable declares `jsonResponse<{ ok: true; plugin: InstalledPlugin }>()` and `jsonResponse<PluginRouteFailure>({ status: 404 })`. Use small shared types such as `PluginRouteFailure = { ok: false; error: string }` and `PluginRouteError = { error: string }`, and do not unify the envelopes. Statuses that come from `localAuthProblem` (`plugins.ts:224`) must be declared with their exact literal union.

SDK call preservation:

- Pass `encodeURIComponent(value)` for every `param`, matching `previews.ts`.
- Keep query key order (`q`; `entryId`, `marketplace`; `page`, `perPage`; `pluginId`, `method`; `id`) so the pinned URLs stay identical.
- Keep sending the same bodies, including `{}` for enable, disable, reload, cancel and update.
- Pass `prefer: respond-async` through the hc per-request `headers` option.
- Pass `signal` through `signalRequestArgs` (`packages/sdk/src/areas/common.ts`).
- Keep the trailing-slash behaviour as decided in Gate A.

Non-goals:

- No change to route paths, methods, statuses, bodies or registration order.
- No change to the CLI's `callPlugins`; RF-107 covers that.
- No change to `apps/app` direct fetches.
- The 10 excluded raw routes are not touched.
- The error envelopes are not unified.

**Expected gain and cost**

| Measure | Before | After | Basis |
|---|---|---|---|
| Places that declare a route's path and method | 2 (server string and SDK string), unchecked | 1 descriptor, with compiler-checked references | Proven by inspection |
| SDK request mechanisms for these areas | 2 (hc for other areas; raw `transport.fetch` helpers here) | 1 (hc) | Proven by inspection |
| Typed server response bodies on these routes | 0 of 44 | 44 of 44 | Projection |
| Untyped JSON registrations on `/api/v1` | 54 in these files | 10, all non-JSON or out of scope | Proven by inspection |

Line estimates are projections. The method assumes about 8 to 11 lines per descriptor, because most routes need a 2- to 4-entry response array, and was checked against the existing descriptors in `public-api.ts`.

| Area | Change |
|---|---|
| Contract (`public-api.ts`, plus descriptor imports and shared failure types) | +400 to +550 lines |
| `packages/hono-typed-routes` request and response kinds | +15 to +30 lines |
| Server (`typedRoutes` setup in 5 files; path swaps are neutral) | +15 lines |
| SDK (helper removal; each call stays about the same length) | −50 to −90 lines |
| **Net handwritten production change** | **about +350 to +500 lines** |

The sweep estimated −30 to +60 lines because it assumed the server's `safeParse` blocks would be deleted. They must stay to preserve the error contracts. Tests may also change: SDK URL tests should pass unchanged, and a few hono-typed-routes tests are added for the new request and response kinds.

Maintenance effect, a projection: renaming or reshaping one of these routes still means editing the descriptor, the handler and the SDK call. A missed edit now fails type-checking instead of failing at runtime or in a URL test. A new maintainer learns one route convention for all JSON `/api/v1` routes.

Performance: runtime is neutral by inspection, since the same handlers and fetches run. Type-check time for `@omnyo/sdk`, `@omnyo/server-contract`, `@omnyo/server` and the app is uncertain: hc schema instantiation grows by about 15% more routes. Gate B measures it. Bundle size is expected to be neutral, because the SDK uses type-only imports of `public-api.ts`. This is a hypothesis that one build confirms.

**Execution steps**

1. **Reconfirm the snapshot.** On a fresh checkout, re-run the registration count and SDK literal count from Context. Confirm that `publicApiRoutes` still has no `plugins`, `pluginCatalog`, `marketplaces` or `skillsRegistry` group. Check whether RF-108 or RF-109 has landed, because either changes the descriptor and registration syntax. Re-plan if any of the 44 routes has already moved, or if `typedRoutes` has gained different request kinds.

2. **Gate A: decide the base-URL behaviour.** Today the plugin and skills SDK calls strip a trailing slash from `baseUrl`, but hc-based calls do not (reproduced, see the ISS candidate). Choose one of two options:
   - (a) Recommended: first land a separate, behaviour-fixing change that trims trailing slashes in `packages/sdk/src/transport-http.ts` `createHttpTransport` before `createApiClient`, with its own test, then continue.
   - (b) If the owner does not want that transport-wide fix, stop. The shared hc client cannot strip the slash for these areas alone, so migrating them without the fix would break trailing-slash base URLs that work today.

   Do not fold the fix into this refactor's commits.

3. **Gate B: pilot one group.** Use the install-jobs and update-jobs group (5 routes) plus `skills-registry/stage/discard` (204) and `POST /plugins/:id/update` (streamed body plus the `prefer` header).
   - In `packages/hono-typed-routes/src/route-descriptor.ts`, add `handlerParsedRequest<Input>()`, returning `{ source: "none" }` with the declared input type. Add `noContentResponse()` and extend `EndpointFromRouteResponse` or `Endpoint` as needed, so hc types a 204 as an empty response.
   - In `packages/hono-typed-routes/src/typed-routes.ts`, confirm that `registerDescriptor` already passes `none` handlers through. Add tests to `packages/hono-typed-routes/test/typed-routes.test.ts` for both kinds.
   - Add `publicApiRoutes.plugins.installJobs.{list,get,cancel}`, `publicApiRoutes.plugins.updateJobs.{list,get}`, `publicApiRoutes.plugins.applyUpdate` and `publicApiRoutes.skillsRegistry.discardStage` to `packages/server-contract/src/public-api.ts`, with full response arrays (for example, `get` declares `{ job }` 200 and `{ error: string }` 404).
   - Register the routes in `apps/server/src/routes/plugin-install-jobs.ts` `registerPluginInstallJobRoutes`, `apps/server/src/routes/plugin-update-jobs.ts` `registerPluginUpdateJobRoutes`, `apps/server/src/routes/plugins.ts` (update handler only) and `apps/server/src/routes/skills-registry.ts` (discard only), using `const { get, post } = typedRoutes<PublicApiSchema>(app, { onValidationError: (msg) => new ApiError(400, "invalid_request", msg) })`. Keep the handler bodies verbatim.
   - Switch `installJobs`, `updateJobs` and `requestUpdate` in `packages/sdk/src/areas/plugins.ts`, and `registry.discardStage` in `packages/sdk/src/areas/skills.ts`, to `transport.api.v1.plugins["install-jobs"][":jobId"].$get({ param: { jobId: encodeURIComponent(id) } }, ...signalRequestArgs(signal))` and the equivalent calls. Then use `transport.readJson` followed by the existing schema `.parse`, or `transport.readVoid` for discard. Pass `{ headers: { prefer: "respond-async" } }` for update.
   - Measure `tsc --noEmit` wall time for `packages/sdk`, `packages/server-contract` and `apps/server` before and after on the same machine. Run each three times and compare medians.
   - Checkpoint: the SDK, server and typed-routes tests named below pass unchanged. Stop if the pilot needs per-route type casts, if hc cannot express the 204 or the `prefer` header, or if type-check time regresses noticeably (agree a threshold with the owner before measuring; none exists in the repository).

4. **Plugin lifecycle routes in `apps/server/src/routes/plugins.ts` `registerPluginRoutes`.** Convert, in the existing registration order: `GET /plugins/rpc`, `GET /plugins`, updates/check, updates, cache/prune, relocate, install, `:id/source`, reload (query `id` plus body), safe-mode GET and PUT, enable, disable, settings GET and PUT, `DELETE /plugins/:id`, token (empty-text body) and `POST /plugins/:id/rpc/:method` (empty body, `Cache-Control: no-store`, caller header).
   - Every route uses `handlerParsedRequest`.
   - Declare the response types the handlers already return, for example `NOT_RUNNING` 404, the `PluginSettingsValidationError` 400, `localAuthProblem` statuses and the `respondWithInstallJob` 202, 200 and 422 bodies from `apps/server/src/routes/plugin-install-jobs.ts:14`.
   - Leave the 10 excluded routes as raw `app.*` calls and keep their position.
   - Switch the matching methods in `createPluginsArea`, keeping `installAndWait`, `startInstall`, `sourceInstallBody` and the polling loops unchanged.
   - Checkpoint: run the plugin server tests and SDK tests listed below.

5. **Catalog and marketplaces in `apps/server/src/routes/plugin-catalog.ts` `registerPluginCatalogRoutes`.** Convert status, search, install-plan, install, marketplaces list and add, refresh (empty body allowed) and remove. Keep `entrySelector`, every 422 message and `/plugin-catalog/icons/*` raw. Switch `catalog` and `marketplaces` in the SDK, keeping `pluginCatalogSearchResponseCompatibilitySchema`. Checkpoint: `plugin-catalog-routes.test.ts` passes unchanged.

6. **Skills registry in `apps/server/src/routes/skills-registry.ts` `registerSkillsRegistryRoutes`.** Convert the remaining 11 routes, keeping every inline check, `ApiError` message and `proxyUpstream` mapping. Switch `registry` in `createSkillsArea`. Make search a `$post` with both `query: { page, perPage }` and `json: { query }`.

7. **Remove the superseded SDK machinery.** Delete both `requestParsed` helpers, `jsonInit`, `jsonPost`, `pluginPath` and `installJobPath` in the SDK. Search the edited files for `/api/v1/` and `transport.fetch(`. Only routes that are explicitly out of scope may remain, and the plugin and skills areas should have none. Do not touch `apps/cli` or `apps/app`.

8. **Review the full diff.** Check that no handler body changed except its first argument and typed `context`. Check that registration order is unchanged, and that no test expectation was edited other than tests added for the new descriptor kinds. Recount production lines with `wc -l` on the same files used in Expected gain and cost.

**Verification and acceptance criteria**

The package scripts were confirmed in the snapshot's `package.json` files. None of these commands were run in this audit, because the snapshot had no `node_modules`.

- From the repository root:
  - `pnpm --filter @omnyo/hono-typed-routes test` and `pnpm --filter @omnyo/hono-typed-routes typecheck`. New tests must cover the handler-parsed request kind (no parsing, raw body still readable) and the 204 kind.
  - `pnpm --filter @omnyo/server-contract typecheck` and `pnpm --filter @omnyo/server-contract test`.
  - `pnpm --filter @omnyo/sdk typecheck` and `pnpm --filter @omnyo/sdk test`. In particular, `packages/sdk/test/sdk.test.ts` (plugin and skills URL lists, trailing-slash base URLs at lines 2250 and 2381), `plugin-bundled-update.test.ts`, `plugin-install-job.test.ts`, `plugin-update-job.test.ts`, `plugin-rpc-discovery.test.ts`, `plugin-install-body.test.ts` and `public-types.test.ts` must pass with unchanged expectations.
  - `pnpm --filter @omnyo/server typecheck`.
  - `pnpm --filter @omnyo/server test test/services/plugin-catalog/plugin-catalog-routes.test.ts test/services/plugins/plugin-safe-mode-route.test.ts test/services/plugins/plugin-reload-route.test.ts test/services/plugins/plugin-install-jobs.test.ts test/services/plugins/plugin-review-fixes.test.ts test/services/plugins/plugin-cli.test.ts`, plus the skills route coverage under `test/skills/` and `test/public/public-boot.test.ts` for boot replay of `/plugins*` parts. The server's `vitest.config.ts` accepts explicit `test/**/*.test.ts` file filters.
  - `pnpm --filter @omnyo/cli typecheck`. The CLI is unchanged, but it consumes the SDK.
  - Lint and format the touched files with `pnpm exec oxlint --fix <files>`, `pnpm exec oxfmt <files>` and then `pnpm exec oxlint --deny-warnings --format=agent`, per the repository's Oxc setup (root scripts `lint`, `format:check`).
- Behaviour and contract checks:
  - Every 400, 404, 409, 413 and 422 body and status listed in Context is unchanged.
  - Empty bodies are still accepted by refresh, token and rpc.
  - The update route still returns 413 above `MAX_BUNDLED_PLUGIN_REQUEST_BYTES`.
  - `prefer: respond-async` still yields a 202 `{ ok: true, job }` for install and `{ job }` for update.
  - Path parameters containing reserved characters are encoded exactly as before.
  - Query key order in emitted URLs is unchanged.
  - If an existing test does not cover a pinned body, compare a captured baseline response with `curl` against a local dev server before and after. Do not edit expectations to match.
- Performance: compare the type-check medians from Gate B. Confirm with `pnpm --filter @omnyo/sdk build` that the SDK bundle does not include `publicApiRoutes` runtime code.
- Structural completion:
  - No `requestParsed`, `pluginPath`, `installJobPath`, `jsonInit` or `jsonPost` remains in `packages/sdk/src/areas/plugins.ts` or `skills.ts`.
  - The only raw `app.*` registrations left in the five server files are the 10 excluded routes.
  - All 44 routes are reachable as `publicApiRoutes.*` descriptors.

**Rollback and stop conditions**

- Each checkpoint (pilot, lifecycle, catalog, skills, cleanup) is an independent commit that reverts cleanly. No persisted data, migration or wire format changes, so rollback has no compatibility implications for older clients or plugins.
- Stop if any of these occurs:
  - Gate A is not resolved. The migration would otherwise send `//api/v1` URLs for trailing-slash base URLs.
  - Any pinned status or error body cannot be reproduced through descriptor registration.
  - hc cannot type a route without casts, for example a 204 or a mixed query-plus-body POST.
  - Type-check time regresses beyond the threshold agreed with the owner.
  - A route turns out to be registered in an order that the descriptor form cannot preserve.
- Safer smaller alternative if the full change stalls: convert only `skills-registry.ts` (12 routes, already on the standard `ApiError` envelope) and the five job routes. This captures most of the convention benefit at about a third of the cost, and the remaining plugin routes stay raw with a code comment explaining why.
