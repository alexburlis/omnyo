# RF-139 — Declare the plugin mention trigger set (`@ # $ ! ~`) once, in `@omnyo/domain`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but there are four copies, not three, and the sweep's proposed home (plugin-sdk `backend-contract.ts`) is worse than the existing `@omnyo/domain` vocabulary pattern.
- **Potential:** low to medium. About 20-25 handwritten production lines go away. The material gain is that four independent declarations of one product vocabulary become one.
- **Confidence:** high. Every copy and consumer below was read at the snapshot.
- **Readiness:** ready. No owner decision is needed, because no supported behavior, wire format, error text or published SDK export changes.
- **Effort:** small, about 1-2 hours including checks.
- **Risk:** low. The main risks are a reordered value list, which would change trigger ordering and an error message, and a change to the bundled SDK declaration text for `PluginMentionTrigger`. Both are covered by the checks below.
- **Prerequisites:** none.
- **Related or overlapping items:** none directly. RF-003, which shares backend registration between the production plugin API and the SDK fake plugin host, touches `host-policy.ts` near `normalizeMentionProviderTriggers`. If both land, do RF-139 first or rebase it onto RF-003. The change is tiny either way.
- **Why it deserves its place:** it is a cheap, low-risk duplicate-knowledge fix. Today the web client silently drops any mention provider whose trigger it does not recognize, so a trigger added on the server alone would quietly disappear from the composer. It ranks low because the vocabulary rarely changes.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree was no longer on disk during verification, so every file was read with `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. No node_modules were available, so nothing was executed. All claims are **Proven by inspection** unless labelled otherwise.

Plugins register mention providers (`api.ui.mentions` style registrations) with optional `triggers`, which default to `["@"]`. The server validates the registration, serves `/api/v1/plugins/mentions/search?trigger=…`, and the web composer enables typeahead for each trigger that some provider uses. The vocabulary of valid triggers is `@ # $ ! ~`. It is declared in four places:

| # | Location | What it declares |
|---|---|---|
| 1 | `packages/plugin-sdk/src/backend-contract.ts:1991` `PluginMentionTrigger` | Public type, a literal union `"@" \| "#" \| "$" \| "!" \| "~"` |
| 2 | `packages/plugin-sdk/src/internal/host-policy.ts:562` `PLUGIN_MENTION_TRIGGER_VALUES` and `:574` `isPluginMentionTrigger` | Value array and an `includes` guard. `normalizeMentionProviderTriggers` (`:583`) throws descriptive errors and is called at `:3931` during registration |
| 3 | `packages/client-core/src/prompt/mentions/plugin-mention-triggers.ts:1-26` | A second copy of the type (`:1`), the value array (`:5`) and a `switch` guard (`:13`). It also holds `DEFAULT_PLUGIN_MENTION_TRIGGER` (`:3`) and the lenient `normalizePluginMentionTriggers` (`:28`), which returns `null` instead of throwing |
| 4 | `apps/server/src/routes/plugins.ts:205` `parsePluginMentionTrigger` | A `switch` over the same five characters for the search route's `trigger` query parameter (used at `:550`, error `invalid plugin mention trigger "…"` at `:556`). **The sweep missed this copy.** |

Consumers, found with `git grep -n "PLUGIN_MENTION_TRIGGER_VALUES\|isPluginMentionTrigger\|normalizePluginMentionTriggers\|DEFAULT_PLUGIN_MENTION_TRIGGER\|plugin-mention-triggers\|PluginMentionTrigger\b" <commit> -- ':!*.md'` over the whole repository:

- `packages/client-core/src/index.ts:41` re-exports the client-core module with `export *`. `packages/client-core/src/prompt/mentions/types.ts:11` imports the type for `TypeaheadTrigger` and `ActiveTrigger` (`:271`, `:276`).
- `apps/app/src/hooks/usePromptMentions.ts:24-27`: `buildPluginMentionTriggers` (`:92-107`) filters `PLUGIN_MENTION_TRIGGER_VALUES` and so **relies on the array's order** for trigger order.
- `apps/app/src/components/promptbox/mentions/prompt-mention-clipboard.ts:6` and `:96-103` (`isSerializedPluginMentionText`).
- `apps/app/src/hooks/queries/plugin-contribution-queries.ts:3-4` and `:28`: `toMentionProviderContribution` drops the whole provider when `normalizePluginMentionTriggers` returns `null`.
- `apps/app/src/components/promptbox/PromptBoxInternal.tsx:114-115`, `:862`, `:3845`, `:3960` use the type and the default only.
- The server uses only the type through `apps/server/src/services/plugins/plugin-api.ts:64` and `:161`, `plugin-service-internal.ts:32` and `plugin-service.ts:148`. No server file imports the host-policy value array or guard.
- `packages/plugin-sdk/src/testing/fake-plugin-host.ts:96` uses the type only.
- `packages/plugin-sdk/src/__tests__/public-types.test.ts:117` requires `PluginMentionTrigger` to stay a public SDK type name.
- Plugins pass literal arrays such as `plugins/github/server.ts:1902` and `:1914` (`triggers: ["@", "#"]`). Authoring docs list the valid set in `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/backend-ui-lifecycle.md:9`. The trigger literals are a stable wire vocabulary and do not change.
- A search for other hardcoded trigger sets (`git grep -nE '\[@#\\$|\["@", "#"|@#\$!~' <commit> -- apps packages plugins`, excluding tests) found only these plugin registrations and no regex copies. A search with no hits does not prove absence. The strongest remaining check is `pnpm typecheck` after the change, which flags any consumer of the removed declarations.

Why the sweep's proposed home is the wrong one (**Proven by inspection**):

- `@omnyo/client-core` lists `@omnyo/plugin-sdk` only in `devDependencies` (`packages/client-core/package.json:46`), and its `src` has no runtime import of it. Its only use is `packages/client-core/test/thread-activity.test.ts:1`. A runtime import would make every client-core consumer resolve the SDK's root barrel, and the mobile app (`apps/mobile/package.json`) does not depend on `@omnyo/plugin-sdk` at all. Metro does not tree-shake by default (**Hypothesis** for this Expo configuration), so mobile could bundle the whole SDK root to get one array.
- `@omnyo/domain` already owns vocabularies of exactly this shape for both sides. `packages/domain/src/provider-fork.ts` exports `PROVIDER_FORK_VALUES` and derives `ProviderFork`. `backend-contract.ts:26` imports that type, and `host-policy.ts:16` imports the values. The SDK inlines workspace packages into its published `dist` and `bundled-types` (`packages/plugin-sdk/scripts/build-bundled-dts.mjs:170-181` uses `inlineWorkspace` with `respectExternal: false`, and `@omnyo/domain` is only a devDependency of the SDK). `client-core`, `server` and `mobile` already depend on `@omnyo/domain`.

Line counts at the snapshot, from `git show <commit>:<path> | wc -l` and `sed -n` ranges: the client-core file is 50 lines, not 48; host-policy has 15 duplicate lines (`562-568` and `574-581`); the server route parser is 18 lines (`205-222`).

The maintenance cost today is that adding or renaming a trigger needs four synchronized edits. If the client copy lags, the composer silently drops the provider through `toMentionProviderContribution`. If the route copy lags, the search route answers 400 for a trigger the registration accepted.

**Proposed end state and preservation argument**

One new module, `packages/domain/src/plugin-mention-triggers.ts`, is the only declaration:

```ts
export const PLUGIN_MENTION_TRIGGER_VALUES = ["@", "#", "$", "!", "~"] as const;
export type PluginMentionTrigger = (typeof PLUGIN_MENTION_TRIGGER_VALUES)[number];
export const DEFAULT_PLUGIN_MENTION_TRIGGER: PluginMentionTrigger = "@";
export function isPluginMentionTrigger(value: unknown): value is PluginMentionTrigger {
  return typeof value === "string" &&
    (PLUGIN_MENTION_TRIGGER_VALUES as readonly string[]).includes(value);
}
```

The new module is exposed as the subpath `@omnyo/domain/plugin-mention-triggers`, following the `./provider-fork` entry in `packages/domain/package.json:68-71`.

What remains and who owns it:

- **SDK public type:** `backend-contract.ts` keeps exporting `PluginMentionTrigger` as a re-export of the domain type, in the same way it consumes `ProviderFork`. The structural type is identical, so plugin authors see no change, and no SDK runtime export is added. Therefore there is no SDK minimum-version bump under `docs/forkable-plugins.md`.
- **Strict server validation:** `normalizeMentionProviderTriggers` stays in host-policy, byte-for-byte the same in behavior and error text. It imports the guard and the values from domain. Host-policy keeps `export { PLUGIN_MENTION_TRIGGER_VALUES, isPluginMentionTrigger }` as a one-line re-export. Those names ship on the published `./internal/host-policy` subpath, and no in-repo consumer imports them from there. Keeping the re-export costs one line and avoids reasoning about outside consumers of an internal entry.
- **Lenient client normalization:** `normalizePluginMentionTriggers` stays in client-core, unchanged, returning `null` for unknown or duplicate triggers. The client-core module re-exports `PLUGIN_MENTION_TRIGGER_VALUES`, `DEFAULT_PLUGIN_MENTION_TRIGGER`, `isPluginMentionTrigger` and `PluginMentionTrigger` from domain, so `apps/app` imports from `@omnyo/client-core` stay valid and untouched.
- **Search route:** `parsePluginMentionTrigger` becomes `value === undefined ? DEFAULT_PLUGIN_MENTION_TRIGGER : isPluginMentionTrigger(value) ? value : null`, keeping the `"@"` default, the `null` result and the 400 error text at `:556`.

Preserved semantics:

- The value order `@ # $ ! ~` is unchanged. It drives `buildPluginMentionTriggers` ordering and the host-policy error text `use one of @ # $ ! ~`.
- The default `"@"` is unchanged in all three places: host-policy's `DEFAULT_PLUGIN_MENTION_TRIGGERS`, the client normalizer and the route.
- The `switch` guards become an `includes` guard. Both accept exactly the five strings and reject everything else, including non-strings.
- No UI, wire, persisted or performance change is expected. The guard runs a handful of times per registration, request or contribution fetch.

Non-goals:

- Do not merge the strict server normalizer with the lenient client one. They intentionally differ: the server throws descriptive errors and the client returns `null`.
- Do not change how older mobile or web clients treat unknown future triggers. They will still drop such providers, which is a compatibility property of shipped clients that this refactor does not touch.
- Do not touch plugin literals or authoring docs.

**Expected gain and cost**

These are projections from the snapshot line counts, not measurements:

- **Removed:** the client-core type, values and `switch` guard (about 22 lines), the host-policy values and guard (15 lines), the route `switch` (about 8 of its 18 lines) and the backend-contract union body (a 1-line swap). That totals about 45 lines.
- **Added:** the domain module (about 10 lines), its `package.json` exports entry (5 lines), and import or re-export lines in client-core, host-policy, backend-contract and the route (about 8 lines).
- **Net:** about 20-25 fewer handwritten production lines. There are no test, generated or doc line changes, apart from regenerated bundled SDK types when the SDK is next built.
- **Mechanisms:** four declarations of the trigger vocabulary become one, and three guard implementations become one.
- **Causal benefit:** a new trigger becomes a one-line edit that the server registration, the search route and the web composer all pick up together.
- **Tradeoff:** one more domain subpath to maintain. The `PluginMentionTrigger` text in the bundled SDK `.d.ts` changes form from a literal union to a derived type, with an equivalent structure.

**Execution steps**

1. **Reconfirm the baseline.** Check that the four anchors in the Context table still exist with the same contents (`rg -n "PLUGIN_MENTION_TRIGGER_VALUES|isPluginMentionTrigger|parsePluginMentionTrigger|type PluginMentionTrigger" packages apps`). Check that `@omnyo/domain` is still a devDependency of `packages/plugin-sdk/package.json` and that `build-bundled-dts.mjs` still inlines workspace packages. Stop and re-plan if any of these hold:
   - The trigger set differs between copies. That would be a behavior difference to resolve first; report it as a bug, not as part of this refactor.
   - The SDK stops inlining `@omnyo/domain`.
   - A new consumer imports the host-policy values from outside the repository.
2. **Add the domain module.** Create `packages/domain/src/plugin-mention-triggers.ts` with the four exports shown above, keeping the order `@ # $ ! ~`. Add a `"./plugin-mention-triggers"` entry to `packages/domain/package.json` `exports` shaped like the `./provider-fork` entry (`source`, `types`, `default` all pointing to `./src/plugin-mention-triggers.ts`). Do not add it to the domain root barrel unless that barrel already re-exports `provider-fork`; follow whatever `provider-fork` does.
3. **Re-point the SDK type.** In `packages/plugin-sdk/src/backend-contract.ts`, replace the line `export type PluginMentionTrigger = "@" | "#" | "$" | "!" | "~";` with `export type { PluginMentionTrigger } from "@omnyo/domain/plugin-mention-triggers";`. Keep the type name exported from the SDK root (`public-types.test.ts:117`).
4. **Re-point host-policy.**
   - In `packages/plugin-sdk/src/internal/host-policy.ts`, delete lines `562-568` (`PLUGIN_MENTION_TRIGGER_VALUES`) and `574-581` (`isPluginMentionTrigger`).
   - Import both from `@omnyo/domain/plugin-mention-triggers` and add `export { PLUGIN_MENTION_TRIGGER_VALUES, isPluginMentionTrigger } from "@omnyo/domain/plugin-mention-triggers";` so the published internal subpath keeps those names.
   - Keep `DEFAULT_PLUGIN_MENTION_TRIGGERS` (`:570`) and `normalizeMentionProviderTriggers` (`:583-624`) unchanged.
   - The `PluginMentionTrigger` type import from `../backend-contract.js` (`:52`) can stay.
5. **Re-point client-core.** In `packages/client-core/src/prompt/mentions/plugin-mention-triggers.ts`:
   - Delete lines `1-26`, which hold the type, the default, the values and the `switch` guard.
   - Replace them with `import { DEFAULT_PLUGIN_MENTION_TRIGGER, isPluginMentionTrigger, type PluginMentionTrigger } from "@omnyo/domain/plugin-mention-triggers";` and `export { DEFAULT_PLUGIN_MENTION_TRIGGER, PLUGIN_MENTION_TRIGGER_VALUES, isPluginMentionTrigger, type PluginMentionTrigger } from "@omnyo/domain/plugin-mention-triggers";`.
   - Keep `normalizePluginMentionTriggers` unchanged. `types.ts:11` keeps importing the type from `./plugin-mention-triggers.js`.
   - No `package.json` change is needed: client-core already depends on `@omnyo/domain`. Leave `@omnyo/plugin-sdk` in devDependencies. Contrary to the sweep, it does not move.
6. **Re-point the search route.** In `apps/server/src/routes/plugins.ts`, rewrite `parsePluginMentionTrigger` (`:205-222`) to use `DEFAULT_PLUGIN_MENTION_TRIGGER` and `isPluginMentionTrigger` imported from `@omnyo/domain/plugin-mention-triggers`. Keep its signature `(value: string | undefined) => PluginMentionTrigger | null` and leave the caller at `:550-560` unchanged.
7. **Checkpoint.** Run the typecheck and focused tests listed below. Then run `rg -n '"@" \| "#"|case "~"' packages/client-core/src packages/plugin-sdk/src apps/server/src` and confirm it finds no remaining copy. Format the changed files with the repository formatter (`pnpm exec oxfmt <files>` from the repo root, as `"format": "oxfmt ."` implies) and lint them.
8. **Review the diff.** Confirm the diff contains only these six files: the new domain module, `packages/domain/package.json`, `backend-contract.ts`, `host-policy.ts`, the client-core mention-trigger file and `apps/server/src/routes/plugins.ts`. Recount the net production lines against the baseline in "Expected gain and cost".

**Verification and acceptance criteria**

Run all commands from `$OMNYO_CHECKOUT` or the implementing worktree root after `pnpm install`. The script names come from the package manifests at the snapshot. The single-file vitest invocations are the standard vitest CLI form and were not executed here.

- Types: `pnpm --filter @omnyo/domain typecheck`, `pnpm --filter @omnyo/plugin-sdk typecheck`, `pnpm --filter @omnyo/client-core typecheck`, `pnpm --filter @omnyo/server typecheck`, `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/mobile typecheck` (mobile consumes the client-core barrel). Expect zero errors.
- Server registration and route contract: `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/services/plugins/plugin-mention-providers.test.ts`. The test must pass unchanged. It covers trigger filtering (`:278`), the route's 400 error `invalid plugin mention trigger "?"` (`:309-317`) and the registration error `mention provider "bad" trigger "?" is invalid` (`:679-693`).
- SDK: `pnpm --filter @omnyo/plugin-sdk exec vitest run --config vitest.config.ts src/__tests__/public-types.test.ts src/testing/__tests__/fake-plugin-host.test.ts`, which must pass unchanged.
- Web composer: `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/hooks/usePromptMentions.test.tsx src/hooks/usePromptMentions.coverage.test.tsx src/hooks/queries/plugin-contribution-queries.test.tsx src/components/promptbox/mentions/prompt-mention-clipboard.test.ts`, which must pass unchanged. These cover trigger ordering (`usePromptMentions.test.tsx:97` expects `["@", "#"]`) and provider normalization.
- Bundled SDK types (**unverified locally**, because it needs a build): run `pnpm --filter @omnyo/plugin-sdk build:types`. Then confirm that `bundled-types/omnyo-plugin-sdk.d.ts` still exports `PluginMentionTrigger` and that it resolves to the five literals with no import of `@omnyo/domain` left in the file. A leftover import would break external plugins.
- Lint and format: `pnpm exec oxfmt --check <changed files>` and `pnpm lint`, or the package's `lint` script where one exists.
- Structural completion: `rg -n 'PLUGIN_MENTION_TRIGGER_VALUES = \[' packages apps` returns exactly one hit, in `packages/domain/src/plugin-mention-triggers.ts`. No `switch` over trigger characters remains.
- UI: there is no visual change, so no screenshot round is needed. Typeahead behavior is covered by the composer tests above.
- Performance: neutral by construction, because it is the same `O(5)` membership test. No benchmark is required.

**Rollback and stop conditions**

- **Rollback:** the change is one self-contained commit across six files with no data, wire or persisted-format effect. Reverting that commit restores the previous state exactly.
- **Stop: bundled types.** Stop if the bundled SDK declaration keeps an unresolved `@omnyo/domain/plugin-mention-triggers` import. Investigate the `inlineWorkspace` resolver first. The safe fallback is to keep the literal union in `backend-contract.ts` and add `satisfies readonly PluginMentionTrigger[]` on the domain array. That still removes the client-core, host-policy and route copies.
- **Stop: Metro.** Stop if mobile's Metro resolver (`apps/mobile/metro.config.js`) fails to resolve the new domain subpath. Check how it resolves `@omnyo/domain/provider-fork`; mobile already uses domain subpaths through the same workspace resolver.
- **Stop: behavior change.** Stop if any listed test needs a changed expectation, because that means behavior changed. Restore the original order or default instead of updating the test.
- **Stop: outside consumer.** Stop if an outside consumer of `@omnyo/plugin-sdk/internal/host-policy` that relies on these names surfaces. The plan already keeps the re-export, so this only matters if someone proposes dropping it.
