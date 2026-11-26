# RF-088 — Build the queued-message plugin composer host in one hook instead of two diverging copies

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** conditional. The duplication is real and the two copies already disagree in ways that matter. The sweep's line estimate was low, and verification found a lost-update defect in one copy, which strengthens the case.
- **Potential:** medium. One state-coordination rule set disappears: the rules that decide whether a plugin read or write reaches the current queued-message edit.
- **Confidence:** medium-high on the facts, medium on the final semantics.
- **Readiness:** conditional. Before implementation, Alex or the implementing agent must make the semantics decision in Execution step 2. It covers three questions: what a stale host returns after its edit session ends, whether the thread page adopts the side chat's unmount check, and how each surface keys its host.
- **Effort:** S–M, about half a day to one day, including two characterization tests.
- **Risk:** moderate. This code sits on the plugin composer path: plugin text effects, `composer.draft`, `replace`, `addQuote`, `insertAtCursor` and the prompt-history restore. The unified hook changes the side chat's read timing on purpose (see the defect below).
- **Prerequisites:** none in code. The decision in step 2 is the only gate.
- **Related and overlapping items:**
  - RF-029 (one queue and execution sequence for composer selections) touches the same two components. Land the two items separately; do not combine them.
  - RF-095 (PluginThreadChat re-deriving thread-detail context) touches `EmbeddedThreadChat`'s caller.
  - RF-052 (optimistic thread-status protocol) shares the composers but not this code.
  - **Superseding alternative:** PR #6387, "Use one thread screen for the main view, side chat and plugin ThreadChat" (commit `b28bbc2c19`, 2026-10-27), would have deleted `EmbeddedThreadChat` entirely. It exists only under `upstream-pr/*` refs in the retired private checkout `$ARCHIVED_OMNYO_CHECKOUT`. It is not an ancestor of that repository's `main` and is absent from the public snapshot. If Alex plans to revive the one-thread-screen work, RF-088 is subsumed and should be skipped.
- **Why it deserves its place:** both thread composers already share one edit-state owner, `useInlineQueuedMessageEditing`, but each adapts that state to `PluginComposerHost` with its own predicate, read rule, write rule, fallback and key scheme. The copies have drifted. Only the thread-page copy is protected by the regression test for back-to-back plugin updates, and the side-chat copy fails that scenario by inspection.

**Context and evidence**

Snapshot: public `alexburlis/omnyo` at commit e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e (origin/main on 2026-11-26). The snapshot worktree path was unavailable, so all reads used `git show e9e1b74c3:<path>` from `$OMNYO_CHECKOUT`. No tests were run because the snapshot has no `node_modules`.

How the subsystem works: when a user clicks Edit on a queued message, the composer shows an inline editor. Plugins reach that editor through a `PluginComposerHost` (`apps/app/src/components/plugin/plugin-composer-host.tsx:26` "PluginComposerHost") whose scope is `{ kind: "queued-message", threadId, queuedMessageId }`. Plugin APIs wrap the host in `apps/app/src/lib/plugin-composer-handle.ts`:

- `composerDraftTarget` (line ~213) reads `source.getCurrent()` and then writes `source.setDraft(...)` for `replace`.
- `createCoreComposerActions` (line ~180) does the same for `addQuote` and `restoreDraft`.
- `composerHandleTarget` (line ~234) does the same for `addQuote` and the `insertAtCursor` fallback.
- The SDK's `createComposerDraftActions` (`packages/plugin-sdk/src/internal/composer-draft-actions.ts:107`) reads `getDraft` for the `draft` getter without checking availability. `replace` checks `isAvailable` first.
- `usePluginComposerHostDraft` (`plugin-composer-host.tsx`) feeds `getCurrent` into `useSyncExternalStore`, so `getCurrent` also runs during render.

The shared state owner is `apps/app/src/components/thread/embedded-chat/useInlineQueuedMessageEditing.ts` "useInlineQueuedMessageEditing". It returns:

- `inlineEditingQueuedMessage`, the state filtered by `ownerThreadId` and by whether the message still exists;
- `inlineEditingQueuedMessageRef`, a raw ref that `commitInlineQueuedMessage` updates synchronously and that the `updateInlineQueuedMessage` updater also updates;
- `commitInlineQueuedMessage`, `updateInlineQueuedMessage` and the other edit controls.

`editSessionId` comes from a per-instance counter (`inlineEditSessionIdRef.current += 1`).

Copy A, the thread page (`apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`), observed:

- Lines 360–400 hold `InlineQueuedMessageEditSession`, `isInlineQueuedMessageEditSession` (compares `editSessionId` and `queuedMessageId`), `ENDED_EDIT_SESSION_DRAFT` (line 375, also used by the sent-message host at line 2528, so it stays), `readInlineQueuedMessageDraft` and `writeInlineQueuedMessageDraft`.
- Line 620 holds `subscribeInlineQueuedDraft = useComposerHostDraftNotifier(...)`.
- Lines 2318–2343 hold the session ids, `queuedMessageSelection` (uses `thread.providerId`) and `queuedMessageComposerSelection = useComposerHostSelection(...)`.
- Lines 2345–2395 hold the `queuedMessagePluginComposerHost` memo:
  - `textEffectKey` is the deterministic `queued-message:${thread.id}:${queuedMessageId}:${editSessionId}`.
  - `getCurrent` reads the raw ref and falls back to an empty draft.
  - `setDraft` commits only when the session matches.
  - `isAvailable` applies the session predicate.
  - `focus` calls `focusInlinePluginComposer`.
- Consumers are at lines 2402–2483, where the host becomes the inline editor's `pluginComposerHost`.

Copy B, the side chat and plugin `ThreadChat` (`apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.tsx`), observed:

- Line 123 holds `createPluginComposerHostIdentity`, a module-level counter that makes each key unique per mount.
- Lines 826–866 hold `queuedComposerIdentity` (`editSessionId`, `ownerThreadId`, `queuedMessageId`) and `queuedComposerHostIdentity` (`queued-message:…:active:ownership:N`).
- Lines 869–898 hold `activeQueuedComposerIdentityRef` and `committedInlineEditRef`. Both are set in `useLayoutEffect`, and the cleanup clears ownership on unmount or identity change.
- Line 900 holds `subscribeQueuedDraft`, and lines 930–948 hold `queuedSelection` (uses `selectedProviderId`) and `queuedComposerSelection`.
- Lines 1009–1080 hold the `queuedPluginComposerHost` memo:
  - `isCurrentQueuedEdit` also compares `ownerThreadId`.
  - `getCurrent` returns `initialDraft` (the draft at memo time) unless the host owns the mount and the session matches. When both hold, it reads `committedInlineEditRef`, which reflects the last rendered state.
  - `setDraft` and `focus` are gated on ownership.
  - `setDraft` writes through `updateInlineQueuedMessage`.
  - `isAvailable` requires both ownership and the session match.
- Consumers are at lines 1088 (text effects), 1136–1142 (`restoreQueuedHistoryDraft`) and 1375–1376 (the inline PromptBox).

Production consumers of `EmbeddedThreadChat` at the snapshot: `apps/app/src/components/plugin/PluginThreadChat.tsx:248` and `apps/app/src/views/thread-detail/ThreadTimelinePane.tsx:26`. Command: `git grep -n 'EmbeddedThreadChat\b' e9e1b74c3 -- apps packages`.

Differences between the copies, with evidence labels:

| # | Difference | Observable? | Label |
|---|---|---|---|
| 1 | Read source. Copy A reads the raw ref, which updates synchronously on write. Copy B reads `committedInlineEditRef`, which updates only in a layout effect after render. | Yes. Two plugin writes in one tick lose the first write in Copy B (see the defect below). | Proven by inspection |
| 2 | Fallback after the session ends or the host is not active. Copy A returns an empty draft. Copy B returns `initialDraft`, the draft when the host was built. | Only to a plugin holding a stale handle that reads `composer.draft`. Copy B's fallback is also what a new host returns on its first render, before its layout effect claims ownership. | Proven by inspection |
| 3 | Copy B's predicate also compares `ownerThreadId`; Copy A's does not. | No. Copy A builds a host only from the filtered state, whose `ownerThreadId` equals `thread.id`, and session ids are unique per hook instance. | Proven by inspection |
| 4 | Copy B adds mount ownership: after unmount or a re-key, a stale host stops being available. In Copy A, a stale host stays `isAvailable() === true` after unmount, because the raw ref keeps its last value. | Narrow. Writes after unmount reach a dead state setter. | Proven by inspection for the code path; impact is a hypothesis |
| 5 | Copy A's `textEffectKey` is deterministic; Copy B's is unique per mount. The key addresses the editor bridge (`getComposerEditorBridge(key)`) and `listedComposerBindings`. | Matters if two instances of the same surface show the same thread. | Hypothesis (collision not shown) |
| 6 | Provider id source (`thread.providerId` against `selectedProviderId`), focus nonce and write primitive (`commit` against `update`). | These are legitimate per-surface inputs. | Proven by inspection |

**Defect found while verifying (Proven by inspection, not reproduced).** In Copy B, a plugin that calls `setDraft` and then reads `getCurrent` in the same tick receives the pre-write draft. The reason is that `committedInlineEditRef` changes only after the next render. A chained update, therefore, overwrites the first one. The same happens with two `composer.replace` calls, or with `addQuote` after `replace`. Copy A has a regression test for exactly this case: `apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx:1753` "keeps back-to-back plugin updates in the active queued draft", driven by the mock button "Simulate chained plugin updates" at lines 351–363. `EmbeddedThreadChat.test.tsx` has no queued-host test; command: `git grep -n -i 'queued-message\|Edit queued\|isAvailable' e9e1b74c3 -- apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.test.tsx` returns only list test ids.

Other tests that encode the contract (all in Copy A's suites):

- `ThreadDetailPromptArea.test.tsx`: 1685 "exposes the inline queued draft to plugins without dropping attachments", 1780 "renders text effects only for the active queued edit session", 1852 "ignores a stale plugin write after the queued edit changes" and 2034 "does not attach a delayed queued upload to a later edit or the bottom draft".
- `ThreadDetailPromptArea.keystrokes.test.tsx:546` "swaps to a per-session stable host for inline queued-message edits and streams the inline draft".
- `apps/app/src/components/plugin/plugin-slot-mounts.test.tsx:669` and `:751` test plugin slots against hand-built queued hosts. They do not test either production copy.

External consumers searched:

- `rg -l 'queued-message' $OMNYO_PLUGIN_CHECKOUT` (excluding node_modules and dist) finds `skill-discovery/prompt-picker.tsx:89`, which only switches on `scope.kind`, plus tests and one skill doc.
- No first-party plugin was found to depend on either stale-session fallback. A search with no matches does not prove absence for third-party plugins.
- The SDK documents no stale-read value. `docs/api_to_audit.md:235` lists inline queued-message editing as unverified before stabilization.

History: the public repository has one squashed commit (`060950255`, 2026-11-24), so neither copy records a rationale there. The ownership counter matches PR #6387's stated goal that "each embedded composer gets its own composer id and scope".

Maintenance cost today: a fix to queued-host session safety has to be written twice against different rules, and only one copy has the tests. The divergence in row 1 shows that drift has already happened.

**Proposed end state and preservation argument**

Add `apps/app/src/components/thread/embedded-chat/useQueuedMessagePluginComposerHost.ts` and export it from `embedded-chat/index.ts`, beside `useInlineQueuedMessageEditing`. That folder already serves both composers: `ThreadDetailPromptArea.tsx:139` imports from it.

Proposed signature (a projection):

```ts
function useQueuedMessagePluginComposerHost(args: {
  edit: Pick<UseInlineQueuedMessageEditingResult,
    "inlineEditingQueuedMessage" | "inlineEditingQueuedMessageRef" | "commitInlineQueuedMessage">;
  providerId: string | undefined;        // thread.providerId | selectedProviderId
  supportsServiceTier: boolean;
  focus: () => void;                     // each surface's focus-nonce bump
  keyPrefix?: string;                    // see decision C
}): PluginComposerHost | null
```

The hook owns all of the following:

- One session predicate on `editSessionId` and `queuedMessageId`; `ownerThreadId` is redundant (row 3).
- One read rule: read the raw `inlineEditingQueuedMessageRef`, which is synchronous and is what Copy A tests.
- One write rule: commit only when the session matches.
- The chosen fallback (decision A) and ownership behaviour (decision B).
- The draft notifier (`useComposerHostDraftNotifier`).
- The selection store (`readExecutionSelection` plus `useComposerHostSelection`).
- The scope `{ kind: "queued-message", threadId: edit.ownerThreadId, queuedMessageId }`.

What disappears:

- In Copy A, `InlineQueuedMessageEditSession`, `isInlineQueuedMessageEditSession`, `readInlineQueuedMessageDraft` and `writeInlineQueuedMessageDraft` (lines 360–400; `ENDED_EDIT_SESSION_DRAFT` stays, or the hook imports its own empty draft), `subscribeInlineQueuedDraft` (line 620), lines 2318–2395, and `NO_INLINE_EDITOR_SELECTION` (line 232) if nothing else uses it.
- In Copy B, `queuedComposerIdentity`, `queuedComposerHostIdentity`, `activeQueuedComposerIdentityRef`, `committedInlineEditRef` and its layout effect, `subscribeQueuedDraft`, `queuedSelection`, `queuedComposerSelection`, the `queuedPluginComposerHost` memo and `NO_QUEUED_EDITOR_SELECTION`.
- `createPluginComposerHostIdentity` stays because the bottom host still uses it. Under decision C it may move into the shared hook's module.

What survives unchanged:

- The scope shape.
- The text-effect behaviour: `useComposerTextEffects(host?.textEffectKey)`.
- The `restoreQueuedHistoryDraft` and `restoreDraft` callers.
- Per-session host identity: a new host for each edit session and the same host while typing. The keystrokes test at line 546 pins this.
- The stale-write rejection pinned by test 1852.
- Attachments and upload isolation (tests 1685 and 2034).

Intentional behaviour change: the side chat adopts the synchronous read rule. This fixes the lost-update defect and changes no persisted format, API or UI layout.

Non-goals: no change to `useInlineQueuedMessageEditing`, the bottom or sent-message hosts, `PluginComposerHost`, the SDK or RF-029's selection queue.

Why this is the simplest sufficient option:

- Keeping two copies preserves the drift.
- Merging the whole of `EmbeddedThreadChat` into the thread screen (#6387) would be far larger and is a product-level decision.

**Expected gain and cost**

Observed counts are non-blank lines in the snapshot (`sed -n <range>p <file> | grep -cv '^\s*$'`):

- Copy A: 35 (lines 360–400, minus the retained constant) + 19 (2325–2343) + 49 (2345–2395) + about 7 for the ids, notifier and constant, which is about 110.
- Copy B: 18 (826–846) + 9 (858–866) + about 16 queued-only lines in 869–898 + 2 (900–902) + 17 (930–948) + 64 (1009–1080), which is about 125.

Projections:

- The new hook is about 100–115 lines, and the two call sites are about 10–12 lines each.
- The net reduction is about **60–100 handwritten production lines**. This corrects the sweep's 30–60.
- Tests add about 40–80 lines: one Embedded characterization test, plus at most one test for the hook.

Mechanisms before and after: two host builders, two predicates, two read rules and two fallbacks today, against one of each afterwards, plus one documented per-surface key option. Fixing the side-chat defect is a correctness gain, not a size gain.

Cost and tradeoff: the hook takes a key option, which adds a small amount of configurability. Performance is expected to be neutral: the same memos, one fewer layout effect in Copy B and no new renders. The keystrokes test's render-count assertions (`shellRenderCount`) guard this.

**Execution steps**

1. **Reconfirm the anchors.** In a fresh lane from current `main`, re-open the anchors above. Re-plan if any of these holds:
   - `EmbeddedThreadChat` has been deleted or replaced by a shared thread screen (#6387 revived). If so, close RF-088 as superseded.
   - Either host memo no longer exists in the form described.
   - `useInlineQueuedMessageEditing` changed its ref or commit semantics.
2. **Investigation gate: make the semantics decision.** Record the decision in the PR description before editing.
   - **A. Fallback after the session ends.** Recommended: an empty draft, Copy A's behaviour. A stale handle should not report a draft that no longer exists. Copy B's `initialDraft` fallback exists mainly to cover the first render before ownership is claimed, and reading the raw ref removes that need. To confirm, run `rg -n 'composer\.draft|getDraft\(' $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'` and check whether any composer-slot plugin reads `draft` after `isAvailable()` turns false. If one relies on the creation-time draft, stop and ask Alex.
   - **B. Mount ownership.** Recommended: keep it in the hook for writes, `isAvailable` and `focus`, using a per-host `useLayoutEffect` with cleanup as Copy B does. Do not gate reads, so that the first render and `useSyncExternalStore` stay correct without an `initialDraft` fallback. The thread page gains unmount invalidation (row 4). Check that no consumer calls `isAvailable()` during the host's first render before the layout effect: search `plugin-composer-handle.ts` and the slot mounts. If one does, gate only writes and `focus`.
   - **C. Key scheme.** Recommended: the hook always appends a per-mount ownership suffix, using the counter from `createPluginComposerHostIdentity`. Before adopting it for the thread page, confirm that nothing parses or matches the deterministic key: `rg -n 'queued-message:' apps/app/src --glob '!*.test.*'` and `rg -n 'textEffectKey' apps/app/src`. If the thread page's key must stay deterministic, take a `keyPrefix` plus an `uniquePerMount: boolean` flag instead.
3. **Add Embedded characterization coverage first.** In `apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.test.tsx`, extend the mocked PromptBox (around lines 58–130, where `BottomHostDraftProbe` and the `pluginComposerHost` prop live) so the inline editor's host is captured. Then add three tests:
   - (a) "keeps back-to-back plugin updates in the active queued draft", mirroring `ThreadDetailPromptArea.test.tsx:1753`. It is expected to **fail** on the current code; record that failure.
   - (b) "ignores a stale plugin write after the queued edit changes", mirroring test 1852.
   - (c) One test that pins the post-dismiss `getCurrent` value chosen in decision A.
4. **Checkpoint 1: add the hook** (`useQueuedMessagePluginComposerHost.ts`) with the signature above and export it from `embedded-chat/index.ts`. Pseudocode:
   - `session = edit.inlineEditingQueuedMessage ? { editSessionId, queuedMessageId, ownerThreadId } : null`, memoized on the three ids.
   - `key = useMemo(() => session ? createKey(session) : null, [session])`, plus the ownership ref and layout effect from decision B.
   - `subscribeDraft = useComposerHostDraftNotifier(edit.inlineEditingQueuedMessage?.draft ?? null)`.
   - `selection = useComposerHostSelection(key ?? "", readExecutionSelection(...) or {})`.
   - The host memo returns `null` without a session. Otherwise `getCurrent` returns `matches(ref.current) ? ref.current.draft : EMPTY`, `setDraft` returns early unless the session matches and the host owns the mount, then calls `commit({ ...ref.current, draft })`, and `isAvailable` and `focus` apply the same check.
5. **Checkpoint 2: switch the thread page.** In `ThreadDetailPromptArea.tsx`, replace lines 2318–2395 with one call: `useQueuedMessagePluginComposerHost({ edit: { inlineEditingQueuedMessage, inlineEditingQueuedMessageRef, commitInlineQueuedMessage }, providerId: thread.providerId, supportsServiceTier, focus: focusInlinePluginComposer })`. Then delete lines 360–399 except `ENDED_EDIT_SESSION_DRAFT`, delete `subscribeInlineQueuedDraft` at line 620, and delete `NO_INLINE_EDITOR_SELECTION` if it is now unused. Run the thread-page suites (Verification).
6. **Checkpoint 3: switch the side chat.** In `EmbeddedThreadChat.tsx`, replace lines 826–866 (queued parts only), the queued halves of 869–898, line 900 and lines 930–948 and 1009–1080 with one call that passes `selectedProviderId` and a focus callback that bumps `setInlineComposerFocusNonce`. `useInlineQueuedMessageEditing` must also return `commitInlineQueuedMessage` to this caller; it already does, so only the destructuring changes. Keep `createPluginComposerHostIdentity` for the bottom host. Run the embedded suite; test (a) from step 3 should now pass.
7. **Remove leftovers.** Delete `NO_QUEUED_EDITOR_SELECTION` and any imports that became unused, such as `RefObject` and `InlineQueuedMessageEditState`. Review the full diff for leftover old paths, and recount the reduction with the same `grep -cv` method.

**Verification and acceptance criteria**

The commands below come from the snapshot's `apps/app/package.json` (`test`, `typecheck`, `lint`) and the root `package.json` (`format:check`). Their exact behaviour was not run, because the snapshot has no `node_modules`.

- `cd apps/app && pnpm exec vitest run --config vitest.config.ts src/views/thread-detail/ThreadDetailPromptArea.test.tsx src/views/thread-detail/ThreadDetailPromptArea.keystrokes.test.tsx src/components/thread/embedded-chat/EmbeddedThreadChat.test.tsx src/components/plugin/plugin-slot-mounts.test.tsx`. All tests should pass. The new Embedded test (a) must have been seen failing before checkpoint 3. Existing assertions must not be weakened, and that includes `shellRenderCount` and the published-host-draft assertions in the keystrokes test at line 546.
- `cd apps/app && pnpm typecheck`
- `cd apps/app && pnpm exec oxlint --deny-warnings <changed files>`, followed by `pnpm exec oxfmt --check <changed files>` from the repository root (the root `format:check` script uses `oxfmt`).
- Behaviour checks that the tests must cover:
  - a new host for each edit session, and the same host while typing;
  - a stale host's writes are ignored after a second edit begins;
  - chained writes in both surfaces;
  - text effects appear only for the active session;
  - prompt-history restore into the queued editor (`restoreQueuedHistoryDraft` throws when the host is null);
  - attachments survive plugin `replace`.
- Manual check, optional because Alex tests UI himself: in a plugin side chat and on the thread page, edit a queued message, trigger a composer-slot plugin action such as a Skill Discovery prompt insert, cancel, and confirm that the bottom composer is unaffected.
- Structural completion:
  - `rg -n 'queuedPluginComposerHost = useMemo|queuedMessagePluginComposerHost =\s*$|isInlineQueuedMessageEditSession|activeQueuedComposerIdentityRef' apps/app/src` returns nothing.
  - `rg -n 'useQueuedMessagePluginComposerHost' apps/app/src` shows exactly the definition, the export and two call sites.

**Rollback and stop conditions**

The change is confined to `apps/app` client code and has no persisted data, wire or SDK impact, so reverting the commit restores both copies. Checkpoints 2 and 3 can land as separate commits, which allows rolling back one surface.

Stop and re-plan if any of the following happens:

- A plugin is found that depends on Copy B's `initialDraft` fallback, or on Copy A's deterministic key.
- A consumer calls `isAvailable()` during the first render, so decision B breaks it.
- The keystrokes test's render-count assertions change. That is a performance regression; do not update the expected counts.
- PR #6387 or another one-thread-screen effort is being revived.

Safer smaller alternative: fix only the side chat's read rule (read `inlineEditingQueuedMessageRef` instead of `committedInlineEditRef` in `getCurrent`) and add the chained-update test. That alternative fixes the defect without consolidating.
