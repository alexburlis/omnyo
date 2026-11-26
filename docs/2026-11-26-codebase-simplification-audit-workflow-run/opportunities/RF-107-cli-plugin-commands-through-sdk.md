# RF-107 — Delete the CLI's private plugin HTTP helper (`callPlugins`) and its copied setting-descriptor schemas; route plugin settings, token, reload, enable/disable and remove through `sdk.plugins`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** low. About 25–35 handwritten production lines disappear net, all in one file. The value is mostly in removing a second HTTP client path and a copied descriptor schema that has already drifted from the server contract, not in line count.
- **Confidence:** high. Every cited symbol was re-read at the snapshot. The web app already calls the same SDK methods against the same routes.
- **Readiness:** conditional. One small owner decision gates it: accept that `omnyo plugin config <id> --json` starts printing the descriptor fields that the server already sends (an additive JSON change, see the issue below). A second, smaller choice is where the `logs` read lives (step 3e).
- **Effort:** small, about half a day to one day including tests.
- **Risk:** low. Blast radius is six `omnyo plugin` subcommands plus the `omnyo plugin dev` reload step. The likely regression is a changed error message or a lost `{ok:false,error}` JSON body on HTTP 400/404/409/422.
- **Prerequisites:** none. The decision gate in step 2 must be answered first.
- **Related or overlapping:** RF-110 (build the plugin-SDK setting-descriptor validator from the server-contract schema). RF-110 and this card each remove a different copy of the same descriptor knowledge, so count their savings separately. RF-063 (put plugin routes in the typed public route table) would later give the SDK methods typed routes. It neither blocks this card nor is blocked by it. RF-069 (one typed helper for contract-validated Tasks CLI calls) applies the same pattern elsewhere in the CLI.
- **Why it deserves its place:** the copied schema is not hypothetical duplication. It is already narrower than the contract and silently drops fields from CLI JSON output. Every new setting-descriptor field means editing the contract and remembering this CLI copy. The fix is local, reversible and uses methods the app already relies on.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the task did not exist on disk, so every file below was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. At this commit, `apps/cli/src/commands/plugin.ts` is byte-identical to the current checkout (`cmp`). No tests were run, because the snapshot has no `node_modules`.

What the subsystem does: `omnyo plugin …` commands (in `apps/cli/src/commands/plugin.ts` "registerPluginCommands") manage installed plugins on the Omnyo server. Most subcommands already call the typed SDK through `createCliOmnyoSdk(getUrl()).plugins.*`: `list`, `source`, `catalog`, `install`, `updates`, `safe-mode`, the install jobs and the RPC calls. Six subcommands and the dev loop instead use a private helper.

Observed facts (Proven by inspection):

- `apps/cli/src/commands/plugin.ts:431-463` "callPlugins" calls `cliFetch` against `${baseUrl}/api/v1/plugins${path}`. It parses the body itself, throws `Unexpected response from …` on non-JSON, and throws `… failed: HTTP <status>` for non-OK statuses. The exception is HTTP 400, 404, 409 and 422: for those it returns the body as if it were a normal result. `cliFetch` (imported at `:47`) has no other use in this file.
- The local schemas are `:159-167` "pluginSettingDescriptorSchema", `:172-177` "pluginSettingsResultSchema", `:179-183` "pluginTokenResultSchema" and `:185-189` "pluginLogsResultSchema". The local types are `:427` "PluginSettingDescriptor" and `:429` "PluginSettingsResult". Line count method: `sed -n <range>p … | grep -cv '^\s*$'`. Result: 56 non-blank lines (9 + 6 + 5 + 5 + 2 + 29), or 61 physical lines.
- There are nine `callPlugins` call sites:

| Call site | Command | Route | SDK method at `packages/sdk/src/areas/plugins.ts` |
|---|---|---|---|
| `:1992-2001` "reloadPlugin" | `plugin dev` | `POST /reload?id=` | `:829` "reload" |
| `:2041-2044` | `plugin reload [id]` (`.command` at `:2033`) | `POST /reload[?id=]` | `:829` "reload" |
| `:2093-2099` | `plugin enable/disable <id>` (`:2088`) | `POST /:id/enable` and `POST /:id/disable` | `:782` "enable", `:773` "disable" |
| `:2310-2312`, `:2351-2353` | `plugin config <id>` read, and the read before `set` (`:2265`) | `GET /:id/settings` | `:791` "getSettings" |
| `:2373-2377` | `plugin config <id> set/unset` | `PUT /:id/settings` | `:858` "updateSettings" |
| `:2397-2404` | `plugin token <id> [--rotate]` (`:2388`) | `POST /:id/token` | `:847` "token" |
| `:2441-2447` | `plugin logs <id>` (`:2429`) | `GET /:id/logs?tail=` | none |
| `:2484-2486` | `plugin remove <id>` (`:2475`) | `DELETE /:id` | `:840` "remove" |

- Server behaviour, `apps/server/src/routes/plugins.ts`:
  - `:957-963` reload returns the whole `PluginReloadOutcome` with status 422 on failure. That outcome is `{ok:false,error,plugins}` (`apps/server/src/services/plugins/plugin-service.ts:229-231`).
  - `:984-1000` enable and disable return `{ok:true,plugin}`, or `{ok:false,error:"unknown plugin"}` with status 404.
  - `:1010-1045` settings GET/PUT return `{ok:true,schema,values}`. Failures are 404 `NOT_RUNNING`, or 400 for a bad body or a `PluginSettingsValidationError`.
  - `:1047-1064` remove returns `{ok:true}`, 409 with the refusal text, or 404.
  - `:1066-1095` token returns `{ok:true,token}`, 400 or 404.
  - `:747-761` logs returns `{ok:true,lines}` or 404.
  - Every failure body is `{ok:false,error}`. This is exactly why `callPlugins` passes those four statuses through.
- Server contract, `packages/server-contract/src/api/plugins.ts`. The descriptor schema is `:416-476` "pluginSettingBaseSchema"/"pluginSettingDescriptorSchema", a strict discriminated union. It includes `experimental_section.description`, `experimental_multiline`, `experimental_placeholder` and `experimental_optionLabels`. The other schemas are `:478` "pluginSettingsResponseSchema", `:584-591` "pluginTokenRequestSchema"/"pluginTokenResponseSchema", `:405` "pluginReloadResponseSchema" and `:412` "pluginRemoveResponseSchema". There is no logs schema.
- The CLI's local descriptor is a non-strict `z.object`, and its `experimental_section` is `z.object({ title })`. Zod 4 strips unknown keys by default. So `omnyo plugin config <id> --json` prints descriptors without those four fields. This is the incidental issue recorded below, and ISS-S12-02 in the sweep.
- The SDK methods use `requestParsed` (`packages/sdk/src/areas/plugins.ts:395-407`). It goes through `transport.resolve`, which is `resolveResponse` (`packages/sdk/src/response.ts:144-170`). On any non-OK status it throws `OmnyoHttpError` with `status`, `code` and the parsed JSON `body` (`response.ts:84-98` and `:333-379` "readHttpErrorInfo"). The CLI already has `sdkErrorMessage` (`plugin.ts:780-786`), which strips the `HTTP <n>: ` prefix.
- SDK return shapes that differ from what the CLI prints. `enable` and `disable` return only `response.plugin` (`:773-789`), while the CLI's JSON output today is `{ok:true,plugin}`. `reload` parses an SDK-local `pluginReloadResponseSchema` (`:98-101`) built on the same `installedPluginResponseSchema` that the CLI's current `pluginMutationResponseSchema` (`:111-116`) uses. So the parsed plugin objects are identical.
- Request differences:
  - SDK `reload`, `enable` and `disable` send a JSON body `{}`; `callPlugins` sends none. The server does not read a body on those routes.
  - SDK `token` sends `{rotate:false}` where the CLI sends `{}`. `pluginTokenRequestSchema` defaults `rotate` to false, so the two are equivalent.
  - The SDK validates `pluginId` with `z.string().min(1)` (`pluginPath`, `:385-389`). An empty id would now fail locally before any request is sent.
- Headers. `createCliOmnyoSdk` (`apps/cli/src/client.ts:113-131`) wraps `cliFetch` in `callerFetch`, so the proxy dispatcher is unchanged. `callerFetch` adds the caller-thread and automation headers. It adds the analytics-consent and user-activity headers only for `usageRequestEligible` paths (`packages/domain/src/usage-telemetry.ts:219-234`); none of these plugin paths is eligible. The only server consumers of the caller headers outside thread and inbox routes are `apps/server/src/routes/previews.ts:47` and the usage middleware at `apps/server/src/server.ts:875-894`. That middleware uses them only to compute `interactive`, which also requires `usageRequestEligible`. Searched with `git grep -n "INBOX_CALLER_THREAD_HEADER\|INBOX_CALLER_AUTOMATION\|x-omnyo-caller" e9e1b74c -- apps/server/src`. Switching transport is therefore neutral for telemetry and inbox attribution.
- Timeouts. `createNodeTransport` (`packages/sdk/src/node.ts:49-63`) adds the 75-second request timeout only when no `fetch` is passed, and the CLI always passes one. Timeout behaviour is unchanged.
- The same SDK methods already serve production through the web app. `apps/app/src/hooks/queries/plugin-settings-queries.ts:181` (getSettings), `:198` (updateSettings), `:213-214` (enable/disable), `:221` (reload) and `:228` (remove) all go through `createPluginsClient` → `createBrowserOmnyoSdk(...).plugins`. So the strict contract descriptor schema already parses what the current server emits. The server strips the only non-contract field, `experimental_schema`, in `apps/server/src/services/plugins/plugin-settings.ts:121-127` "publicSettingDescriptor". The plugin-SDK validator (`packages/plugin-sdk/src/internal/host-policy.ts:219-302`) allows the same fields as the contract plus `experimental_schema`.
- No other caller of the logs route was found: `git grep -n "/logs?tail\|logs?tail=" e9e1b74c -- apps packages plugins` matches only `plugin.ts:2444`. No in-repo script parses `omnyo plugin config … --json`: `git grep -n "plugin config .*--json" e9e1b74c -- .` matches only CLI tests. That search does not cover the separate `omnyo-plugins` repository or user scripts. Because the JSON change is additive, those consumers would only gain fields.
- Existing tests that encode the contract:
  - `apps/cli/src/__tests__/command-output/plugin-config.test.ts` covers the negative number, unset, the unknown-option and extra-argument rules, and the exact PUT body.
  - `plugin-enable.test.ts` covers a load error mapped to `ok:false` in text and JSON, and the safe-mode hold.
  - `plugin-remove.test.ts` covers the 409 refusal in text without `HTTP 409`, and the 409 refusal in JSON as exactly `{"ok":false,"error":…}`.
  - `plugin-updates.test.ts:371-404` covers reload with an unknown id and with a single id.
  - All of these stub global `fetch`, which both paths reach. No test covers `token`, `logs`, a reload 422, or a settings 404/400.

Counterevidence considered:

- **Is the lenient local schema deliberate version-skew tolerance?** Hypothesis, not supported by evidence. No doc in `docs/platform-support.md`, `docs/system-overview.md` or `docs/repository-overview.md` states a CLI/server skew policy. The local schema already rejects an unknown descriptor `type`, so it is not a general skew guard. The CLI and server ship together (`apps/cli/package.json` is a private workspace package), and the rest of the `plugin` command group already parses strict SDK and contract schemas.
- **Is the status list in `callPlugins` reused elsewhere?** No. It moves into the adapter below rather than disappearing.

Maintenance cost today: adding a descriptor field means editing `server-contract`, the plugin-SDK validator (RF-110) and this CLI copy. Forgetting the CLI copy produces no error, only silently missing JSON output. Plugin routes also have two client paths with different error semantics in the same file.

**Proposed end state and preservation argument**

What disappears from `apps/cli/src/commands/plugin.ts`:

- `callPlugins`.
- `pluginSettingDescriptorSchema`, `pluginSettingsResultSchema` and `pluginTokenResultSchema`.
- The local `PluginSettingDescriptor` and `PluginSettingsResult` types.
- The `cliFetch` import.
- Either `pluginLogsResultSchema` as well, or the helper only (see step 3e).

What remains:

- `printSettings`, `parseSettingValue`, `secretSettingValueSchema`, `negativeNumberValuePattern` and `outputMutationJson`.
- All Commander argument rules.
- The text output.

The canonical owner of the plugin route request and response shapes becomes `@omnyo/sdk` `plugins.*` over the `@omnyo/server-contract` schemas, which is the path the app already uses.

The one new CLI piece is a small adapter that restores today's "structured failure is a result, not an exception" semantics:

```ts
const STRUCTURED_FAILURE_STATUSES = new Set([400, 404, 409, 422]);

type PluginFailure = { ok: false; error?: string; plugins?: PluginEntry[] };

async function pluginResult<T extends { ok: true }>(
  call: Promise<T>,
): Promise<T | PluginFailure> {
  try {
    return await call;
  } catch (error) {
    if (
      error instanceof OmnyoHttpError &&
      STRUCTURED_FAILURE_STATUSES.has(error.status)
    ) {
      const body = pluginMutationResponseSchema.safeParse(error.body);
      if (body.success && !body.data.ok) return body.data;
    }
    throw error;
  }
}
```

`pluginMutationResponseSchema` is already imported from `@omnyo/sdk`. It keeps `plugins` for the reload-422 case and strips nothing else that the current JSON shows, because today's failure bodies are exactly `{ok:false,error}` (plus `plugins` for reload). If `PluginEntry` does not match `pluginMutationResponseSchema`'s inferred `plugins` element (the schema applies defaults), use `PluginMutationResponse["plugins"]` from `@omnyo/sdk` for the type instead.

Preservation, command by command:

- **config (read, set, unset):** use `sdk.plugins.getSettings({pluginId:id})` and `sdk.plugins.updateSettings({pluginId:id, values:{[key]: parsedValue}})` through `pluginResult`. The URL and PUT body are unchanged; the existing test asserts the exact body. Secret redaction is unchanged, because `printSettings` still reads `values[key]` through `secretSettingValueSchema`. `printSettings` takes `PluginSettingsResponse` and `parseSettingValue` takes the contract `PluginSettingDescriptor`, both from `@omnyo/server-contract`. The `descriptor.options` access in `parseSettingValue` and `printSettings` needs a `descriptor.type === "select"` narrowing (or `"options" in descriptor`), because only the `select` branch of the union has `options`. Text output is unchanged.
- **config `--json`:** the only intentional output change. Descriptors now carry every contract field the server already sends. This needs the owner decision in step 2.
- **token:** use `sdk.plugins.token({pluginId:id, rotate: opts.rotate})` through `pluginResult`. JSON stays `{ok:true,token}` or `{ok:false,error}`. Text output prints the token only.
- **reload and the dev-loop reload:** use `sdk.plugins.reload(id ? {pluginId:id} : {})` through `pluginResult`. A 422 body with `plugins` survives, so text output still prints the reloaded entries before `exitWithError`. The unknown-id rewrite at `:2046-2051` and the snapshot note stay. The dev loop keeps `if (!result.ok) throw new Error(result.error ?? "reload failed")`.
- **enable/disable:** use `pluginResult(sdk.plugins[name]({pluginId:id}).then((plugin) => ({ ok: true as const, plugin })))`. The JSON output shape `{ok:true,plugin}` and the load-error rewrite at `:2101-2114` are unchanged.
- **remove:** use `sdk.plugins.remove({pluginId:id})` through `pluginResult`. JSON stays `{ok:true}`, and the 409 refusal still prints without `HTTP 409`.
- **Exit codes:** unchanged. `outputMutationJson` still exits 1 when `!result.ok`, and `exitWithError` still exits 1.

Accepted, documented differences (not silent):

- Errors that are not structured change wording. These are other statuses, a non-JSON body, or a structured status whose body is not `{ok:false,error}`. They now surface through the CLI `action` wrapper as an `OmnyoHttpError` (`HTTP 500: <server message>`, with error-envelope code `http_500` from `apps/cli/src/action.ts:81`), instead of `/api/v1/plugins/<path> failed: HTTP 500` or a raw ZodError. The exit code is still 1. Treat this as an improvement, and do not test the old wording.
- An empty `<id>` now fails locally with a validation error instead of sending a request to a malformed path.

Non-goals:

- No server route changes. RF-063 owns the typed routes.
- No change to the `{ok:false,error}` JSON failure shape or exit codes. The sweep flagged ISS-S12-03 about that shape; it stays separate.
- No change to `logs --follow` polling.
- No new descriptor-schema leniency. If the owner wants skew tolerance, that is a separate decision (step 2) and should be applied once in the SDK, not re-copied into the CLI.

**Expected gain and cost**

Observed baseline: 61 physical / 56 non-blank lines of helper, schemas and types (ranges above), plus one `cliFetch` import.

Projected change:

- **Removed:** about 56–61 lines (the helper, three or four schemas, two types).
- **Added:** about 15 lines for `pluginResult` and its status set, and about 2–4 lines for the enable/disable wrapping and type narrowing.
- **Logs:** either a 12–15-line local reader, or an SDK method of about 12 lines plus a contract schema of about 5 lines.
- **Net:** about 25–35 handwritten production lines removed. Call-site lines stay roughly the same size.

Tests: about 40–80 added lines (step 4). Generated code and docs: none.

Mechanisms, before and after:

| Mechanism | Before | After |
|---|---|---|
| HTTP client paths for `/api/v1/plugins/*` in the CLI | 2 (`callPlugins` and the SDK) | 1, or 1 plus a logs-only local read under option B |
| Copies of the setting-descriptor shape on the client side | 2 (contract and CLI) | 1 |
| Places that know the {400,404,409,422} structured-failure rule | 1 (`callPlugins`) | 1 (`pluginResult`) |

Maintenance example: today, adding `experimental_foo` to a descriptor means editing the contract and the CLI schema copy, and the CLI copy can be forgotten silently. Afterwards only the contract changes (plus the plugin-SDK validator until RF-110 lands), and the CLI JSON output follows automatically.

Performance: neutral by inspection. The proxy dispatcher and the absence of a timeout are unchanged, and the request count is unchanged. Strict-schema parsing adds negligible CPU on a one-shot command. Not measured.

Incidental fix: the CLI's JSON output starts showing descriptor metadata. This is the behaviour change gated in step 2, not a hidden effect.

**Execution steps**

1. **Reconfirm the baseline.** In the checkout you will edit, check that `apps/cli/src/commands/plugin.ts` still has `callPlugins` and the nine call sites listed above (`rg -n "callPlugins" apps/cli/src/commands/plugin.ts`). Check that the SDK methods still exist at `packages/sdk/src/areas/plugins.ts` "createPluginsArea" and that the server routes still return `{ok:false,error}` with 400/404/409/422 (`apps/server/src/routes/plugins.ts` handlers listed above). Re-plan in any of these cases:
   - a route has started returning a different failure shape, or a success field the contract lacks;
   - the SDK methods throw for 2xx bodies the CLI currently accepts;
   - `apps/app/src/hooks/queries/plugin-settings-queries.ts` no longer uses the SDK for settings.
2. **Decision gate (owner).** Get an explicit answer to two questions before editing:
   - (a) Accept that `omnyo plugin config <id> --json` gains the contract descriptor fields (`experimental_section.description`, `experimental_multiline`, `experimental_placeholder`, `experimental_optionLabels`)? Recommended answer: yes. It is additive and matches what the server sends.
   - (b) Is CLI-to-server version skew a supported configuration for these commands? Recommended answer: no special handling, consistent with the rest of the `plugin` command group and the web app.

   If (a) is "no", stop. Keeping the narrowed JSON needs a projection that recreates the deleted schema, which defeats the change. If (b) is "yes", stop and re-plan around a deliberately lenient descriptor parse in the SDK, not in the CLI.
3. **Edits in `apps/cli/src/commands/plugin.ts`,** in order. These form one working checkpoint; run the CLI tests after each sub-step if convenient.
   - a. Add `pluginResult` (signature above) next to `sdkErrorMessage` (`:780`). Import the types `PluginSettingsResponse` and `PluginSettingDescriptor` from `@omnyo/server-contract`. The existing import block at `:23-30` already imports types from there.
   - b. **config** (`:2265` action). Create `const plugins = createCliOmnyoSdk(getUrl()).plugins;` once per action. Replace `pluginSettingsResultSchema.parse(await callPlugins(getUrl(), settingsPath, "GET"))` at `:2310` and `:2351` with `await pluginResult(plugins.getSettings({ pluginId: id }))`. Replace the PUT at `:2373` with `await pluginResult(plugins.updateSettings({ pluginId: id, values: { [key]: parsedValue } }))`. Delete `settingsPath`. At `:2355`, the `!current.ok || !current.schema` guard becomes `!current.ok`, since the success type always has `schema`. Change `printSettings` (`:788`) to take `PluginSettingsResponse`. Drop its `?? {}` defaults only if the types make them dead; otherwise keep them. Change `parseSettingValue` (`:833`) to take the contract `PluginSettingDescriptor`, and narrow on `descriptor.type === "select"` before reading `options`, in both `parseSettingValue` and the `meta` line of `printSettings`.
   - c. **token** (`:2388`). Use `await pluginResult(createCliOmnyoSdk(getUrl()).plugins.token({ pluginId: id, rotate: opts.rotate }))`. Keep `if (!result.ok) exitWithError(result); console.log(result.token);`.
   - d. **reload** (`:2041`), **dev-loop reload** (`:1992`), **enable/disable** (`:2093`) and **remove** (`:2484`): replace each `pluginMutationResponseSchema.parse(await callPlugins(...))` with the matching `pluginResult(sdk.plugins.*)` call described in the preservation section. For enable/disable, map the SDK's bare `plugin` to `{ ok: true as const, plugin }` before `pluginResult`. Keep the downstream logic byte-for-byte: the unknown-id rewrite, the snapshot note, `failedPlugin` and the `printPlugin` calls.
   - e. **logs** (`:2429`). Choose one:
     - (A, preferred if the owner wants the SDK to cover every plugin route) Add `pluginLogsResponseSchema = z.object({ ok: z.literal(true), lines: z.array(z.string()) })` to `packages/server-contract/src/api/plugins.ts`. Add `experimental_readLogs(input: PluginIdArgs & { tail: number; signal?: AbortSignal })` to `PluginsArea` and `createPluginsArea`, calling `pluginPath(input.pluginId, `/logs?tail=${input.tail}`)`. Use it through `pluginResult`. Follow the `experimental_` naming already used by `experimental_setSafeMode` and `experimental_pruneCache`, and check `packages/sdk/test/public-types.test.ts` for any public-surface listing that needs the new member.
     - (B, smallest) Keep `pluginLogsResultSchema` and replace the `callPlugins` call with a 10–15-line local `readPluginLogs(baseUrl, id, tail)` that uses `cliFetch` and returns the body on status 200 or 404 only.

     Option B keeps `cliFetch` imported, and the "one client path" claim then excludes logs. Record which option was taken.
   - f. Delete `callPlugins` (`:431-463`), `pluginSettingDescriptorSchema` (`:159-167`), `pluginSettingsResultSchema` (`:172-177`), `pluginTokenResultSchema` (`:179-183`), the local types (`:427-429`) and, under option A, `pluginLogsResultSchema` (`:185-189`) and the `cliFetch` import (`:47`). Keep `negativeNumberValuePattern`, `pluginPackageSummarySchema` and `secretSettingValueSchema`.
4. **Add the missing behavioural tests** before or alongside step 3. They pin today's semantics independently of the new code, so write them against the current code first and watch them pass. Place them in the existing `apps/cli/src/__tests__/command-output/` files, using their `vi.mocked(fetch)` style:
   - `plugin-config.test.ts`:
     - A 404 `NOT_RUNNING` body, as text (stderr message, exit 1) and as `--json` (exact `{"ok":false,"error":…}`, exit 1).
     - A 400 validation error on `set`, as JSON.
     - A secret setting printed as `[set]`/`[not set]`.
     - A `select` descriptor in text output (`options: a|b`).
   - `plugin-updates.test.ts` (reload): a 422 body `{ok:false,error,plugins:[…]}`. Text output must still print the plugin line and the error, with exit 1. JSON output must equal the parsed body.
   - `plugin-enable.test.ts`: a 404 unknown plugin in JSON.
   - A new `plugin-token.test.ts` (or a `describe` block in an existing file): success prints only the token. `--rotate` sends `rotate: true`. A 404 in JSON gives `{"ok":false,"error":"unknown plugin"}` and exit 1.
   - Add one test that `config --json` includes `experimental_optionLabels` (only after the gate (a) answer is "yes"; this test fails before the change and passes after).
5. **Clean up.** Remove now-unused imports. Check `rg -n "callPlugins|pluginSettingsResultSchema|pluginTokenResultSchema|pluginSettingDescriptorSchema" apps/cli` returns nothing. Under option A, also check `rg -n "pluginLogsResultSchema|cliFetch" apps/cli/src/commands/plugin.ts` returns nothing. Do not change `pluginMutationResponseSchema` in the SDK: it is a public export (`packages/sdk/src/node.ts:107`) and the adapter uses it.
6. **Verify and recount.** Run the commands below, then recount removed and added non-blank production lines with the same `grep -cv '^\s*$'` method. Inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

The commands below come from `apps/cli/package.json` (`test`: `vitest run`; `typecheck`: `tsc --noEmit`), `packages/sdk/package.json` (`test`, `typecheck`) and the root `package.json` (`lint`: `turbo run lint`; `format:check`). Exact file-filter invocations were not executed in this audit.

- From the repository root:
  `pnpm --filter @omnyo/cli exec vitest run src/__tests__/command-output/plugin-config.test.ts src/__tests__/command-output/plugin-enable.test.ts src/__tests__/command-output/plugin-remove.test.ts src/__tests__/command-output/plugin-updates.test.ts src/__tests__/plugin-dev-loop.test.ts`, plus the new token test file. Expect every test to pass. The new tests from step 4 must also pass against the pre-change code, except the single `experimental_optionLabels` test.
- `pnpm --filter @omnyo/cli typecheck`. Under option A, also run `pnpm --filter @omnyo/sdk typecheck`, `pnpm --filter @omnyo/sdk test` and `pnpm --filter @omnyo/server-contract typecheck`. `packages/server-contract/package.json` defines that `typecheck` script.
- Lint and format the changed files with the repository's tooling: `pnpm exec oxlint <files>` and `pnpm exec oxfmt --check <files>`, or the root `pnpm format:check` and `pnpm lint`.
- Behaviour and contract checks the tests must cover:
  - The request method, URL and body for each subcommand. The SDK `{}` body on reload/enable/disable and `rotate:false` on token are accepted differences.
  - Exact JSON for success and for each structured failure.
  - Exit code 1 on every failure.
  - Secret values never printed.
  - The reload 422 path printing plugins before the error.
  - The dev loop surfacing `result.error`.
- Manual smoke against a local server is optional, and needs a running Omnyo server. Run `omnyo plugin config <some-plugin-with-settings>` and `--json`, then `omnyo plugin token <id>`, `omnyo plugin reload <id>`, `omnyo plugin disable <id>` and `enable <id>`, and `omnyo plugin remove <core-plugin>` (expect the refusal and exit 1).
- UI: none affected. Performance: no measurement needed; the request count and transport are unchanged.
- Structural completion:
  - `callPlugins` and the three or four local schemas are gone.
  - Every plugin route call in `plugin.ts` goes through `createCliOmnyoSdk(...).plugins`, except logs under option B.
  - The structured-failure status set exists only in `pluginResult`.
  - The net non-blank production reduction is at least about 20 lines.

**Rollback and stop conditions**

- **Change boundary:** a single commit touching `apps/cli/src/commands/plugin.ts` and its tests. Under option A, it also touches `packages/sdk/src/areas/plugins.ts` and `packages/server-contract/src/api/plugins.ts`. Reverting that commit restores the old behaviour. There is no persisted data, migration or wire-format change on the server side.
- **Stop if** the owner rejects the additive JSON change, or requires version-skew tolerance (step 2).
- **Stop if** a supported server emits a settings body the strict contract rejects. That would also break the web app's settings panel, so file it as a contract defect rather than re-adding a lenient CLI copy.
- **Stop if** `pluginResult` needs per-command switches beyond the status set, for example because a route starts returning a non-`{ok:false}` structured body. In that case keep explicit per-command handling, or leave that one command on a local read.
- **Stop if** the step 4 characterization tests reveal behaviour the SDK path cannot reproduce without a second decoder.
- **Smaller safe alternative:** migrate only `config` (removing the drifted descriptor copy, which carries the real value) and leave the remaining routes on `callPlugins`. This keeps both client paths, so it captures the knowledge deduplication but not the helper deletion.
