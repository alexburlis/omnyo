# RF-111 — Give the relay base-URL policy (default, development override and allowed origins) one owner in `@omnyo/connect-client`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exactly as the sweep described it. This card corrects the plan in three places: `normalizeOrigin` and the `BaseUrlAllowed` type stay in Omnyo Account, because no other package uses them; the shared module must not use the `NodeJS.ProcessEnv` type, because mobile type-checks `@omnyo/connect-client` source; and a third importer of the Account copy was missing (`plugins/connect/src/account-integration.test.ts:6`).
- **Potential:** low. About 35-44 production lines go away. The real value is that the rules deciding which relay origin may receive account and machine credentials get one definition, after seven edits to this rule changed both copies in lockstep.
- **Confidence:** high. The two copies differ only in identifier names (Proven by inspection with `diff`).
- **Readiness:** ready. No owner decision is needed, because no behavior changes.
- **Effort:** small, about 1-2 hours including tests in three packages.
- **Risk:** low. Pure functions move. The regression to guard against is a relay origin that is accepted or rejected wrongly in a development build, and changed error text that tests assert on.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-061 (move the Omnyo Account sign-in poll and pairing-code helpers into `@omnyo/connect-client`) and RF-135 (build Connect share origins in `connect-client`) also add exports to `packages/connect-client/src/index.ts`. Whichever lands second rebases onto that edit. There is no ordering dependency and no shared line count.
- **Why it has this place:** it is a cheap, safe removal of duplicated security-relevant policy with a proven co-change history, but it is small. It belongs below every item that removes a subsystem.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The dedicated snapshot worktree had been removed by the time of verification, so files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c:<path>` and searched with `git grep <pattern> e9e1b74c -- <paths>`. `git diff --stat e9e1b74c 5f2d3f895 -- plugins/connect/src plugins/omnyo-account/src packages/connect-client` printed nothing, so local `main` matched the snapshot for these paths on 2026-11-26. No tests were run, because the snapshot has no `node_modules`.

*How the pieces relate (Proven by inspection).* Omnyo Account (`plugins/omnyo-account`) signs this Omnyo in to an omnyo.link account and holds the server credential. Connect (`plugins/connect`) provides remote access through the relay. Both decide which relay origin to use when nothing else is configured: production builds always use `https://omnyo.link`; a build with `NODE_ENV=development` may point at `OMNYO_DEV_CONNECT_BASE_URL`, which must be `https://stg.omnyo.link` or a bare `http://omnyo.localhost:<port>` origin. The development launcher sets that variable (`packages/config/src/runtime.ts:376`, `packages/scripts/src/commands/run-dev.ts:26` `STAGING_CLOUD_URL` and `:109`).

*The two copies (Proven by inspection).*

| Rule | Connect | Omnyo Account |
|---|---|---|
| Production origin | `plugins/connect/src/base-url.ts:1` `DEFAULT_CONNECT_BASE_URL` | `plugins/omnyo-account/src/base-url.ts:1` `DEFAULT_BASE_URL` |
| Staging origin, error text | `:3` `STAGING_BASE_URL`, `:5-6` `DEV_BASE_URL_ERROR` | same lines, same text |
| Development override | `:8-44` `resolveDefaultConnectBaseUrl(env)` | `:8-44` `resolveDefaultBaseUrl(env)` |
| Allowed override origins | none | `:46` `BaseUrlAllowed`, `:48-62` `isAllowedBaseUrl(origin, env)` |
| Origin normalizer | none | `:64-82` `normalizeOrigin(value, label)` |

`diff plugins/connect/src/base-url.ts plugins/omnyo-account/src/base-url.ts` shows only the two renames (lines 1, 8 and 12) plus Account's extra lines 45-82. Line counts: `wc -l` gives 44 and 82; `grep -cv '^\s*$'` gives 34 and 63 non-blank lines.

*Consumers.* Search: `git grep -n -E "base-url|resolveDefaultConnectBaseUrl|resolveDefaultBaseUrl|DEFAULT_CONNECT_BASE_URL|DEFAULT_BASE_URL|isAllowedBaseUrl|normalizeOrigin|BaseUrlAllowed|STAGING_BASE_URL|OMNYO_DEV_CONNECT_BASE_URL|stg\.omnyo\.link|omnyo\.localhost" e9e1b74c -- . ':!*.md'`, plus the same symbol names over `*.md`, `*.json`, `*.mjs` and `*.yml` (no hits in those).

- Connect production: `plugins/connect/src/plugin.ts:4` and `:87` pass `resolveDefaultConnectBaseUrl(process.env)` as `defaultBaseUrl` to `ConnectTunnel`. Its only use is the signed-out dashboard link, `plugins/connect/src/tunnel.ts:249-253` `dashboardUrl()`.
- Connect tests: `plugins/connect/src/connect.test.ts:26-29` (import), `:100-146` (`describe("resolveDefaultConnectBaseUrl")`), `:914`, `:981`; `plugins/connect/src/tunnel-lifecycle.test.ts:57`, `:101`; and `plugins/connect/src/account-integration.test.ts:6` and `:464`, which import `isAllowedBaseUrl` from the sibling path `omnyo-plugin-omnyo-account/src/base-url` (allowed because `omnyo-plugin-omnyo-account` is a Connect devDependency).
- Omnyo Account production: `plugins/omnyo-account/src/plugin.ts:4-8`, `:29`, `:35` (`isAllowedBaseUrl` default for `allowedBaseUrl`) and `:40` (`resolveDefaultBaseUrl`); `plugins/omnyo-account/src/rpc.ts:3`, `:18-37` `BaseUrlPolicy` and `resolveBaseUrl`; `plugins/omnyo-account/src/account.ts:7`, `:321` (`normalizeOrigin`).
- Omnyo Account tests: `plugins/omnyo-account/src/account.test.ts:6` (import), `:133-172` (`describe("base URL")`), `:1170-1196` (the `isAllowedBaseUrl` case); `plugins/omnyo-account/src/relay-rebind.test.ts:313` builds its own `BaseUrlPolicy`.

*Shared home (Proven by inspection).* `@omnyo/connect-client` (`packages/connect-client/package.json`) is private, has `"sideEffects": false`, depends only on `zod`, and already owns relay URL helpers (`packages/connect-client/src/urls.ts` `deriveConnectBaseUrl`, `serverUrlForHandle`; `packages/connect-client/src/relay-migration.ts`). Both plugins already depend on it (`plugins/connect/package.json` and `plugins/omnyo-account/package.json`, `"@omnyo/connect-client": "workspace:*"`) and import it from server code (for example `plugins/connect/src/machine-code.ts:2` and `plugins/omnyo-account/src/account.ts:5`). Neither plugin is listed in `scripts/forkable-plugins.json`, so a workspace dependency does not break the forkable-plugin rule in `docs/forkable-plugins.md`. Other consumers of the package are `apps/mobile`, `apps/desktop`, `apps/relay` and `apps/host-daemon`; they import package source directly (`exports["."].source` is `./src/index.ts`), so mobile's `tsc` will see the new module.

*Co-change history (Proven by inspection).* The public history has one squashed commit (`060950255` "Publish Omnyo source"). In the retired private repository `$ARCHIVED_OMNYO_CHECKOUT`, every commit that touched Connect's copy also touched the Account copy (then `plugins/bb-account/src/base-url.ts`): `f706e54f97`, `9bfe862b35`, `f9e0b51a66`, `86c0d9e3fe`, `53ed71ff8e`, `3a0ea73830` and `c92f4c2e5e` (7 of 7). The last two moved the relay host.

*Maintenance cost today.* A change to the production, staging or local relay origin, or to the development error text, needs two identical edits. If only Account's copy changes, Connect's signed-out dashboard link points at a relay that Account refuses or never uses.

*Counterevidence considered.* `apps/mobile/src/lib/profiles/supported-relay.ts:6` has a different, mobile-specific policy (it accepts relay subdomains and differs on localhost) and stays separate. `packages/scripts/src/commands/run-dev.ts:26` `STAGING_CLOUD_URL` is the producer of the environment value in development tooling, not a consumer policy, and stays separate. `plugins/connect/src/kv-secret.ts` and `plugins/omnyo-account/src/kv-secret.ts` are byte-identical but are plugin-storage helpers, not relay knowledge; they are out of scope here.

**Proposed end state and preservation argument**

*What disappears.* `plugins/connect/src/base-url.ts` is deleted. `DEFAULT_BASE_URL`, `STAGING_BASE_URL`, `DEV_BASE_URL_ERROR`, `resolveDefaultBaseUrl` and `isAllowedBaseUrl` leave `plugins/omnyo-account/src/base-url.ts`. One of the two duplicated resolver test blocks disappears.

*What remains and who owns it.* A new module `packages/connect-client/src/relay-base-url.ts` owns the relay-origin policy:

```ts
export type RelayBaseUrlEnv = Readonly<Record<string, string | undefined>>;
export const DEFAULT_RELAY_BASE_URL = "https://omnyo.link";
const STAGING_RELAY_BASE_URL = "https://stg.omnyo.link";
const DEV_BASE_URL_ERROR =
  "OMNYO_DEV_CONNECT_BASE_URL must be an http://omnyo.localhost:<port> origin or https://stg.omnyo.link";
export function resolveDefaultRelayBaseUrl(env: RelayBaseUrlEnv): string; // body of resolveDefaultBaseUrl, verbatim
export function isAllowedRelayBaseUrl(origin: string, env: RelayBaseUrlEnv): boolean; // body of isAllowedBaseUrl, verbatim
```

`RelayBaseUrlEnv` replaces `NodeJS.ProcessEnv` so the module type-checks in `apps/mobile`, whose types may not include Node (Hypothesis: not confirmed against `apps/mobile/tsconfig.json`; the plain record type avoids the question). `process.env` is still assignable to it, so callers keep passing `process.env`.

`plugins/omnyo-account/src/base-url.ts` keeps only `BaseUrlAllowed` and `normalizeOrigin`. They are Account's input validation and injection type, not shared relay knowledge, and only Account uses them. Moving them would add exports to `connect-client` without removing a duplicate.

*Data flow after the change.* Connect `plugin.ts` calls `resolveDefaultRelayBaseUrl(process.env)` for the dashboard link. Account `plugin.ts` calls `resolveDefaultRelayBaseUrl(process.env)` for `BaseUrlPolicy.defaultBaseUrl` and `isAllowedRelayBaseUrl(origin, process.env)` for `allowedBaseUrl`. `rpc.ts` `resolveBaseUrl` is unchanged.

*Why semantics survive.* The function bodies move verbatim; only names and the parameter type change. The error text stays byte-identical, and the existing assertions (`connect.test.ts:142`, `account.test.ts:169`) keep pinning it. The intentional asymmetry stays: a production build may *sign in to* `https://stg.omnyo.link` through `--base-url` (`isAllowedRelayBaseUrl`), but only a development build *defaults to* staging (`resolveDefaultRelayBaseUrl`). Because `connect-client` declares `"sideEffects": false` and the module uses only the `URL` global, the mobile, desktop and relay bundles do not grow unless they import the new symbols.

*Non-goals.* Do not change the CLI option descriptions (`plugins/connect/src/cli.ts:216`, `plugins/omnyo-account/src/cli.ts:211`) or the refusal message (`plugins/omnyo-account/src/rpc.ts:32`). They restate the allowed set in prose, and tests assert the substring `"https://omnyo.link or https://stg.omnyo.link"` (`account.test.ts:1213`, `:1217`; `account-integration.test.ts:477`). Do not touch mobile's `supported-relay.ts`, `run-dev.ts`, or the `kv-secret.ts` twins.

**Expected gain and cost**

- *Production lines (projection from the snapshot counts):* remove 44 lines (34 non-blank) for Connect's file and about 38 lines from Account's file; add about 44 lines in `relay-base-url.ts` and about 5 export lines in `index.ts`. Net: about −33 to −44 physical lines, about −30 non-blank. The 38 lines that move from Account are moved, not deleted.
- *Tests:* `connect.test.ts:100-146` (47 lines) and `account.test.ts:133-172` (40 lines) test the same resolver. Merge their inputs into one `packages/connect-client/test/relay-base-url.test.ts` together with the `isAllowedBaseUrl` case from `account.test.ts:1170-1196` (about 70 lines). Net tests: about −40 lines.
- *Mechanisms:* before, two copies of the default and development-override rule plus a third place (Account) for the allowed set; after, one owner for all three rules.
- *Maintenance example:* the relay host moves in `3a0ea73830` and `c92f4c2e5e` each needed matching edits in both plugins. After this change they need one edit in `relay-base-url.ts` plus the prose strings listed under non-goals.
- *Performance:* neutral. The same functions run at plugin start.
- *Cost:* one new export block in a package with four other consumers.

**Execution steps**

1. Reconfirm the baseline from `$OMNYO_CHECKOUT`: `git diff --stat e9e1b74c HEAD -- plugins/connect/src plugins/omnyo-account/src packages/connect-client`. Then `diff plugins/connect/src/base-url.ts plugins/omnyo-account/src/base-url.ts` must still show only the two renames plus Account's lines 45-82. If the two resolvers have diverged, stop and decide which behavior is intended before merging. Re-run the consumer search from *Context* and add any new importer to steps 4-6.
2. Create `packages/connect-client/src/relay-base-url.ts` with the signatures above. Copy the bodies of `resolveDefaultBaseUrl` (`plugins/omnyo-account/src/base-url.ts:8-44`) and `isAllowedBaseUrl` (`:48-62`) verbatim, replacing `DEFAULT_BASE_URL` and `STAGING_BASE_URL` with the new constant names and `NodeJS.ProcessEnv` with `RelayBaseUrlEnv`.
3. In `packages/connect-client/src/index.ts`, add an export block after the `urls.js` block: `DEFAULT_RELAY_BASE_URL`, `isAllowedRelayBaseUrl`, `resolveDefaultRelayBaseUrl`, `type RelayBaseUrlEnv` from `./relay-base-url.js`. Add `packages/connect-client/test/relay-base-url.test.ts` holding the union of the inputs from `connect.test.ts:100-146` and `account.test.ts:133-172` (keep every distinct accepted and rejected value from both lists, and assert the full error text at least once) and the `isAllowedBaseUrl` case from `account.test.ts:1170-1196`. Checkpoint: `pnpm --filter @omnyo/connect-client test` and `pnpm --filter @omnyo/connect-client typecheck` pass.
4. Connect: delete `plugins/connect/src/base-url.ts`. In `plugins/connect/src/plugin.ts:4`, import `resolveDefaultRelayBaseUrl` from `@omnyo/connect-client` and use it at `:87`. In `plugins/connect/src/connect.test.ts`, delete the `describe("resolveDefaultConnectBaseUrl")` block (`:100-146`), change the import at `:26-29` to `DEFAULT_RELAY_BASE_URL` from `@omnyo/connect-client`, and rename the uses at `:914` and `:981`. Do the same in `plugins/connect/src/tunnel-lifecycle.test.ts:57` and `:101`. In `plugins/connect/src/account-integration.test.ts:6`, import `isAllowedRelayBaseUrl` from `@omnyo/connect-client` and use it at `:464`. Checkpoint: `pnpm --filter omnyo-plugin-connect test` and `typecheck` pass.
5. Omnyo Account: in `plugins/omnyo-account/src/base-url.ts`, delete lines 1-44 and `isAllowedBaseUrl` (`:48-62`), keeping `BaseUrlAllowed` and `normalizeOrigin`. In `plugins/omnyo-account/src/plugin.ts:4-8`, import `isAllowedRelayBaseUrl` and `resolveDefaultRelayBaseUrl` from `@omnyo/connect-client` and keep `type BaseUrlAllowed` from `./base-url.js`; update `:35` and `:40`. `rpc.ts` and `account.ts` need no change. In `plugins/omnyo-account/src/account.test.ts`, delete `describe("base URL")` (`:133-172`) and the `isAllowedBaseUrl` case (`:1170-1196`), keep the integration case that starts at `:1198`, and remove the now-unused import at `:6`. Checkpoint: `pnpm --filter omnyo-plugin-omnyo-account test` and `typecheck` pass.
6. Run `pnpm --filter @omnyo/mobile typecheck` to confirm that the new module type-checks under mobile's settings. Then search for leftovers: `rg -n "resolveDefaultConnectBaseUrl|resolveDefaultBaseUrl|DEFAULT_CONNECT_BASE_URL|\bDEFAULT_BASE_URL\b|isAllowedBaseUrl|connect/src/base-url" apps packages plugins` must return nothing.
7. Format and lint the changed files: `pnpm exec oxfmt <files>` and `pnpm exec oxlint --deny-warnings <files>` from the repository root (configuration: `.oxfmtrc.json`, `.oxlintrc.json`). Review the full diff for unrelated edits, and recount lines against the step 1 baseline.

**Verification and acceptance criteria**

All commands run from `$OMNYO_CHECKOUT` after `pnpm install`. The package names come from each `package.json` at the snapshot (`@omnyo/connect-client`, `omnyo-plugin-connect`, `omnyo-plugin-omnyo-account`, `@omnyo/mobile`), and each defines `test` (`vitest run --config vitest.config.ts`, except mobile) and `typecheck` (`tsc --noEmit`). The commands themselves were not run during this audit.

- `pnpm --filter @omnyo/connect-client test` and `typecheck`: the merged resolver and allowed-origin tests pass, including the full error-text assertion and every rejected value from both old lists (for example `https://stg.omnyo.link.evil.test`, `http://omnyo.localhost` without a port, `https://sawyer.omnyo.link`, `http://127.0.0.1:59329`).
- `pnpm --filter omnyo-plugin-connect test` and `typecheck`: pass, especially `connect.test.ts:1627-1630` (the dashboard link follows `OMNYO_DEV_CONNECT_BASE_URL` in development) and `account-integration.test.ts:455-485` (an outside `--server` is refused before any request).
- `pnpm --filter omnyo-plugin-omnyo-account test` and `typecheck`: pass, especially `account.test.ts:1198-1220` (refusal message and no request for an outside origin).
- `pnpm --filter @omnyo/mobile typecheck`: passes.
- Structural completion: the `rg` search in step 6 returns nothing; `plugins/connect/src/base-url.ts` no longer exists; the only definitions of `https://stg.omnyo.link` as an allowed relay origin for the plugins are in `packages/connect-client/src/relay-base-url.ts` (the prose strings under non-goals excepted).
- No UI changes. The only user-visible text involved is the development error message and the CLI hints, which must be byte-identical.

**Rollback and stop conditions**

The change is one self-contained commit with no persisted data, migration or wire-format change; reverting the commit restores both copies. Stop and re-plan if:

- step 1 shows the two resolvers have diverged, which means the two plugins now need different policies and should stay separate;
- `apps/mobile`, `apps/desktop` or `apps/relay` fail to type-check or build because of the new module (then keep the module but import it by a subpath, or keep the plugin-local copies);
- either plugin is added to `scripts/forkable-plugins.json` before this lands, because a forkable plugin may not depend on a private workspace package; the shared code would then need to go through the plugin SDK instead.
