# RF-110 — Build the plugin SDK's setting-descriptor registration validator by extending the server-contract wire variants

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and matches field for field. Two parts of the sweep report were wrong, and this card corrects them:
  - The plugin SDK does not bundle any server-contract runtime code today. It only imports server-contract types. This change adds the first runtime edge, so it must import from a small leaf module rather than the server-contract barrel.
  - The net reduction is about 35-45 production lines, not 45-60.
- **Potential:** low. One duplicated zod schema family disappears, together with the drift risk it carries. The line gain is small.
- **Confidence:** high. The schemas were compared line by line, and the zod `extend` behaviour this plan relies on was reproduced against the repository's installed zod 4.6.7.
- **Readiness:** ready.
- **Effort:** small, about 2-3 hours including the bundle check.
- **Risk:** low to medium. This validator runs on every plugin's `api.settings.define()` call, in both the production host and the SDK fake host. The realistic regressions are a lost `.strict()`, a lost refinement, a changed error message, or the server-contract barrel being pulled into the plugin SDK runtime bundle.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-107 (route CLI plugin settings commands through the SDK client) removes the fourth, looser copy in `apps/cli/src/commands/plugin.ts:159` "pluginSettingDescriptorSchema". It is independent of this card.
  - RF-003 (share one backend registration core between the production plugin API and the fake host) touches the same file, `packages/plugin-sdk/src/internal/host-policy.ts`. `registerSettingDescriptors` is already shared by both hosts, so the two items do not conflict. Land them in either order and rebase.
- **Why it deserves its place:** both schemas encode the same public descriptor format. When they drift, the result is visible to users. Suppose a field is added to the registration validator but not to the wire schema. Every client parses the settings response with the strict wire schema (`packages/sdk/src/areas/plugins.ts:794` and `:865`), so a plugin using the new field would get settings responses that every client rejects. After this change that failure cannot happen, except through `experimental_schema`, which the server deliberately strips.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had already been removed when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c…:<path>`. At the time of writing, `git diff --stat e9e1b74c HEAD` on the four central files was empty, so the line anchors also hold on the checked-out `main`.

How the subsystem works: a plugin declares settings with `api.settings.define({ key: descriptor })`. The host validates each descriptor and stores the validated object in memory. When asked, the server sends the descriptors to clients without `experimental_schema`, and the app, CLI and SDK clients parse the response.

Observed facts (Proven by inspection unless marked otherwise):

1. **Registration validator.** It lives in `packages/plugin-sdk/src/internal/host-policy.ts:212-301`, made up of `settingSectionSchema`, `settingsBaseFields`, `settingPlaceholderSchema`, three `z.custom<StandardSchemaV1<…>>` guards and `settingDescriptorSchema`. That is 84 non-blank lines, counted with `git show e9e1b74c:packages/plugin-sdk/src/internal/host-policy.ts | sed -n 212,301p | grep -cv '^\s*$'`. `registerSettingDescriptors` calls it at line 329, and that function is used by:
   - the production host, at `apps/server/src/services/plugins/plugin-api.ts:931`;
   - the fake host, at `packages/plugin-sdk/src/testing/fake-plugin-host.ts:927`.

   After parsing, `registerSettingDescriptors` applies more checks, which stay unchanged:
   - a select default must be one of its options (lines 341-349);
   - an option label must name an existing option (lines 351-361);
   - sections that share a title must share a description (lines 363-380);
   - a default must pass `validateSettingsUpdate` (lines 382-391).
2. **Wire schema.** It lives in `packages/server-contract/src/api/plugins.ts:416-476`, made up of `pluginSettingBaseSchema`, the exported `pluginSettingDescriptorSchema` and `type PluginSettingDescriptor`. That is 59 non-blank lines, counted with the same command over lines 416-476. `pluginSettingsResponseSchema` uses it at line 478. `packages/server-contract/src/api-types.ts:15` re-exports the whole file, and the package barrel `packages/server-contract/src/index.ts` exposes it.
3. **The two schemas match field for field.** For each of the five variants, they have identical field names, the same `.min(1)`, `.finite()` and `.min(1)`-on-options constraints, the same `z.literal(true)` for `secret`, and the same `.strict()` on every object and on the section. The registration schema differs in only two ways:
   - Each variant has an `experimental_schema` field, a `z.custom` StandardSchema guard.
   - The string variant has a `.refine` that rejects `secret: true` together with `experimental_multiline: true`, with the message "a secret setting cannot be experimental_multiline" and the path `["experimental_multiline"]`.

   Key order also differs. Host-policy puts `type` first. The wire schema puts `label`, `description` and `experimental_section` first, then `type`.
4. **The server strips the extra field.** `apps/server/src/services/plugins/plugin-settings.ts:120-127` "publicSettingDescriptor" deletes `experimental_schema` before sending.
5. **The plugin SDK uses server-contract only for types (correction to the sweep report).** In `packages/plugin-sdk/src`, outside tests, the only imports from `@omnyo/server-contract` are `import type` statements, in `app-contract.ts:34-38`, `backend-contract.ts:36-39` and `environment-provider.ts:2`. This was found with a Python regex over every non-test file in that directory that names `@omnyo/sdk` or `@omnyo/server-contract`, classifying each import as type or value. `@omnyo/server-contract` is a devDependency in `packages/plugin-sdk/package.json:163`. The runtime build uses esbuild with `bundle: true` and `conditions: ["source"]`, and it externalizes only `zod`, `cross-spawn`, `react` and the entries listed in `EXTRA_EXTERNALS` (`packages/plugin-sdk/scripts/runtime-entries.mjs`). A runtime import would therefore inline server-contract code into `dist/internal/host-policy.js` and `dist/testing/*.js`.

   `packages/server-contract/src/index.ts` is a barrel that re-exports `api-client.js`, `public-api.js` and `typedRoutes` from `@omnyo/hono-typed-routes`, among others. `api/plugins.ts` alone is 834 lines of top-level zod calls, which esbuild keeps if the file is reached. Host-policy already imports the `@omnyo/domain` barrel at runtime (lines 21-33), so barrel tree-shaking is already relied on there. Even so, pulling in server-contract's barrel is an unmeasured bundle risk.
6. **The authoring type is a third copy and stays.** `packages/plugin-sdk/src/backend-contract.ts:101-159` "PluginSettingDescriptor" carries the public JSDoc that the published plugin SDK types expose. `registerSettingDescriptors` assigns `parsed.data` to `PluginSettingDescriptors` at line 393, so TypeScript already checks that the inferred zod type fits the authoring type. TypeScript does not check the reverse direction.
7. **Zod behaviour (Reproduced** with `node --input-type=module` against `node_modules/.pnpm/zod@4.6.7` in the canonical checkout):
   - `strictObject.extend({ experimental_schema })` keeps strictness, so an unknown key is still rejected.
   - Calling `.refine` on the extended object inside `z.discriminatedUnion` still reports the custom issue with the same path.
   - The guarded `experimental_schema` value survives parsing by identity (`===`).
   - The parsed output follows shape order, so `extend` appends `experimental_schema` after `default`.
   - The installed `util.extend` throws only when the source schema has checks and the new keys overlap existing ones. The wire variants have no checks.
8. **Other consumers.** I searched with `git grep -n "pluginSettingDescriptorSchema\|PluginSettingDescriptor\b\|settingDescriptorSchema\|pluginSettingsResponseSchema\|registerSettingDescriptors" e9e1b74c -- . ':!*.md'`. Besides the files above, it found:
   - the app's type alias in `apps/app/src/hooks/queries/plugin-settings-queries.ts:5,169`;
   - the CLI's looser copy in `apps/cli/src/commands/plugin.ts:159` (see RF-107);
   - `apps/server/test/services/plugins/plugin-authoring-docs.test.ts:37,214-217`;
   - `packages/plugin-sdk/src/__tests__/public-types.test.ts:146`;
   - `packages/server-contract/test/plugins.test.ts:8,34-46`;
   - the authoring user in `plugins/ask-user-question/src/sidebar/settings-contract.ts`;
   - the docs listing in `plugins/plugin-api-docs/src/surfaces.ts:848`.

   None of them construct either zod schema. I found no persistence of validated descriptors: `git grep` over `apps/server/src/services/plugins` for descriptors together with stringify, insert, persist, hash or write returned nothing. A search with no hits does not prove absence. The check that would show otherwise is a runtime trace of where `settingsRecord.descriptors` flows, and I did not run it.
9. **Existing test coverage of this boundary.**
   - `packages/plugin-sdk/src/testing/__tests__/fake-plugin-host.test.ts:608-726` "rejects duplicate and invalid descriptors at define time" asserts the exact error strings: option default, option labels, the secret-multiline refine with its `(experimental_multiline)` path, invalid number, a transforming or async `experimental_schema`, and section conflicts.
   - `apps/server/test/services/plugins/plugin-settings-storage.test.ts:267,323,476` covers `experimental_schema` round-trip, stripping on the wire, and an invalid descriptor marking the plugin as errored.
   - `packages/server-contract/test/plugins.test.ts:33-47` covers finite number descriptors on the wire.

**Maintenance cost today.** Adding or tightening a descriptor field means editing `host-policy.ts`, `server-contract/src/api/plugins.ts`, `backend-contract.ts` and the renderer, and keeping the two zod copies identical by hand. No test compares the two copies.

**Proposed end state and preservation argument**

- **Canonical owner.** The wire contract owns the five variant objects: string, boolean, number, select and project. They move into a new leaf module, `packages/server-contract/src/api/plugin-setting-descriptor.ts`, which imports only `zod`. It exports:
  - `pluginStringSettingDescriptorSchema`, `pluginBooleanSettingDescriptorSchema`, `pluginNumberSettingDescriptorSchema`, `pluginSelectSettingDescriptorSchema` and `pluginProjectSettingDescriptorSchema`, all strict and without refinements;
  - `pluginSettingDescriptorSchema`, the discriminated union, unchanged in meaning;
  - `type PluginSettingDescriptor`.

  `api/plugins.ts` re-exports `pluginSettingDescriptorSchema` and `PluginSettingDescriptor` from the new module, so every existing import from `@omnyo/server-contract` keeps working. `packages/server-contract/package.json` gains a subpath export, `"./plugin-setting-descriptor"`, with the same `source`, `types` and `default` shape as `"."`. The plugin SDK imports that subpath, so its runtime bundle never reaches the barrel.
- **What disappears.** In `host-policy.ts`, the second copy goes: `settingSectionSchema`, `settingsBaseFields`, `settingPlaceholderSchema` and the five inline `z.object` bodies.
- **What remains in host-policy.** The three `z.custom` StandardSchema guards stay. `settingDescriptorSchema` becomes:

  ```ts
  const settingDescriptorSchema = z.discriminatedUnion("type", [
    pluginStringSettingDescriptorSchema
      .extend({ experimental_schema: stringSettingSchemaSchema.optional() })
      // (keep the existing comment)
      .refine(
        (d) => !(d.secret === true && d.experimental_multiline === true),
        {
          message: "a secret setting cannot be experimental_multiline",
          path: ["experimental_multiline"],
        },
      ),
    pluginBooleanSettingDescriptorSchema.extend({ experimental_schema: booleanSettingSchemaSchema.optional() }),
    pluginNumberSettingDescriptorSchema.extend({ experimental_schema: numberSettingSchemaSchema.optional() }),
    pluginSelectSettingDescriptorSchema.extend({ experimental_schema: stringSettingSchemaSchema.optional() }),
    pluginProjectSettingDescriptorSchema.extend({ experimental_schema: stringSettingSchemaSchema.optional() }),
  ]);
  ```

  All post-parse checks in `registerSettingDescriptors` stay exactly as they are.
- **What stays unchanged.** The TypeScript authoring type `PluginSettingDescriptor` in `backend-contract.ts` stays, because it is public documentation. The server's `publicSettingDescriptor` stays. The CLI copy stays, because RF-107 owns it.
- **Why existing behaviour survives:**
  - The wire schema is moved without edits, so client strictness is unchanged.
  - Registration accepts exactly the same field set as before, because the wire fields plus `experimental_schema` equal the old registration fields (fact 3). Strictness, the refine, and `experimental_schema` identity carry over (fact 7).
  - Error messages for single-issue inputs are unchanged, because the issues and paths are the same.
- **Intentional, documented differences:**
  - (a) The key order of validated descriptors changes from `type`-first to wire order, with `experimental_schema` last. This shows up only in the order of the server's JSON settings response, and every client re-parses that response. No persistence of validated descriptors was found (fact 8). If byte-identical response order is wanted, put `type` first inside the moved wire variants instead. Clients parse their output into wire order anyway.
  - (b) When a descriptor has several invalid fields, `registerSettingDescriptors` reports `issues[0]`, which may now be a different field. For example, an invalid `default` is now reported before an invalid `experimental_schema`, because `experimental_schema` moved to the end of the shape. Single-error messages do not change.
- **Why this is the simplest sufficient option.** The alternative is to keep both schemas and add a parity test. That removes no maintained mechanism and still needs every field written twice. Building the wire schema from the registration schema with `.omit` is not possible, because server-contract does not depend on the plugin SDK. Putting the variants in `@omnyo/domain` would also work, since both packages depend on it, but it would move wire-contract ownership away from server-contract for no gain.
- **Non-goals:**
  - Merging the TypeScript authoring type into `z.infer`, because that would lose the public JSDoc.
  - Changing the CLI copy, which RF-107 owns.
  - Changing any field, constraint or message.

**Expected gain and cost**

These are projections, not measurements.

| Item | Before | After |
|---|---|---|
| Zod definitions of the descriptor format | 2 (host-policy, server-contract) | 1, extended once |
| Other copies | TS authoring type, CLI subset | unchanged (the CLI subset goes under RF-107) |
| `host-policy.ts` block, non-blank lines | 84 | about 35-40 |
| server-contract, non-blank lines | 59 | about 63-68 (named variant consts, the new module's import, and re-export lines) |
| `server-contract/package.json` | 1 export | 2 exports (+5 JSON lines) |
| Net handwritten production lines | — | about −35 to −45 |
| Tests, generated code, docs | — | no change expected; one optional test (see Verification) |

- **How this eases maintenance.** A new or tightened descriptor field is written once in server-contract. The registration validator inherits it, so the "accepted at registration, rejected by clients" drift can no longer occur.
- **Cost.** The plugin SDK runtime bundle gains its first runtime dependency on server-contract code: one small module, about 60 lines of zod. Performance impact is unknown but expected to be negligible. That expectation is a hypothesis, and the bundle check in step 4 replaces it with a measurement.

**Execution steps**

1. **Reconfirm the baseline.** In `$OMNYO_CHECKOUT`, or in your own worktree off current `main`, check that the following still match facts 1-3 and 5:
   - `packages/plugin-sdk/src/internal/host-policy.ts` "settingDescriptorSchema";
   - `packages/server-contract/src/api/plugins.ts` "pluginSettingDescriptorSchema";
   - `packages/plugin-sdk/scripts/runtime-entries.mjs` "PACKAGE_EXTERNALS".

   Stop and re-plan if any of these holds:
   - The two schemas no longer match apart from `experimental_schema` and the refine.
   - A wire variant has gained a `.refine` or `.superRefine`. `extend` then constrains overlapping keys, and the wire strictness argument has to be redone.
   - The plugin SDK already imports server-contract at runtime somewhere. Then the bundle concern changes.
2. **Capture a bundle baseline.**
   1. Run `pnpm --filter @omnyo/plugin-sdk build:runtime` from the repository root. This script exists in `packages/plugin-sdk/package.json`.
   2. Record `wc -c packages/plugin-sdk/dist/internal/host-policy.js packages/plugin-sdk/dist/testing/index.js`.
   3. Record `grep -c "z\.\|zod" packages/plugin-sdk/dist/internal/host-policy.js` as a rough fingerprint.

   No new behavioural fixture is needed, because the fake-host tests at `fake-plugin-host.test.ts:608-726` already pin the error strings.
3. **Move the wire variants.** This checkpoint is a mechanical move.
   1. Create `packages/server-contract/src/api/plugin-setting-descriptor.ts`.
   2. Move `pluginSettingBaseSchema` (unexported), the five variants as named `export const`s, `pluginSettingDescriptorSchema` and `type PluginSettingDescriptor` there verbatim, keeping `.strict()` everywhere.
   3. In `api/plugins.ts`, replace lines 416-476 with `import { pluginSettingDescriptorSchema } from "./plugin-setting-descriptor.js";` and `export { pluginSettingDescriptorSchema, type PluginSettingDescriptor } from "./plugin-setting-descriptor.js";`. `pluginSettingsResponseSchema` keeps using it.
   4. Add the `"./plugin-setting-descriptor"` subpath to `packages/server-contract/package.json` "exports", following the `"."` entry's `source`, `types` and `default` form.

   Checkpoint: run `pnpm --filter @omnyo/server-contract typecheck` and `pnpm --filter @omnyo/server-contract test`. Both should pass with `test/plugins.test.ts` unchanged.
4. **Derive the registration validator.** This checkpoint is the semantic change.
   1. In `host-policy.ts`, add `import { pluginStringSettingDescriptorSchema, … } from "@omnyo/server-contract/plugin-setting-descriptor";`.
   2. Delete `settingSectionSchema`, `settingsBaseFields` and `settingPlaceholderSchema`.
   3. Rewrite `settingDescriptorSchema` as shown in the end state. Keep the three `z.custom` guards and the existing comment about secrets, and leave `registerSettingDescriptors` untouched.
   4. Optional, only if decided: put `type` first in the moved variants to keep the response key order.

   Checkpoint:
   - Run `pnpm --filter @omnyo/plugin-sdk typecheck` and `pnpm --filter @omnyo/plugin-sdk test`. `fake-plugin-host.test.ts` must pass with no assertion edits.
   - Rebuild with `pnpm --filter @omnyo/plugin-sdk build:runtime`. Then check `grep -E "hono|typedRoutes|pluginCatalogSearchResponseSchema|installedPluginSchema" packages/plugin-sdk/dist/internal/host-policy.js` and expect no matches. Compare `wc -c` with the step 2 baseline and expect growth of no more than a few KB.
   - If the barrel or unrelated schemas appear in the bundle, stop. The import is resolving through `.` rather than the subpath.
5. **Clean up.**
   - Confirm that `host-policy.ts` no longer contains any `label: z.string().min(1)` descriptor fields.
   - Confirm that `rg -n "experimental_optionLabels" packages/plugin-sdk/src/internal packages/server-contract/src` shows only the new module.
   - `packages/plugin-sdk/package.json` already lists `@omnyo/server-contract` as a devDependency, so no dependency edit is needed.
   - Generated bundled d.ts files are unaffected, because `settingDescriptorSchema` is not exported. If `build:types` output changes, investigate before accepting it.
   - Format and lint the touched files from the repository root:
     - `pnpm exec oxfmt packages/server-contract/src/api/plugin-setting-descriptor.ts packages/server-contract/src/api/plugins.ts packages/plugin-sdk/src/internal/host-policy.ts packages/server-contract/package.json`
     - `pnpm exec oxlint --deny-warnings --format=agent` on the same files.
6. **Review the full diff.** It should touch only the four files above and, if added, one test. Recount non-blank lines with the step 1 commands and report the actual net reduction against the 84 + 59 baseline.

**Verification and acceptance criteria**

Commands are run from the repository root. The `test`, `typecheck` and `build:runtime` script names were read from each package's `package.json` at the snapshot. The `pnpm --filter <name> <script>` form is standard pnpm and was not executed here, because the snapshot had no `node_modules`.

- **Contract and behaviour:**
  - `pnpm --filter @omnyo/plugin-sdk test`. In particular `src/testing/__tests__/fake-plugin-host.test.ts` "rejects duplicate and invalid descriptors at define time" must pass with no expected-string edits.
  - `pnpm --filter @omnyo/server-contract test`. This covers `test/plugins.test.ts` "accepts finite number setting descriptors".
  - `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-settings-storage.test.ts`. This covers the `experimental_schema` round-trip at line 267, stripping on the wire at line 323, and the invalid descriptor marking the plugin as errored at line 476. The `--` pass-through to vitest is assumed, not confirmed.
  - Recommended new test, because no test today shows that the registration validator stays strict for keys the wire rejects: in `fake-plugin-host.test.ts`, assert that `api.settings.define({ x: { type: "boolean", label: "X", experimental_placeholder: "p" } })` throws `invalid descriptor for setting "x"`. This is a strict-key rejection inherited from the wire variant.
- **Typecheck:** `pnpm --filter @omnyo/plugin-sdk typecheck`, `pnpm --filter @omnyo/server-contract typecheck`, `pnpm --filter @omnyo/server typecheck`, and `pnpm --filter @omnyo/sdk typecheck`, because the SDK consumes `pluginSettingsResponseSchema`.
- **Bundle:** step 4's grep must find nothing, and the `dist/internal/host-policy.js` size delta must be small and explained.
- **UI:** none. The renderer `PluginSettings.tsx` and the wire output are unchanged. The only possible difference is descriptor key order in the JSON response, which clients normalise when they parse it.
- **Performance:** registration runs once per `define()` call, so no runtime budget applies. The bundle-size comparison in step 4 is the relevant measurement.
- **Structural completion:**
  - Exactly one zod definition of the descriptor fields exists, in `packages/server-contract/src/api/plugin-setting-descriptor.ts`.
  - `host-policy.ts` holds only the `experimental_schema` extension and the refine.
  - No second set of `settingsBaseFields` or `pluginSettingBaseSchema` remains.

**Rollback and stop conditions**

- **Rollback.** The change is one local commit across four source files (five with the optional test). It changes no persisted data and no wire format, so reverting the commit fully restores the previous state.
- **Stop conditions:**
  - A fake-host or server test needs an expected error string changed, other than an intentional multi-issue reorder that you document.
  - The plugin SDK runtime bundle pulls in server-contract's barrel, hono or unrelated schemas, and the subpath import cannot prevent it.
  - A supported external consumer depends on the exact key order of the settings response.
  - Zod `extend` loses strictness or the refine in a future zod version. If so, fall back to keeping both schemas and adding a parity test that parses a representative descriptor of every variant through both schemas, minus `experimental_schema`, and asserts identical accept and reject results.
