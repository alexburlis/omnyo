# RF-108 — Derive route path parameters from the descriptor path instead of a hand-supplied `InputPrefix` type argument

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and every declaration currently agrees with its path. The sweep's counts were slightly off (300 descriptors, not 297; 274 helper calls carry a prefix type argument, not 270), and the sweep missed that 102 of those 274 arguments are `EmptyInput` filler that exists only because the prefix is the first positional generic.
- **Potential:** medium for a type-only change. It removes 14 hand-maintained `Path*` alias types, 4 inline param types and 102 `EmptyInput` fillers. It also makes the compiler own the param shape that the typed `hc` client uses. Today nothing checks that shape against the path.
- **Confidence:** high on the facts (Reproduced over the snapshot source; see Context). Medium on cost, because type-check time and the emitted public SDK `.d.ts` have not been measured.
- **Readiness:** conditional. The gate is a measurement, not an owner decision: compare `tsc --noEmit` time before and after, and confirm the public SDK declaration bundle still builds (Execution step 2).
- **Effort:** small. About half a day to one day: one type edit in `packages/hono-typed-routes`, a mechanical rewrite of 274 call sites in one file, alias deletion and one type test.
- **Risk:** low. Runtime values do not change. The remaining risks are type-check time, hover text and declaration shape, and all three are measured at the gate.
- **Prerequisites:** none.
- **Related or overlapping:** RF-063 (bring plugin, marketplace and skills-registry routes into the typed public route table) adds more descriptors to the same table. Either order works; landing RF-108 first means RF-063's new descriptors never need `Path*` types. RF-109 (keep one typed-route registration form in `hono-typed-routes`) edits the neighbouring `typed-routes.ts`. The two changes touch different symbols, so they can land separately, but they should not be developed at the same time in one checkout.
- **Why it deserves its place:** each parameterised route states its params twice, once in the path string and once in a type argument. Only the type argument reaches the client, and no check ties it to the path. The server already derives handler params from the path. This change gives the client the same single source.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). Files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`, because the snapshot worktree named in the task no longer exists. No test suite or type checker was run: the snapshot has no `node_modules`.

How the public route table works:

- `packages/server-contract/src/public-api.ts:617` `publicApiRoutes` is the typed table for the public HTTP API. Each entry is `defineRoute({ path, method, request, response })` (helper at `packages/hono-typed-routes/src/route-descriptor.ts:230` `defineRoute`, which keeps `Path` as a `const` literal).
- The `request` field is built by `noRequest` (`route-descriptor.ts:190`), `queryRequest` (`:194`), `optionalQueryRequest` (`:204`), `jsonRequest` (`:214`) or `formRequest` (`:224`). The last four take a first generic `InputPrefix` that is intersected into the phantom `input` type (for example `InputPrefix & { json: BodyInput }`). `noRequest<Input = EmptyInput>` takes the whole input type directly. Runtime values carry only `source` and `schema`.
- `EndpointFromRouteDescriptor` (`route-descriptor.ts:104-107`) turns a descriptor into a Hono `Endpoint<Input, Output, Status, Format>` using only `RouteRequestInput<Request>`. The `Path` argument is ignored (`RouteDefinition<any, any, infer Request, infer Response>`).
- `public-api.ts:2905` `PublicApiSchema = ApiSchemaFromRouteDescriptors<typeof publicApiRoutes>` and `:2909` `PublicApiRoutes = Hono<{}, PublicApiSchema, "/">` feed `packages/server-contract/src/api-client.ts` `createPublicApiClient` (`hc<PublicApiRoutes>`). That client is the only consumer of the `param` part of each endpoint input. It is used by `packages/sdk/src/transport-http.ts`, by `packages/sdk/src/transport.ts` `OmnyoSdkTransport.api` and by `apps/app/src/lib/api-server.ts`.
- Server handlers do not read the prefix. `packages/hono-typed-routes/src/typed-routes.ts:39` `TypedContext<E, Path>` is `Context<{}, Path>`, and `:79-80` `DescriptorHandler` passes `Descriptor["path"]`. Hono therefore already types `c.req.param()` from the path string. The server derives params from the path while the client takes them from the hand-written type, and nothing checks that the two agree.

Observed counts (Reproduced: a read-only Python scan of `public-api.ts`, with aliases collected from `common.ts`, `api/ui-preferences.ts` and `public-api.ts`):

| Measure | Count |
|---|---|
| `defineRoute({` descriptors in `public-api.ts` | 300 (`grep -c 'defineRoute({'`) |
| Request helper calls with a type argument | 274 |
| Bare `noRequest()` calls | 26 |
| Descriptors with `:params` in the path | 172 (168 use a `Path*` alias, 4 use an inline `{ param: { previewId: string } }`) |
| Calls whose prefix is `EmptyInput` or omitted for a param-less path | 102 `EmptyInput` fillers + 26 bare calls = 128 |
| Mismatches between path params and declared params | 0 |
| Distinct param names | `id` (158), `terminalId` (8), `filePath{.+}` (8), `queuedMessageId` (7), `waitId` (5), `previewId` (4), `interactionId` (4), `key`, `sourceId` (2 each), `failureId`, `hostId`, `producerId`, `ref`, `seq` (1 each) |

No path uses an optional (`:x?`) param. The only regex param is `{.+}`, which contains no `/`.

The 14 alias types:

- `packages/server-contract/src/common.ts:3-33`: `PathId`, `PathProjectId`, `PathThreadAndWait`, `PathThreadAndProducer`, `PathThreadAndQueuedMessage`, `PathIdAndFilePath`, `PathIdRefAndFilePath`, `PathIdHostAndFilePath`, `PathTerminal`. Line 1 `THREAD_EVENT_LIST_PAGE_SIZE` is unrelated and stays.
- `packages/server-contract/src/public-api.ts:607-615`: the file-local `PathThreadAndFailure`, `PathProjectSourceId`, `PathThreadMessage`, `PathThreadInteractionId`.
- `packages/server-contract/src/api/ui-preferences.ts:8`: `PathUiPreferenceKey`.
- Inline param types for the four previews routes are at `public-api.ts:1396-1421`.

Consumer search (Proven by inspection, with the stated scope). `git grep -n -w -E 'Path(Id|ProjectId|ThreadAndWait|ThreadAndProducer|ThreadAndQueuedMessage|IdAndFilePath|IdRefAndFilePath|IdHostAndFilePath|Terminal|ThreadAndFailure|ProjectSourceId|ThreadMessage|ThreadInteractionId)' e9e1b74c3 -- ':!packages/server-contract/src/public-api.ts' ':!packages/server-contract/src/common.ts'` returns no hits. `PathUiPreferenceKey` appears only in `api/ui-preferences.ts` and `public-api.ts`. The request helpers are called only in `public-api.ts` and `packages/hono-typed-routes/test/typed-routes.test.ts:26`. `git grep` in `$OMNYO_PLUGIN_CHECKOUT` for `hono-typed-routes`, `noRequest<`, `jsonRequest<` and `PathId` returns no hits. `@omnyo/server-contract` re-exports `common.ts` (`packages/server-contract/src/index.ts:13` `export * from "./common.js"`), but both `@omnyo/server-contract` and `@omnyo/hono-typed-routes` are `"private": true` workspace packages. The plugin SDK's bundled types replace them with stubs (`packages/plugin-sdk/scripts/public-api-stub.d.ts`, `api-client-stub.d.ts`), and `packages/plugin-sdk/src/__tests__/bundled-types.test.ts:13` asserts that `PublicApiSchema` is absent.

Published declaration surface (Proven by inspection of the export chain; the bundle was not built). `packages/omnyo-app/src/public-sdk.ts` does `export type * from "@omnyo/sdk/node"`, and `packages/sdk/src/node.ts` exports `OmnyoSdkTransport`, whose `api` field is the full `hc` client type. `packages/omnyo-app/scripts/build-public-sdk-dts.mjs` inlines workspace sources with `rollup-plugin-dts`. It maps `@omnyo/hono-typed-routes` explicitly and keeps `hono` external. The structural endpoint input types therefore appear in `omnyo-app/dist/index.d.ts`. The `Path*` names do not, because nothing exports them by name. `omnyo-app` already depends on `hono` (`packages/omnyo-app/package.json` dependency `"hono": "^4.13.18"`), and `route-descriptor.ts:1` already imports from `hono/utils/http-status`. No local built `dist/index.d.ts` exists, so this was not compared.

Upstream utility (Proven by inspection of the installed `hono@4.13.18` at `node_modules/.pnpm/hono@4.13.18/node_modules/hono/dist/types/types.d.ts:168-197`; the version matches the `^4.13.18` ranges). `hono/types` exports `AddParam<I, P>`: if `ParamKeys<P>` is `never` it returns `I`, if `I` already has `param` it returns `I`, and otherwise it returns `I & { param: UnionToIntersection<ParamKeyToRecord<ParamKeys<P>>> }`. `ParamKey` strips `{regex}` suffixes, so `:filePath{.+}` yields `filePath`. This is the same machinery Hono applies to its own `app.get(path, ...)` routes.

Counterevidence: the explicit aliases are readable at a glance, and all 172 parameterised routes are consistent today. The gain is the removal of a duplicated declaration and of drift risk, not the fix of a present bug. (Hypothesis: if drift did happen, the `hc` client would leave the unfilled `:name` segment in the URL and the request would fail at runtime. No check today would catch it.)

Maintenance cost today: a new route such as `/threads/:id/foo/:fooId` needs a new `Path*` alias or an inline param type that someone must keep in sync with the path. A new param-less JSON route must still write `jsonRequest<EmptyInput, Body>`.

**Proposed end state and preservation argument**

What disappears:

- The `InputPrefix` generic on `queryRequest`, `optionalQueryRequest`, `jsonRequest` and `formRequest`, and the input argument of `noRequest`, in `packages/hono-typed-routes/src/route-descriptor.ts`.
- All 14 `Path*` aliases and their import lists, the 4 inline previews param types, and every `EmptyInput` filler argument in `public-api.ts`, together with the `type EmptyInput` import at `public-api.ts:212`.

What remains, and who owns it:

- The path string in each descriptor becomes the only declaration of its params. `EndpointFromRouteDescriptor` derives them with Hono's `AddParam`:

  ```ts
  import type { AddParam } from "hono/types";

  export type EndpointFromRouteDescriptor<Descriptor> =
    Descriptor extends RouteDefinition<infer Path, any, infer Request, infer Response>
      ? EndpointFromRouteResponse<AddParam<RouteRequestInput<Request>, Path>, Response>
      : never;
  ```

- The helper signatures become `noRequest(): NoRouteRequest<EmptyInput>`, `queryRequest<QueryInput, Schema extends ZodType = ZodType<QueryInput>>(schema): QueryRouteRequest<{ query: QueryInput }, z.output<Schema>>`, `optionalQueryRequest` (the same with `query?:`), `jsonRequest<BodyInput, Schema ...>(schema): JsonRouteRequest<{ json: BodyInput }, z.output<Schema>>` and `formRequest<FormInput>(): FormRouteRequest<{ form: FormInput }>`.
- `EmptyInput` stays exported from `packages/hono-typed-routes/src/endpoint.ts`, because `packages/host-daemon-contract/src/local.ts:4` uses it.

Why the semantics survive:

- Runtime descriptor values (`source`, `schema`, `status`, `format`) are unchanged, so server registration and validation (`typed-routes.ts` `registerDescriptor`) behave exactly as before.
- For each of the 172 parameterised routes, the derived `{ param: { ...: string } }` has the same keys and `string` values as today's alias, because the mismatch count is 0. For param-less routes `AddParam` returns the input unchanged, which is structurally the same as `EmptyInput & {...}`.
- The server handler types do not change: they already read `Descriptor["path"]`.

Non-goals:

- No change to the response helpers, to `typedRoutes`, to the string-path registration form (that is RF-109), or to the `Endpoint` shapes in `host-daemon-contract`.
- No support for optional params, because no route uses them. If one is added, Hono's `ParamKeyToRecord` already types it as `string | undefined`.

Remaining uncertainty: the textual shape of hover text and of `omnyo-app/dist/index.d.ts` will change. For example, it may show an intersection such as `{ query: Q } & { param: { id: string } & ... }` instead of a named alias. Structural assignability should not change (Hypothesis until the gate's type test passes).

**Expected gain and cost**

Handwritten production lines (`wc -l` at the snapshot: `public-api.ts` 2,919; `common.ts` 33; `api/ui-preferences.ts` 31; `route-descriptor.ts` 239):

| Change | Lines (observed from file layout unless marked) |
|---|---|
| `common.ts:2-33`, the alias block | −32 |
| `public-api.ts:214-224`, the `import type { Path... } from "./common.js"` block | −11 |
| `public-api.ts:607-616`, the local aliases with their blank lines | −10 |
| `public-api.ts:212` `type EmptyInput` import and `:471` `PathUiPreferenceKey` import | −2 |
| `api/ui-preferences.ts:8-9`, the alias and its blank line | −2 |
| `route-descriptor.ts`, helper signatures and derivation | about −4 to +2 (projection) |
| **Net declarations** | **about −55 to −60** |
| Call-site rewrapping in `public-api.ts` after removing prefixes | about −100 to −140 (projection from an 80-column rewrap estimate over the 274 calls, 179 of which are multi-line today; the real number depends on `oxfmt`) |

The rewrap lines are formatting, not removed complexity. Do not count them as the main gain.

Mechanisms: before, the params of 172 routes were declared twice, with 14 named aliases and 4 inline types and no compiler check. After, they are declared once, in the path. The generic argument lists of 274 calls get shorter by one argument, and 102 of those calls stop naming `EmptyInput`.

Costs and tradeoffs:

- Type-check time is unknown. Hono already evaluates `ParamKeys` for each handler's `Context<{}, Path>`, and 300 more small template-literal evaluations are expected to be cheap, but this is a projection until measured.
- Hover text loses the friendly alias names.
- Generated code, tests and docs: one type test is added in `packages/hono-typed-routes/test`, and `typed-routes.test.ts:26` is edited. No doc mentions these helpers (`git grep` over `*.md` for `PathId|noRequest|jsonRequest|defineRoute|InputPrefix` returned nothing).

**Execution steps**

1. **Reconfirm the baseline.** In a fresh worktree of current `main`, rerun the counts: `grep -c 'defineRoute({' packages/server-contract/src/public-api.ts`; the alias consumer `git grep -n -w` from Context, extended to every alias name present; and `git grep -n -E 'noRequest<|jsonRequest<|queryRequest<|optionalQueryRequest<|formRequest<' -- ':!packages/server-contract/src/public-api.ts'`, which should show only the `hono-typed-routes` test. Re-plan if any of these hold:
   - a request helper is called outside `public-api.ts` and the test;
   - a `Path*` alias has a consumer outside the contract files;
   - a path uses a param pattern containing `/`, or an optional `:x?` param whose current declared type is not `string | undefined`;
   - some prefix type carries a key other than `param`, such as `header`;
   - any declared params differ from the path. If they differ, the derived type would change a client contract: stop, and report the mismatch as a bug.
2. **Investigation gate: measure before editing.** With dependencies installed (`pnpm install` in the worktree, using the repository's own lockfile):
   - Record `pnpm exec tsc --noEmit --extendedDiagnostics` (the `Check time`, `Types` and `Instantiations` lines) in `packages/server-contract`, `packages/sdk` and `apps/app`. Run each twice and keep the lower time.
   - Build the public SDK declarations with `node scripts/build-public-sdk-dts.mjs` from `packages/omnyo-app`. This script exists, but whether it needs a prior build step was not confirmed. If it fails on a clean checkout, run `pnpm --filter omnyo-app build` first. Keep a copy of `dist/index.d.ts` under `~/scratch/omnyo/<owner-id>--rf108/` as the baseline.
3. **Add the regression type test first** in `packages/hono-typed-routes/test/route-params.test.ts` (new file; `tsconfig.json` already includes `test`). Define descriptors for `/items/:id` (`noRequest`), `/items/:id/files/:filePath{.+}` (`optionalQueryRequest`), `/items/:id/children/:childId` (`jsonRequest`) and a param-less `/ping`. Assert with `expectTypeOf` from `vitest` that each endpoint input in `ApiSchemaFromRouteDescriptors<typeof routes>` equals the expected `{ param: {...} }`, `{ query?: ... }` and `{ json: ... }` shapes, and that `/ping` has no `param` key. Write it against the new helper signatures; it fails to compile until step 4, which shows the test detects the change.
4. **Checkpoint A: `packages/hono-typed-routes/src/route-descriptor.ts`.**
   - Add `import type { AddParam } from "hono/types";`.
   - Change `EndpointFromRouteDescriptor` as shown in the end state.
   - Remove `InputPrefix` from `queryRequest`, `optionalQueryRequest`, `jsonRequest` and `formRequest`, and change `noRequest` to take no generic.
   - Update `packages/hono-typed-routes/test/typed-routes.test.ts:26` from `optionalQueryRequest<Record<never, never>, { q: string }>` to `optionalQueryRequest<{ q: string }>`.
   - Run `pnpm --filter @omnyo/hono-typed-routes typecheck` and `pnpm --filter @omnyo/hono-typed-routes test`. Both must pass, including the step 3 test.
   - Do not keep compatibility overloads. The helpers have no consumer outside this repository (see Context), so parallel signatures would be dead on arrival.
5. **Checkpoint B: the mechanical call-site rewrite in `packages/server-contract/src/public-api.ts`.**
   - Remove the first type argument from every `queryRequest`, `optionalQueryRequest`, `jsonRequest` and `formRequest` call. For example, `jsonRequest<PathId, Body>(schema)` becomes `jsonRequest<Body>(schema)`, `queryRequest<EmptyInput, Q>(s)` becomes `queryRequest<Q>(s)`, and the multi-line forms at about `:1071-1107` and `:2737` that start with `EmptyInput,` lose that line.
   - Turn every `noRequest<X>()` into `noRequest()`.
   - Prefer a small throwaway script in scratch that parses the generic list at depth 0, as the audit scan did, over hand edits. Then run `pnpm exec oxfmt packages/server-contract/src/public-api.ts`.
   - Keep this checkpoint purely mechanical: change no paths, schemas or response types.
6. **Checkpoint C: delete the aliases.**
   - Remove `common.ts:2-33`, keeping `THREAD_EVENT_LIST_PAGE_SIZE`.
   - Remove the `import type { Path... } from "./common.js"` block (`public-api.ts:214-224`), the local aliases (`:607-616`), the `type EmptyInput` import (`:212`) and the `PathUiPreferenceKey` import (`:471`).
   - Remove `PathUiPreferenceKey` from `api/ui-preferences.ts:8`.
   - `packages/server-contract/src/index.ts:13` `export * from "./common.js"` stays, because it still exports the constant.
7. **Checkpoint D: dependent type checks.** Run the verification commands below. Compare the extended diagnostics against the step 2 baseline. Rebuild `omnyo-app/dist/index.d.ts` and `diff` it against the baseline. Expect only param and input type-shape changes, no new or lost exported names, and no new external import other than `hono/types` (and only if rollup-plugin-dts emits it).
8. **Close out.** Confirm that `git grep -n -w -E 'Path(Id|ProjectId|ThreadAnd\w+|IdAndFilePath|IdRefAndFilePath|IdHostAndFilePath|Terminal|ProjectSourceId|ThreadMessage|ThreadInteractionId|UiPreferenceKey)'` and `git grep -n 'InputPrefix'` return nothing. Inspect the complete diff for unrelated edits. Recount `wc -l` on the four files against the same baseline. Remove the scratch baseline once the comparison is recorded.

**Verification and acceptance criteria**

Commands. The package scripts were confirmed in each `package.json` at the snapshot: `typecheck` is `tsc --noEmit` and `test` is `vitest run --config vitest.config.ts`. Run them from the repository root:

- `pnpm --filter @omnyo/hono-typed-routes typecheck` and `pnpm --filter @omnyo/hono-typed-routes test`
- `pnpm --filter @omnyo/server-contract typecheck` and `pnpm --filter @omnyo/server-contract test`
- `pnpm --filter @omnyo/sdk typecheck` and `pnpm --filter @omnyo/sdk test`. The second covers `packages/sdk/test/public-types.test.ts`. Whether vitest enforces its `expectTypeOf` at run time was not confirmed; `tsc --noEmit` covers it because the test files are inside the package's `include`.
- `pnpm --filter @omnyo/server typecheck`, because the route handlers in `apps/server/src/routes/*.ts` consume `publicApiRoutes`.
- `pnpm --filter @omnyo/app typecheck`, the largest `hc` client consumer.
- `pnpm --filter omnyo-app typecheck`
- `pnpm --filter @omnyo/mobile typecheck` and `pnpm --filter @omnyo/desktop typecheck`, only if they import `@omnyo/sdk` or `@omnyo/server-contract` (check with `git grep`).
- The repository-wide `pnpm typecheck` (turbo) is optional during development. Per the repository's policy it is a pre-merge gate.
- Lint and format the changed files: `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings --format=agent <files>`. The root has `oxlint` and `oxfmt` devDependencies; the exact Oxc invocation follows the global agent policy.

Acceptance:

- **Contract:** all of the above type checks pass with no edit to any consumer outside `packages/hono-typed-routes` and `packages/server-contract`. A consumer edit means the structural contract changed: stop and investigate. The new type test passes for single, multiple, regex-suffixed and absent params.
- **Runtime:** server-contract and hono-typed-routes tests pass unchanged. No runtime value changed, so no further runtime or UI check is needed.
- **Performance:** `Check time` for `apps/app` and `packages/sdk` is within the noise of the step 2 baseline, compared across two runs each on the same machine with the same dependencies. `Instantiations` must not grow by an order of magnitude. There is no existing type-check time budget, so record both numbers in the PR.
- **Declarations:** the `omnyo-app/dist/index.d.ts` diff contains only type-shape changes in endpoint inputs. The export list is identical, and no `Path*` name was present before or after.
- **Structure:** no `InputPrefix`, no `Path*` alias and no `EmptyInput` type argument remain in `public-api.ts`. Every descriptor's params come only from its `path`.

**Rollback and stop conditions**

The change is type-only and lives in two packages and one commit series (checkpoints A to C can be one commit, or three), with no persisted data or wire format involved. Rolling back means reverting those commits. No runtime compatibility concern exists, because built JavaScript is unchanged except for the deletion of type-only code.

Stop and re-plan if:

- step 1 finds a declared or path mismatch (report it as a bug, separate from this card);
- an external consumer of the helpers or aliases is found (then keep one release of optional-prefix overloads and add a removal condition);
- `Check time` for `apps/app` or `packages/sdk` rises clearly beyond run-to-run noise. In that case, try a local `ParamKeys`-equivalent type without `UnionToIntersection`, such as a mapped type over the key union `{ [K in ParamKeys<Path>]: string }`, before giving up;
- the public SDK declaration build fails or starts emitting an unresolved `hono/types` import into a package whose consumers lack `hono`.

The smaller safe alternative is to keep the helper signatures and add only a type-level assertion inside `defineRoute` that the declared `param` keys equal `ParamKeys<Path>`. That prevents drift but keeps the duplicate declarations, so use it only if the full derivation is measurably too slow.
