# RF-095 — One hook owns the thread-provider lookup that thread detail and plugin thread chats both copy

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The provider-context half of the sweep finding is real and byte-identical. The mention-link half is not worth a shared helper, so this card covers only the provider-context hook. It records the mention-link part as rejected, with the reason, under "Non-goals".
- **Potential:** low. About 8 to 15 handwritten production lines disappear. The main gain is one owner for the "which provider record does this thread use" rule, not the line count.
- **Confidence:** high. The two 22-line blocks are byte-identical (Reproduced with `cmp`), and both feed the same React context.
- **Readiness:** ready.
- **Effort:** small, one to two hours including focused tests.
- **Risk:** low. The change is a mechanical hook extraction with the same inputs, the same query and the same memo dependencies. The only subtlety is that thread detail also reads the provider's capabilities from the same lookup, so the hook must return the provider info as well as the context value.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none overlap. RF-013 and RF-021 also share code between root compose and thread detail, but they touch the secondary panel, not the provider context or mention links. RF-139 (plugin mention trigger vocabulary) concerns mention triggers in plugins, not link resolution.
- **Why it deserves its place:** plugin chats must render provider-specific timeline rows exactly as thread detail does, and a dedicated test (`PluginThreadChat.provider-context.test.tsx`) already guards that parity. Today the parity depends on two hand-kept copies of the lookup. It ranks low because the saving is small and the copies rarely change.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The working tree at `$OMNYO_CHECKOUT` had no changes to the five files below between that commit and `5f2d3f895` (checked with `git diff --stat`).

*What the subsystem does.* Timeline rows that a provider plugin renders (tool rows, for example) need to know which provider and which provider plugin own the thread. `apps/app/src/components/thread/thread-provider-context.tsx` defines `ThreadProviderContext` (value `{ providerId, pluginId }`) and `useThreadProvider()`. Its consumers are `apps/app/src/components/thread/timeline/PluginTimelineRendererBody.tsx:45` `usePluginTimelineRenderer`, which picks the tool renderer by `providerPluginId`, and `:104` `PluginTimelineRendererBody`, which passes `thread.providerId` to plugin renderers. The context is provided in exactly two production places (search: `git grep -n "ThreadProviderContext" e9e1b74c -- apps packages plugins`, excluding tests):

1. `apps/app/src/views/thread-detail/ThreadDetailView.tsx:3725`, the thread detail view.
2. `apps/app/src/components/plugin/PluginThreadChat.tsx:234` and `:247`, the host implementation of the plugin SDK `ThreadChat` component that plugins embed in their pages.

*Observed duplication (Proven by inspection, Reproduced with `cmp`).* `PluginThreadChat.tsx:88-109` in `PluginThreadChatBody` and `ThreadDetailView.tsx:1247-1268` in the thread detail component are byte-identical. I extracted both ranges with `git show <commit>:<path> | sed -n` into temporary files, and `cmp` reported no difference. Each block:

- calls `useSystemProviderInfo` (`apps/app/src/hooks/queries/system-queries.ts:336`). When the thread has an `environmentId`, the call sends `{ enabled: true, environmentId, providerId }`. Otherwise it sends `{ enabled: thread !== undefined, providerId }`;
- derives `threadProviderPluginId = threadProviderInfo?.pluginId ?? null`;
- memoizes `{ providerId: thread?.providerId ?? null, pluginId: threadProviderPluginId }` on `[thread?.providerId, threadProviderPluginId]`.

These are the only two production callers of `useSystemProviderInfo` (search: `git grep -n "useSystemProviderInfo" e9e1b74c -- apps packages`; the other hits are the definition and `system-queries.test.tsx`).

*Counterevidence that shapes the plan.* Thread detail also uses `threadProviderInfo` for more than the context. `ThreadDetailView.tsx:1270-1273` computes `isForkAvailable` from `threadProviderInfo?.capabilities.supportsFork`, and `:1315` gates sent-message editing on `threadProviderInfo?.capabilities.supportsSessionRewind`. A hook that returns only the context value, as the sweep proposed (`useThreadProviderContextValue`), would leave thread detail calling `useSystemProviderInfo` a second time or duplicating the lookup arguments. The hook must therefore return both values.

*Maintenance cost today.* If the provider lookup for a thread changes, for example to scope it by `hostId` (which `UseSystemProvidersArgs` already supports at `system-queries.ts:305`) or to change when it is enabled, both copies must change together. If only thread detail is edited, plugin pages silently pick a different provider plugin's tool renderer for the same thread. `PluginThreadChat.provider-context.test.tsx:161` "scopes the embedded thread's tool rows to its own provider plugin" exists because of that risk.

*Mention-link resolvers (checked and rejected as a shared helper).* Four `useCallback<PromptMentionLinkResolver>` resolvers exist: `PluginThreadChat.tsx:155-186`, `ThreadDetailView.tsx:1786-1848`, `apps/app/src/views/RootComposeView.tsx:980-1042` and `apps/app/src/components/promptbox/NewThreadComposer.tsx:1810-1831` `defaultMentionLinkResolver`. Only the project arm (`return () => navigate(getProjectComposeRoutePath(resource.projectId))`, one statement) is identical in all four. The thread arm differs on purpose in three ways:

- thread detail navigates inside its split pane through `navigateInPaneRef.current(...)` and returns `null` for a falsy project id;
- the plugin chat falls back to `thread?.projectId` and returns `null` when that is `undefined`;
- root compose and the new-thread composer fall back to a `string` `projectId` without a guard.

The route itself is already owned by `getThreadRoutePath` and `getProjectComposeRoutePath` in `packages/client-core/src/routes/route-paths.ts:247` and `:123`. A shared helper would need a navigation callback, a fallback project id and a guard policy. It would save about 5 to 8 lines per caller and add about 20 lines, and it would centralize no knowledge that the route helpers do not already own.

**Proposed end state and preservation argument**

*What remains.* `apps/app/src/components/thread/thread-provider-context.tsx` gains one exported hook next to the context it feeds:

```ts
export function useThreadProviderInfo(
  thread: Pick<ThreadDetail, "environmentId" | "providerId"> | undefined,
): {
  providerInfo: ProviderInfo | null;
  contextValue: ThreadProviderContextValue;
}
```

`ThreadDetail` stands for whatever type `useThread(...).data` has at the snapshot. Use that exact type, or a structural `{ environmentId: string | null; providerId: string }`, whichever compiles without casts. The body is the current 22-line block moved verbatim: the same `useSystemProviderInfo` arguments, the same `?? null` derivation and the same `useMemo` dependencies `[thread?.providerId, providerPluginId]`. `ProviderInfo` comes from `@omnyo/domain`, as in `system-queries.ts:14-18`.

*What disappears.* The duplicated block in `PluginThreadChatBody` and in the thread detail component, and the `useSystemProviderInfo` import in both callers.

*Dependency flow.* Callers → `useThreadProviderInfo` → `useSystemProviderInfo` → `useSystemProviders`. The context module gains one import of `@/hooks/queries/system-queries`. At the snapshot, `system-queries.ts` does not import anything under `components/thread` (its imports are React Query, `@omnyo/domain`, `@omnyo/server-contract`, `@/lib/sdk`, `@/lib/mutation-errors`, `./query-helpers` and `query-keys`), so the import creates no cycle.

*Preservation argument.* React calls the same hooks in the same order with the same arguments, so query keys, the `enabled` gating, the `placeholderData` cache fallback in `useSystemProviders`, the `findCachedProviderInfo` fallback and memo identity all stay the same. `ThreadDetailView` keeps reading `providerInfo.capabilities.supportsFork` and `supportsSessionRewind` from the returned `providerInfo`. No persisted format, route, SDK export or plugin-facing prop changes: `ThreadProviderContext` is app-internal, and the plugin SDK `ThreadChatProps` contract is untouched.

*Non-goals.*
- No shared mention-link resolver (rejected above). Keep each resolver's pane versus global navigation and null-guard behaviour as it is.
- No change to whether `PluginThreadChat` uses pane navigation inside thread detail. Today it uses global `navigate`, and that behaviour stays.
- No change to `useSystemProviderInfo` itself.

**Expected gain and cost**

- *Before (observed):* two copies of 22 lines each (44 lines), plus two `useSystemProviderInfo` import lines.
- *After (projection):* one hook of about 25 to 30 lines including its signature and type import, plus about 3 to 4 formatted lines per call site for the destructuring call. The net is about 8 to 15 fewer handwritten production lines. Tests do not change.
- *Mechanisms:* before, two independent derivations of the thread's provider record and context value. After, one owner. A future change to the lookup arguments or to the context shape becomes one edit, and plugin chats cannot drift from thread detail.
- *Performance (Proven by inspection, not measured):* the same hooks and memo dependencies, so render and query behaviour should be unchanged. Bundle placement: both lazy chunks (`LazyPluginThreadChat`, `LazyThreadDetailView`) already import `system-queries`. Whether `thread-provider-context.tsx` sits in a chunk that does not already contain `system-queries` is unknown. Step 4 checks this.

**Execution steps**

1. *Reconfirm.* In a fresh worktree, re-read `PluginThreadChat.tsx` around `PluginThreadChatBody` and `ThreadDetailView.tsx` around `threadProviderInfo`. Confirm that the two blocks are still identical, for example by extracting both ranges into temporary files and running `cmp`. Also confirm with `git grep -n "useSystemProviderInfo(" -- apps packages` that they are still the only production callers. Re-plan if:
   - the blocks have diverged on purpose (for example, one adds `hostId`). Then decide which behaviour is correct before you share anything;
   - a third provider of `ThreadProviderContext` has appeared. In that case it should use the hook too;
   - `useSystemProviderInfo`'s signature has changed.
2. *Baseline.* Run the focused tests listed under "Verification and acceptance criteria" on the unmodified tree and record that they pass.
3. *Add the hook.* In `apps/app/src/components/thread/thread-provider-context.tsx`, add `import { useMemo } from "react"` to the existing React import, add `useSystemProviderInfo` and the `ProviderInfo` type import, and export `useThreadProviderInfo`. Move the block body verbatim. Rename locals only inside the hook (`providerInfo`, `providerPluginId`, `contextValue`).
4. *Switch thread detail.* In `ThreadDetailView.tsx`, replace lines 1247-1268 with `const { providerInfo: threadProviderInfo, contextValue: threadProviderContextValue } = useThreadProviderInfo(thread);`. Keep the local names so that `isForkAvailable` (around line 1270), `canEditSentMessages` (around line 1315) and the `ThreadProviderContext.Provider` at around line 3725 stay byte-identical. Drop the `useSystemProviderInfo` import at line 39 and import `useThreadProviderInfo` alongside the existing `ThreadProviderContext` import at line 56. Keep `useMemo`, which other code in the file still uses.
5. *Switch the plugin chat.* In `PluginThreadChat.tsx`, replace lines 88-109 with `const { contextValue: threadProviderContextValue } = useThreadProviderInfo(thread);`. Drop the `useSystemProviderInfo` import at line 19. Keep `useMemo`, which `consumerMessageActions` still uses. Import the hook from `@/components/thread/thread-provider-context` next to `ThreadProviderContext`.
6. *Checkpoint.* Run typecheck and the focused tests. Then run the app build and confirm that no new chunk warning or route-preload change appears (`vite-route-modulepreload.test.ts` covers preload lists). If the import from `thread-provider-context.tsx` moves `system-queries` into a chunk that previously lacked it, move the hook into a sibling file `apps/app/src/components/thread/use-thread-provider-info.ts` and rerun the check.
7. *Clean up and recount.* Confirm that no other copy of the `environmentId ? { enabled: true, environmentId, providerId } : { enabled: thread !== undefined, providerId }` argument pattern remains (`git grep -n "enabled: thread !== undefined" -- apps/app/src`). Format the touched files with the repository formatter. Count added and removed lines with `git diff --numstat` against the baseline and report the net.

**Verification and acceptance criteria**

I identified these commands by reading `apps/app/package.json` (`test`: `vitest run --config vitest.config.ts`, `typecheck`, `lint`, `build`) and the root `package.json` (`format:check`: `oxfmt . --check`). The snapshot has no `node_modules`, so I did not run them.

- From the repository root:
  - `pnpm --filter @omnyo/app test src/components/plugin/PluginThreadChat.provider-context.test.tsx src/components/plugin/PluginThreadChat.test.tsx src/hooks/queries/system-queries.test.tsx`. Expected: all pass unchanged. The provider-context tests at lines 161 and 205 are the behavioural guard for plugin chats.
  - `pnpm --filter @omnyo/app test src/views/thread-detail/SplitThreadArea.parity.test.tsx src/views/thread-detail/SplitThreadArea.test.tsx src/vite-route-modulepreload.test.ts`. Expected: all pass, as regression cover for thread detail rendering and chunk preloads. No test at the snapshot asserts fork or rewind gating from provider capabilities (search: `git grep -ln "supportsFork\|supportsSessionRewind" -- 'apps/app/src/views/**/*.test.tsx'` returned nothing). Typecheck plus an unchanged destructured name is the safeguard. Add no new test for this mechanical move.
  - `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/app lint`. Expected: clean.
  - `pnpm exec oxfmt --check apps/app/src/components/thread/thread-provider-context.tsx apps/app/src/components/plugin/PluginThreadChat.tsx apps/app/src/views/thread-detail/ThreadDetailView.tsx`. Expected: clean.
  - `pnpm --filter @omnyo/app build`, only if step 6 needs the chunk check.
- *Behaviour that must survive:*
  - A plugin page that embeds a thread from provider B picks provider B's tool renderer, not the page plugin's renderer.
  - A thread without an environment still looks up its provider globally.
  - In thread detail, Fork and sent-message editing still appear only when the provider supports them.
  - No visual change is expected. A manual check is optional: Alex tests UI changes himself.
- *Structural completion:*
  - `useSystemProviderInfo` has exactly one production caller, `useThreadProviderInfo`.
  - Neither component computes `threadProviderPluginId` itself.
  - `ThreadProviderContext.Provider` sites are unchanged.

**Rollback and stop conditions**

- *Rollback:* the change touches three files in one commit, with no data, route or contract implications. Revert that commit to restore the two copies.
- *Stop if:*
  - the two blocks have diverged on purpose by the time you execute. Resolve the intended behaviour first, which may turn this into a bug fix rather than a refactor;
  - extracting the hook changes any focused test outcome;
  - typecheck shows that thread detail needs a different `thread` type than the plugin chat and the hook can only satisfy both with a cast. Use the structural `Pick`-style parameter instead, or stop;
  - the build shows a chunk or preload change that the sibling-file placement in step 6 does not remove.
- *Safer smaller alternative:* if the extraction is blocked, leave the code as it is and add a one-line comment in each block that points to the other. That alternative removes no complexity, so record it as declined rather than done.
