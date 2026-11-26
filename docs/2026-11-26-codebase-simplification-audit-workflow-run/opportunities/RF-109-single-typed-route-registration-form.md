# RF-109 — Remove the string-path registration form and its `Endpoint`-map schemas from `typedRoutes`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The opportunity is real, but the sweep miscounted the routes. The string-path form has 12 registrations, not 14. Two of the 14 hand-written `Endpoint` entries (`/session/open` and `/health`) are registered with plain Hono and exist only to type `hc` clients. The sweep also missed a consequence: once the string form is gone, the `Schema` type parameter of `typedRoutes<Schema>` checks nothing, at all 35 call sites.
- **Potential:** low. The change removes one maintained mechanism: a second call signature with its own conditional types and runtime dispatch. It also removes a hand-written route map whose paths and schemas are paired again at each registration. The line saving is modest.
- **Confidence:** high. Every claim below was proven by inspection at the snapshot. Nothing was executed, because the snapshot has no `node_modules`.
- **Readiness:** ready. No owner decision is needed. All consumers are private workspace packages, and nothing is published.
- **Effort:** small, about half a day including verification.
- **Risk:** low. The runtime registration path is the same `register` body for both forms. The realistic regressions are type-level: `hc` client typing for `HostDaemonInternalSchema` and `HostDaemonLocalSchema`, and handler input types.
- **Prerequisites:** none.
- **Related and overlapping:**
  - RF-108 ("Derive route path parameters from the descriptor path") also edits `packages/hono-typed-routes/src/route-descriptor.ts`. Land RF-109 first or second, but not concurrently. Once both land, the new internal descriptors gain path-parameter types for free.
  - RF-063 ("Bring plugin, marketplace and skills-registry routes into the typed public route table") adds more descriptor routes. It does not conflict, and it benefits from there being only one form.
- **Why it deserves its place:** after this change, a typed route is declared one way everywhere. Each request schema sits next to its path in the contract, rather than being chosen again at each server registration. The change is cheap and safe. Its value is smaller than the deletion-heavy items in this audit.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only worktree named for this audit was no longer on disk when this card was written. Every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`.

`@omnyo/hono-typed-routes` is a private workspace package (`packages/hono-typed-routes/package.json`: `"private": true`). It wraps Hono route registration so that each handler gets a parsed and validated request plus a typed `c.json`. Its runtime is re-exported from `packages/server-contract/src/index.ts:21` and `packages/host-daemon-contract/src/index.ts:19`.

The package has two registration forms. Each method function (`get`, `post`, `patch`, `del` and `put`) accepts both forms:

1. **The descriptor form.** A call looks like `get(publicApiRoutes.queue.list, handler)`. A `defineRoute({ path, method, request, response })` descriptor carries the path, the input source (none, query, json or form), the zod schema and the response typing. `ApiSchemaFromRouteDescriptors` derives the Hono schema type from a descriptor table (`packages/hono-typed-routes/src/route-descriptor.ts:141` "ApiSchemaFromRouteDescriptors"). All public routes use this form. One example is `packages/server-contract/src/public-api.ts:2905` "PublicApiSchema".
2. **The string-path form.** A call looks like `post("/hosts/enroll", hostDaemonEnrollRequestSchema, handler)`. The path is checked against a hand-written `Endpoint` map that is passed as `typedRoutes<Schema>`. The schema is supplied separately at each call.

**Machinery that only the string form uses** (Proven by inspection, `packages/hono-typed-routes/src/typed-routes.ts`, 250 lines by `wc -l`):

- `:12-28`: the conditional types `EndpointInput`, `JsonBody`, `QueryInput` and `RouteInputForMethod`.
- `:52` `MethodKey` and `:56` `InputSource`. These are used only by the string-form types and by `registerFromArgs`.
- `:60-72`: `TypedRegister<Schema, MKey>`, which is the string-form call signature.
- `:91-95`: `TypedRegisterWithDescriptor`, the intersection of both signatures.
- `:144-145`: the `typeof schemaOrHandler === "function"` branch inside `register`. The descriptor path never reaches this branch with a handler in the schema slot, because `registerDescriptor` (`:179-200`) passes the handler in that slot only for the `"none"` and `"form"` sources, and those sources take the first branch.
- `:202-216`: `registerFromArgs`, which dispatches between the two forms on `typeof args[0] === "string"`.
- `:218-249`: the returned object, where each of the five methods is cast to `TypedRegisterWithDescriptor<Schema, "$x", "x">`.

**Consequence the sweep missed** (Proven by inspection): `TypedDescriptorRegister<Method>` (`:82-89`) does not mention `Schema`, and neither does `DescriptorHandler` (`:74-80`). `Schema` reaches only `TypedRegister`. Once the string form is deleted, the type argument in `typedRoutes<PublicApiSchema>(app, …)` has no effect. A descriptor from another table would type-check against any `Schema` today; this was established by reading the types and was not compiled.

**String-form registrations at the snapshot.** The count is 12, found by the scan described under the search scope below.

| File | Registrations |
| --- | --- |
| `apps/server/src/internal/skills.ts:15` "registerInternalSkillRoutes" | `get("/skills/tree/:hash", …)` |
| `apps/server/src/internal/plugin-host-artifacts.ts:17` "registerInternalPluginHostArtifactRoutes" | `get("/plugins/:pluginId/host/:digest", …)`, with a binary response |
| `apps/server/src/internal/session.ts:267` "registerInternalSessionRoutes" | `get("/session/project-attachment-content", hostDaemonProjectAttachmentContentQuerySchema, …)`, with a binary response |
| `apps/server/src/internal/hosts.ts:56`, `:86` "registerInternalHostRoutes" | `post("/hosts/enroll-key", …)` (201) and `post("/hosts/enroll", …)` (201) |
| `apps/server/src/internal/events.ts:1491` "registerInternalEventRoutes" | `post("/session/events", hostDaemonEventBatchRequestSchema, …)` |
| `apps/server/src/internal/tool-calls.ts:75` "registerInternalToolCallRoutes" | `post("/session/tool-call", …)` |
| `apps/server/src/internal/interactive-requests.ts:222`, `:320` | `post("/session/interactive-request", …)` and `post("/session/interactive-request/interrupt", …)` |
| `apps/host-daemon/src/local-api.ts:376`, `:387`, `:403` | `get("/status", …)`, `get("/workspace-open-targets", workspaceOpenTargetsQuerySchema, …)` and `post("/open-in-target", openInTargetRequestSchema, …)` |

**The two hand-written maps** (Proven by inspection):

- `packages/host-daemon-contract/src/session.ts:1108-1167` "HostDaemonInternalSchema" has 60 lines and 10 entries. One entry, `/session/open`, is not registered through `typedRoutes`. It is registered with plain `app.post("/session/open", …)` at `apps/server/src/internal/session.ts:78`, because the handler deliberately checks the server-move state before it reads the body. It then runs a staged parse: `sessionOpenCompatibilitySchema` (`:38`) first, then `hostDaemonSessionOpenRequestSchema.safeParse` (`:145`). The entry exists to type the `hc` client in `apps/server/test/internal/internal-session-protocol-version.test.ts:26` "createHostDaemonClient", which calls `.session.open.$post` at `:50`, `:132`, `:382`, `:426`, `:448` and `:470`.
- `packages/host-daemon-contract/src/local.ts:319-335` "HostDaemonLocalSchema" has 17 lines and 4 entries. It types `createHostDaemonLocalClient` (`:337-343`), which `apps/app/src/lib/api-host-daemon.ts` (`:37` `status.$get`, `:53` `["workspace-open-targets"].$get`, `:78` `["open-in-target"].$post`), `packages/sdk/src/node.ts:79` "fetchLocalHostId" and `apps/host-daemon/src/local-api.test.ts` use. The `/health` entry is registered with plain `app.get(options.localApiConfig.healthPath, …)` at `apps/host-daemon/src/local-api.ts:311`, because its path is configurable. No caller uses `client.health`; a search for `health\.\$get` returned no matches.
- All request types in both maps are `z.infer` or `z.output` of the matching schema (`session.ts:154`, `:165`, `:184`, `:253`, `:315`, `:990`, `:1006`, `:1078`; `local.ts:95`, `:134`). The handler input type therefore does not change when the type comes from the descriptor's explicit type arguments.

**Search scope and results.** These searches ran against the commit with `git grep`:

- `typedRoutes` across the repository (excluding `*.md`) found 35 application files, the package test and the two contract re-exports. No match appeared in `plugins/`, `examples/`, `tools/` or `scripts/`. `rg "typedRoutes|hono-typed-routes"` over `$OMNYO_PLUGIN_CHECKOUT` also returned nothing.
- `Endpoint<` outside the package found only `host-daemon-contract/src/session.ts` (10), `host-daemon-contract/src/local.ts` (4) and the package test (2).
- A Python scan of the 35 files classified each line that starts with `get(`, `post(`, `put(`, `patch(` or `del(` by its first argument. It found 12 string-path calls and 299 descriptor calls. The scan is a heuristic on line starts and does not prove that no other call exists. `pnpm --filter @omnyo/hono-typed-routes typecheck` would catch any call it missed after the deletion.
- Every one of the 35 files mentions its schema type (`PublicApiSchema`, `HostDaemonInternalSchema` or `HostDaemonLocalSchema`) exactly twice: once in the import and once in the generic.
- Each request schema passed at a string-form call (for example `hostDaemonEventBatchRequestSchema`, `openInTargetRequestSchema` and `hostDaemonEnrollRequestSchema`) appears exactly twice in its handler file: once in the import and once at the registration. The exception is `hostDaemonSessionOpenRequestSchema`, which `session.ts` also uses at `:145`.
- Searches of `*.md` for `typedRoutes`, `hono-typed-routes` and `defineRoute` returned no documentation hits.
- `packages/omnyo-app/scripts/build-public-sdk-dts.mjs:50` maps `@omnyo/hono-typed-routes` for the public SDK declaration bundle. That bundle is generated from `packages/omnyo-app/src/public-sdk.ts`, which re-exports types from `@omnyo/sdk/node`. `fetchLocalHostId` returns `Promise<string | null>`, so the local schema type is not part of the public surface (Proven by inspection). The executor should still confirm that the bundle is unchanged (see Verification).

**Tests that encode the current behavior:** `packages/hono-typed-routes/test/typed-routes.test.ts:45-63` (string form, query parsing and the `"Required"` message), `:65-77` (string form, no schema) and `:79-95` (descriptor form, query parsing and `"Required"`). The first and third tests assert the same behavior. No test asserts the `"Invalid JSON request body"` path (`typed-routes.ts:158`). A repository-wide search for that string found only `typed-routes.ts` and `apps/server/src/internal/session.ts`.

**Maintenance cost today:** adding an internal host-daemon route means three edits. You add an `Endpoint` entry with a hand-written input wrapper such as `{ json: X }` or `{ query: Q }`. You import the right schema in the server file. You pass the path string and that schema again at registration. Nothing ties the schema to the map entry except the `ZodType<Input>` constraint. The package also maintains two call signatures, the dispatch between them and a type parameter that the public routes never use.

**Prior audit:** `docs/2026-11-25-material-simplification-audit.md` has no matching item. A search for `typed-route`, `hono-typed` and `string-path` returned nothing.

**Proposed end state and preservation argument**

What disappears:

- In `typed-routes.ts`, the string-form types (`EndpointInput`, `JsonBody`, `QueryInput`, `RouteInputForMethod`, `MethodKey`, `InputSource`, `TypedRegister` and `TypedRegisterWithDescriptor`), `registerFromArgs`, the handler-in-schema-slot branch of `register`, and the `Schema` type parameter of `typedRoutes`.
- The hand-written `Endpoint` maps in `host-daemon-contract`.
- Nine schema imports in the handler files.
- The `type PublicApiSchema`, `type HostDaemonInternalSchema` and `type HostDaemonLocalSchema` imports in the 35 route files. This happens in checkpoint D.

What remains:

- One registration form: `get(descriptor, handler)` and the same for `post`, `patch`, `del` and `put`. It is implemented by one `register(method, descriptor, handler)` function.
- `Endpoint` and `EmptyInput` stay exported. `route-descriptor.ts` builds `Endpoint` values, `TypedJsonArgs` uses `Endpoint`, and descriptors use `EmptyInput`.
- `HostDaemonInternalSchema` and `HostDaemonLocalSchema` keep their exported names, so the `hc` consumers do not change. They become derived types.

The canonical owner of host-daemon route declarations becomes two descriptor tables in `@omnyo/host-daemon-contract`. This mirrors `publicApiRoutes` in `@omnyo/server-contract`:

```ts
// packages/host-daemon-contract/src/session.ts (replaces :1108-1167)
export const hostDaemonInternalRoutes = {
  skillTree: defineRoute({
    path: "/skills/tree/:hash",
    method: "get",
    request: noRequest(),
    response: jsonResponse<HostDaemonSkillTree>(),
  }),
  pluginHostArtifact: defineRoute({
    path: "/plugins/:pluginId/host/:digest",
    method: "get",
    request: noRequest(),
    response: binaryResponse<Uint8Array>(),
  }),
  enrollKey: defineRoute({
    path: "/hosts/enroll-key",
    method: "post",
    request: jsonRequest<EmptyInput, HostDaemonEnrollKeyRequest>(
      hostDaemonEnrollKeyRequestSchema,
    ),
    response: jsonResponse<HostDaemonEnrollKeyResponse>({ status: 201 }),
  }),
  enroll: /* "/hosts/enroll", post, jsonRequest(hostDaemonEnrollRequestSchema), 201 */,
  // Type-only: the server registers /session/open with app.post because it
  // gates on server-move state before parsing (apps/server/src/internal/session.ts).
  sessionOpen: /* "/session/open", post, jsonRequest(hostDaemonSessionOpenRequestSchema), 201 */,
  projectAttachmentContent: /* get, queryRequest<EmptyInput, HostDaemonProjectAttachmentContentQuery>(schema), binaryResponse<Uint8Array>() */,
  sessionEvents: /* post, jsonRequest(hostDaemonEventBatchRequestSchema), jsonResponse<HostDaemonEventBatchResponse>() */,
  toolCall: /* post, jsonRequest(hostDaemonToolCallRequestSchema), jsonResponse<HostDaemonToolCallResponse>() */,
  interactiveRequest: /* post, jsonRequest(hostDaemonInteractiveRequestSchema), jsonResponse<HostDaemonInteractiveRequestResponse>() */,
  interactiveRequestInterrupt: /* post, jsonRequest(hostDaemonInteractiveInterruptRequestSchema), jsonResponse<HostDaemonInteractiveInterruptResponse>() */,
};

export type HostDaemonInternalSchema = ApiSchemaFromRouteDescriptors<
  typeof hostDaemonInternalRoutes
>;
```

```ts
// packages/host-daemon-contract/src/local.ts (replaces :319-335)
export const hostDaemonLocalRoutes = {
  // Type-only: local-api.ts registers the health route at the configurable
  // localApiConfig.healthPath with app.get.
  health: defineRoute({
    path: DEFAULT_HOST_DAEMON_LOCAL_HEALTH_PATH,
    method: "get",
    request: noRequest(),
    response: jsonResponse<HealthResponse>(),
  }),
  workspaceOpenTargets: /* get, optionalQueryRequest<EmptyInput, WorkspaceOpenTargetsQuery>(workspaceOpenTargetsQuerySchema), jsonResponse<WorkspaceOpenTargetsResponse>() */,
  openInTarget: /* post, jsonRequest<EmptyInput, OpenInTargetRequest>(openInTargetRequestSchema), jsonResponse<Record<string, never>>() */,
  status: /* get, noRequest(), jsonResponse<StatusResponse>() */,
};

export type HostDaemonLocalSchema = ApiSchemaFromRouteDescriptors<
  typeof hostDaemonLocalRoutes
>;
```

**Why current behavior survives** (Proven by inspection):

- **Runtime registration.** Today, string `get(path, schema, h)` calls `register("get", "query", path, schema, h)`, and string `post(path, schema, h)` calls `register("post", "json", …)`. A descriptor with `queryRequest` or `optionalQueryRequest` reaches `register(method, "query", path, schema, h)`, and one with `jsonRequest` reaches `"json"` (`typed-routes.ts:184-197`). A string call without a schema reaches `app[method](path, handler)` through the `typeof === "function"` branch (`:144-145`). A `noRequest()` descriptor reaches the same `app[method](path, handler)` through the `"none"` branch (`:142-143`). The query reading, JSON parsing, zod parsing, `validationMessageFromZodError` and `onValidationError` code is the same block in both forms.
- **Error mapping.** The `onValidationError` options at each `typedRoutes(app, { … })` call stay as they are. `local-api.ts:373` passes no options today, so it keeps the default `new Error(msg)`.
- **Handler input types.** The parsed input becomes `z.output<ZodType<T>>`, which is `T`, because `queryRequest` and `jsonRequest` default their third type parameter to `ZodType<T>` when the first two are given explicitly. `T` is the same `z.infer` type the `Endpoint` map declared.
- **`hc` client types.** `ApiSchemaFromRouteDescriptors` produces `{ [path]: { $get | $post: Endpoint<Input, Output, Status, Format> } }`. This is the same shape as the hand-written maps. The only difference is that inputs become `EmptyInput & { json: T }` rather than `{ json: T }`, and the two are structurally equal. The status and format are preserved by `jsonResponse<…>({ status: 201 })` and `binaryResponse<Uint8Array>()`. The `/health` entry keeps `jsonResponse<HealthResponse>()` to match the current `Endpoint<EmptyInput, HealthResponse>` exactly. That entry is already inaccurate, because the route returns text; this is filed separately as an incidental finding and is not fixed here.
- **Untyped registrations.** `/session/open` and `/health` keep their plain-Hono registrations. The `/session/open` registration may use `hostDaemonInternalRoutes.sessionOpen.path` in place of the literal string. That is optional and changes no behavior.
- **Paths.** Paths are byte-for-byte unchanged, so the gate allowlists in `apps/server/src/server.ts` and the daemon's `buildInternalUrl("/session/…")` calls in `apps/host-daemon/src/server-client.ts` are unaffected.

**Non-goals:**

- Routing the `/session/open` or `/health` registrations through `typedRoutes`.
- Adding path-parameter types to the internal descriptors. That belongs to RF-108.
- Making `typedRoutes` check that a descriptor belongs to a given table.
- Changing the daemon's `fetch`-based server client to `hc`.
- Correcting the `/health` response format.

**Expected gain and cost**

Observed baseline (`wc -l` and line ranges at the snapshot): `typed-routes.ts` has 250 lines. `HostDaemonInternalSchema` has 60 lines and `HostDaemonLocalSchema` has 17. There are 12 string-form registrations, 9 removable schema imports and 35 schema type imports. The package test has 96 lines.

Projected handwritten production lines, estimated by hand from the line ranges above (not measured):

| Change | Lines |
| --- | --- |
| `typed-routes.ts`: delete string-form types (about 40 lines with blank lines), `registerFromArgs` (16), the dead branch, and the separate `registerDescriptor` wrapper; shrink the return object from 32 lines to about 12 with a `bind(method)` helper | about −65 to −80 |
| Contract: 14 descriptors at 6–8 lines each, plus two derived types and value imports, replacing 77 lines of maps | about +40 to +50 |
| Handler files: drop 9 schema imports and the multi-line schema-argument lines, add 8 route-table imports | about −10 |
| **Core change, net** | **about −30 to −45** |
| Checkpoint D: drop the dead `Schema` generic and 35 schema type imports | about −35 more |

Tests: about −15 to −20 lines in `typed-routes.test.ts`. The `TestSchema` map and the duplicated string-form query test go. A no-request descriptor test and a JSON-body descriptor test are added.

Mechanisms: before, there are 2 registration signatures, 2 ways to declare a route type (an `Endpoint` map or descriptors), and a type parameter on 35 call sites that only the string form reads. After, there is one of each and no dead type parameter.

Causal benefit: a new host-daemon route becomes one descriptor plus `post(hostDaemonInternalRoutes.x, handler)`. The schema can no longer drift from the declared input type at the call site. The package no longer has to maintain overload resolution across an intersection of two generic signatures.

Performance: neutral by inspection. Registration code is identical, and module load gains 14 small object literals and `defineRoute` identity calls. `apps/app` already loads `@omnyo/hono-typed-routes` at runtime through `@omnyo/server-contract`'s `publicApiRoutes`, so no new runtime dependency reaches the web bundle. `host-daemon-contract` already depends on the package at runtime (`package.json` `dependencies`).

Cost: churn in 35 route files during checkpoint D (one import line each). Readers of `local.ts` and `session.ts` see descriptor objects in place of type maps.

**Execution steps**

1. **Reconfirm.** Use a writable worktree at or after `e9e1b74c3`. Run `git grep -n "typedRoutes<" -- apps packages` and re-run the string-path scan, which counts first arguments that are string literals. Stop and re-plan if any of these hold:
   - A string-form call exists outside the 12 listed.
   - A package outside this repository imports `@omnyo/hono-typed-routes`.
   - `HostDaemonInternalSchema` or `HostDaemonLocalSchema` has gained entries or consumers that need a shape descriptors cannot express, such as a `form` input with a schema.
   - RF-108 is in progress in `route-descriptor.ts`.
2. **Checkpoint A: contract tables with a parity check.**
   - In `packages/host-daemon-contract/src/session.ts`, change `import type { Endpoint } from "@omnyo/hono-typed-routes"` (`:23`) to value imports: `binaryResponse`, `defineRoute`, `jsonRequest`, `jsonResponse`, `noRequest`, `queryRequest`, plus `type ApiSchemaFromRouteDescriptors` and `type EmptyInput`.
   - Rename the existing map to a local, non-exported `LegacyHostDaemonInternalSchema`. Add `hostDaemonInternalRoutes` and the derived `HostDaemonInternalSchema` as shown above.
   - Do the same in `packages/host-daemon-contract/src/local.ts` (`:4`, `:319-335`) for `hostDaemonLocalRoutes` and `HostDaemonLocalSchema`. `optionalQueryRequest` is needed for `/workspace-open-targets`.
   - Add a temporary mutual-assignability assertion for each pair, for example `type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false; const _internalParity: Same<HostDaemonInternalSchema, LegacyHostDaemonInternalSchema> = true;`.
   - Run `pnpm --filter @omnyo/host-daemon-contract typecheck`. Then delete the legacy maps and the assertions.
   - The string-form registrations still compile against the derived types at this point, so the `@omnyo/server`, `@omnyo/host-daemon` and `@omnyo/app` typechecks must also pass.
3. **Checkpoint B: move the 12 registrations to descriptors.** Do this in the files listed in Context.
   - Replace each `get("/path", schema, handler)` or `post("/path", schema, handler)` with `get(hostDaemonInternalRoutes.<key>, handler)` or `post(…, handler)`. Use `hostDaemonLocalRoutes.<key>` in `apps/host-daemon/src/local-api.ts`.
   - Remove the nine now-unused schema imports: `hostDaemonEventBatchRequestSchema` in `events.ts`; `hostDaemonEnrollKeyRequestSchema` and `hostDaemonEnrollRequestSchema` in `hosts.ts`; `hostDaemonInteractiveRequestSchema` and `hostDaemonInteractiveInterruptRequestSchema` in `interactive-requests.ts`; `hostDaemonToolCallRequestSchema` in `tool-calls.ts`; `hostDaemonProjectAttachmentContentQuerySchema` in `session.ts`; `workspaceOpenTargetsQuerySchema` and `openInTargetRequestSchema` in `local-api.ts`.
   - Keep `hostDaemonSessionOpenRequestSchema` in `session.ts`, because it is still used at `:145`.
   - Optionally, change `app.post("/session/open", …)` (`session.ts:78`) to `app.post(hostDaemonInternalRoutes.sessionOpen.path, …)`.
   - Run the server, host-daemon and contract typechecks and the focused tests listed under Verification.
4. **Checkpoint C: delete the string form in `packages/hono-typed-routes/src/typed-routes.ts`.**
   - Remove `:12-28`, `MethodKey` (`:52`), `InputSource` (`:56`), `TypedRegister` (`:60-72`), `TypedRegisterWithDescriptor` (`:91-95`) and `registerFromArgs` (`:202-216`).
   - Merge `register` and `registerDescriptor` into one function, `register(method: RouteMethod, descriptor: RouteDefinition, handler: Function)`. If `descriptor.request.source` is `"none"` or `"form"`, it calls `app[method](descriptor.path, handler)`. Otherwise it registers the existing async wrapper, using `descriptor.request.source` and `descriptor.request.schema`. Move the wrapper body unchanged.
   - Replace the return object with `const bind = <M extends RouteMethod>(method: M) => ((d: RouteDefinition, h: Function) => register(method, d, h)) as TypedDescriptorRegister<M>;` and `return { get: bind("get"), post: bind("post"), patch: bind("patch"), del: bind("delete"), put: bind("put") }`.
   - Drop the now-duplicate `HttpMethod` alias in favor of `RouteMethod`, and narrow `RuntimeInputSource` to the descriptor sources, or delete it.
   - Keep `TypedJsonArgs`, `TypedContext`, `NoBodyHandler`, `WithInputHandler`, `DescriptorHandler`, `TypedDescriptorRegister`, `TypedRoutesOptions` and `validationMessageFromZodError` unchanged.
   - Port the tests in `packages/hono-typed-routes/test/typed-routes.test.ts`. Delete `TestSchema` (`:13-20`) and the string-form query test (`:45-63`); the descriptor test at `:79-95` already covers query parsing and `"Required"`. Rewrite the no-schema test (`:65-77`) against a `noRequest()` descriptor for `/ping`.
   - Add one `jsonRequest` POST descriptor test. It should assert three things: a valid body is parsed, a non-JSON body produces `{ message: "Invalid JSON request body" }`, and a schema failure produces the zod message. This branch is restructured in this checkpoint and is otherwise uncovered.
5. **Checkpoint D: remove the dead `Schema` type parameter.** This step is mechanical and should be a separate commit. Change `export function typedRoutes<Schema>(` to `export function typedRoutes(`. In the 35 files, change `typedRoutes<PublicApiSchema>(` (and the two host-daemon variants) to `typedRoutes(`, and delete the corresponding `type …Schema` import specifier. Each file currently uses that type exactly twice, so it becomes unused. Verify with `git grep -n "typedRoutes<" -- apps packages`, which must return nothing. If Alex prefers smaller churn, skip this checkpoint and give the parameter a default (`<_Schema = unknown>`) with a one-line comment that it is ignored. That alternative keeps a misleading parameter and is not recommended.
6. **Clean up and recount.** Confirm that `git grep -n "registerFromArgs\|TypedRegisterWithDescriptor\|RouteInputForMethod\|Endpoint<" -- packages apps` returns only `route-descriptor.ts`, `endpoint.ts` and the `TypedJsonArgs` use. Then run `wc -l packages/hono-typed-routes/src/typed-routes.ts packages/host-daemon-contract/src/session.ts packages/host-daemon-contract/src/local.ts` and `git diff --stat` against the baseline, and report the actual production and test line deltas separately. Inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

Run every command from the repository root of the working checkout. The `pnpm --filter <pkg> typecheck` and `pnpm --filter <pkg> test` forms invoke `package.json` scripts that exist at the snapshot (`tsc --noEmit` and `vitest run --config vitest.config.ts`) in `@omnyo/hono-typed-routes`, `@omnyo/host-daemon-contract`, `@omnyo/server`, `@omnyo/host-daemon`, `@omnyo/app`, `@omnyo/sdk`, `@omnyo/server-contract` and `omnyo-app`. None of these commands could be executed during the audit, because the snapshot has no `node_modules`.

- **Types:**
  - `pnpm --filter @omnyo/hono-typed-routes typecheck`
  - `pnpm --filter @omnyo/host-daemon-contract typecheck`
  - `pnpm --filter @omnyo/server-contract typecheck`
  - `pnpm --filter @omnyo/server typecheck` (its `tsconfig.json` includes `test`, so this also checks the `hc` client in `internal-session-protocol-version.test.ts`)
  - `pnpm --filter @omnyo/host-daemon typecheck`
  - `pnpm --filter @omnyo/app typecheck` (covers the `createHostDaemonLocalClient` calls in `apps/app/src/lib/api-host-daemon.ts`)
  - `pnpm --filter @omnyo/sdk typecheck`

  All must pass with no new `@ts-expect-error` or casts at the call sites.
- **Package behavior:** `pnpm --filter @omnyo/hono-typed-routes test` must pass. That run covers query parsing and `"Required"`, the no-request route, and the new JSON-body and invalid-JSON assertions.
- **Server internal routes:** `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/internal/internal-skill-trees.test.ts test/internal/internal-plugin-host-artifacts.test.ts test/internal/internal-project-attachment-content.test.ts test/internal/internal-session-protocol-version.test.ts test/internal/internal-interactive-requests.test.ts test/internal/internal-events-tool-calls.test.ts test/internal/internal-event-receipts.test.ts test/host-join-enroll.test.ts test/public/public-host-enrollment.test.ts`. `apps/server/vitest.config.ts:15-25` accepts exact `test/…` file filters. The file names were confirmed to exist at the snapshot, but which assertions each file makes on these routes was only partly inspected. Expect all to pass unchanged, including the 201 statuses, binary bodies and `invalid_request` 400 errors.
- **Host daemon local API:** `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts src/local-api.test.ts`. This file exercises `/status`, `/workspace-open-targets` and `/open-in-target` through `createHostDaemonLocalClient`. Expect a pass unchanged.
- **Contract:** `pnpm --filter @omnyo/host-daemon-contract test`.
- **Public SDK declarations (optional but recommended):** run `pnpm --filter omnyo-app build` before and after the change, then run `cmp` on `packages/omnyo-app/dist/index.d.ts`. Expect no difference. Whether the build runs offline in a fresh worktree was not confirmed. If it does not, record that and rely on the `@omnyo/sdk` typecheck.
- **Formatting and lint:** run `pnpm exec oxfmt <changed files>` and then `pnpm exec oxlint --deny-warnings --format=agent <changed files>` from the root. `oxfmt` and `oxlint` are root `devDependencies`, and `pnpm format:check` is a root script.
- **Structural completion:**
  - `git grep -n "typedRoutes<"` returns nothing (after checkpoint D).
  - No call to `get`, `post`, `put`, `patch` or `del` from `typedRoutes` passes a string first argument.
  - `HostDaemonInternalSchema` and `HostDaemonLocalSchema` are derived only through `ApiSchemaFromRouteDescriptors`.
  - `typed-routes.ts` exports one call signature per method.
- No UI is affected, so no visual check is needed. Performance is not measured. The change is neutral by inspection, and no budget exists for route registration.

**Rollback and stop conditions**

- **Rollback boundary:** each checkpoint is a self-contained commit with no persisted data and no wire-format change; paths, statuses and bodies are identical. Reverting the checkpoint C and D commits restores the string form without touching the contract tables. Reverting the checkpoint A and B commits restores the hand-written maps.
- **Stop if any of the following happens:**
  - The parity assertion in checkpoint A fails and cannot be fixed by choosing the right request or response helper. This would mean `hc` client types change for a consumer.
  - A handler's input type narrows or widens enough to need casts.
  - Removing the `Schema` generic exposes an external or unlisted consumer that passes a type argument.
  - The string-path scan finds a registration the descriptor helpers cannot express. For example, a `form` input with a schema has no descriptor helper today.
- **Safer smaller alternative:** if a stop condition fires, land checkpoints A and B alone (descriptors in the contract, descriptor registrations) and keep the string form for the problem route. Record which route needs it and why. Then reassess whether the string form should be retired or kept as a supported second form.
