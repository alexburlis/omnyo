# RF-036 — Replace four hand-written copies of the follow-up draft-submission transaction with one `submitComposerDraft` helper, and drop the dead side-chat submit-mode wrapper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the four interactive follow-up send handlers repeat the same transaction, which has one exactly-once invariant on the composer submission journal. The sweep's plan for the modifier shortcut is corrected. Generalizing `buildFollowUpShortcutRequest` to accept Embedded's execution fields would collide with RF-100. Instead, the helper reports an `"empty"` outcome, and both modifier handlers steer the queued head on that outcome. The separate "delivery helper" is also unnecessary: widening the parameter type of the existing `reportQueuedSendDelivery` removes the three mappings. The line estimate is restated below as a projection.
- **Potential:** medium. One owner for a correctness invariant (each submission must end in exactly one `complete()` or `restoreFailed()`) on the two most-used existing-thread composers, plus about 30 lines of certainly dead or no-op code.
- **Confidence:** high that the duplication and the dead branch are real (Proven by inspection). Medium on the exact line savings (projection).
- **Readiness:** ready. No owner decision is needed, because every user-visible behaviour is preserved.
- **Effort:** medium, about one day, including the new direct helper tests.
- **Risk:** moderate. These are core send paths. A missed `complete()` leaves a journal entry that is recovered on reload as an unsent message. A missed upload restore loses attachments. Both regressions can be tested directly against the real journal.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-100 "Stop restating follow-up execution-request field rules in the app" owns Embedded's hand-built `executionRequestFields` (`EmbeddedThreadChat.tsx:345-376`). This card deliberately does not touch execution fields. Land in either order; if RF-100 lands first, the Embedded `send` closures use its builder.
  - RF-053 "Decide whether every timeline follow-up runs through the send outbox" may change the `stageTimelineFollowUp` branch in `ThreadDetailPromptArea.handleSend`. That branch stays inside the `send` closure here, so either outcome fits.
  - RF-052 "Define the composer optimistic thread-status protocol once" and RF-029 (composer `setSelection` queue) edit other parts of the same two components. Land them as separate commits.
  - RF-095 "Stop PluginThreadChat re-deriving thread-detail provider context and mention links" touches the embedded chat family but not these handlers.
  - `NewThreadComposer.tsx:2014-2100` runs a similar sequence for creating a new thread. It is out of scope: it has its own creation, handoff and pending-chat steps, and RF-029 owns that composer's other duplication.
- **Why this rank:** the maintained mechanism that disappears is a multi-step protocol with an ordering invariant, copied four times across a 3,013-line and a 1,566-line component. Its sensitive steps (upload restore when the draft changed, journal completion on every exit) have no direct test today.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared snapshot worktree had been removed, so every file was read with `git show e9e1b74c3:<path>`. `git diff --quiet e9e1b74c3 HEAD -- <the five cited files>` reports them identical on local `main` (5f2d3f895), so the line anchors also hold there.

*What the subsystem does.* Omnyo has two composers for an existing thread. The thread page uses `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`. Plugin side chats and embedded conversations use `apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.tsx`. When the user presses Enter (send or queue) or the modifier shortcut (steer), each composer takes a snapshot of the draft and its pending uploads and calls `prepareComposerAttachmentSubmission` (`apps/app/src/lib/composer-attachment-submission.ts:71`). That call opens a journal entry in localStorage (`beginComposerSubmission`, `apps/app/src/lib/composer-submission-journal.ts`), so a reload can recover a message that was in flight. The returned object must then end in exactly one `complete()` or one `restoreFailed(restore)` (`composer-attachment-submission.ts:144-149`). `restoreFailed` puts the captured uploads back, re-applies the failed draft and closes the journal.

*Observed facts (Proven by inspection).*

1. The four interactive handlers repeat the same seven steps: prepare the submission; if `submission.input` is empty, call `complete()` and stop; if `promptDraft.clearIfCurrentMatches(draft)` is false (the user typed during capture), call `uploads?.restore()` and `complete()` and stop; clear the bottom attachment error; send; on success, `complete()`; on failure, `restoreFailed(promptDraft.restoreFailedDraft)` and `showMutationErrorToast`.
   - `ThreadDetailPromptArea.tsx:1533-1653` `handleSend`: 121 physical lines, 106 nonblank. The protocol is at 1552-1571 and 1573/1624-1636. The handler also has a handoff branch before the protocol (1538-1547), the `stageTimelineFollowUp` branch (1574-1590) and the queue-or-send choice (1592-1622).
   - `ThreadDetailPromptArea.tsx:1874-1962` `handleModifierSubmit`: 89 physical lines, 76 nonblank. The protocol is at 1883-1930.
   - `EmbeddedThreadChat.tsx:640-692` `handleSubmit`: 53 physical lines, 47 nonblank. It is almost entirely protocol.
   - `EmbeddedThreadChat.tsx:722-800` `handleModifierSubmit`: 79 physical lines, 71 nonblank. (The sweep cited 718; the handler starts at 722.)
   - Command: `git grep -n -e 'clearIfCurrentMatches(' -e 'restoreFailed(' e9e1b74c3 -- apps packages`. It returns these sites, the two programmatic variants (`ThreadDetailPromptArea.tsx:1506, 1761`, `EmbeddedThreadChat.tsx:599`), `NewThreadComposer.tsx:2056, 2097`, `usePromptDraftStorage.ts:333` and the helper itself.
   - Line counts come from a `python3 -I` count over the extracted snapshot files: 342 physical and 300 nonblank lines across the four handlers.
2. **Both modifier handlers implement one rule: "if the draft input is empty, steer the head queued message; otherwise send the draft with `mode: "steer-if-active"`."**
   - ThreadDetail reaches the rule through `buildFollowUpShortcutRequest` (`packages/client-core/src/prompt/threadDetailPromptSubmission.ts:307-336`). That function returns `"draft"` exactly when `buildSteerFollowUpRequest` returns non-null, which happens exactly when the input is non-empty (`:268-270`). Otherwise it returns `"queued"` for `queuedMessages[0]`, or null.
   - Embedded hand-writes the same rule (`EmbeddedThreadChat.tsx:738-751`, then 761-769).
   - Its only production caller is `ThreadDetailPromptArea.tsx:1889` (command: `git grep -n buildFollowUpShortcutRequest e9e1b74c3`).
3. **When the input is empty, there are no uploads.** `prepareComposerAttachmentSubmission` (`composer-attachment-submission.ts:95-111`) turns a non-null upload capture with empty text into an `Uploading …` input. `addConversationInput` (`apps/app/src/lib/embedded-conversation.ts:9-24`) returns an empty input unchanged. The modifier handlers pass no `pendingTranscript`. So an empty input implies `uploads === null`, and `capturedUploads?.restore()` at `ThreadDetailPromptArea.tsx:1897` never does anything.
4. **ThreadDetail's head re-check is dead.** `ThreadDetailPromptArea.tsx:1935` compares `queuedMessagesRef.current[0]?.id` with the id read from the same ref at 1892. Nothing between the two lines awaits, and `submission.complete()` only writes localStorage. The comparison is always equal.
5. **The delivery mapping is a no-op.** `EmbeddedThreadChat.tsx:536-540`, `591-595` and `771-775` each map `"stored"` and `"waiting"` to `"sent"` before calling `reportQueuedSendDelivery` (`:110-119`). That function acts only on `"queued"`. The mapping exists only because its parameter type is `SendMessageDelivery = "sent" | "queued"` (`packages/server-contract/src/api/threads.ts:511-513`), while the response type has four deliveries (`:515-532`).
6. **`buildSideChatSubmitMode` has a dead branch.** The function is at `threadDetailPromptSubmission.ts:161-182`, and its argument interface is at `:95-102`. Its only production caller is `EmbeddedThreadChat.tsx:491-508`, which passes `childThreadId: threadId`. `threadId` is typed `string` (`EmbeddedThreadChat.tsx:143`). The `childThreadId === null` branch (`:169-173`) is therefore reachable only from `packages/client-core/test/threadDetailPromptSubmission.test.ts:410-434`. For a non-null id, the function forwards its other arguments unchanged to `buildFollowUpSubmitMode` (`:175-181`).
   - Search: `git grep -n -e buildSideChatSubmitMode -e BuildSideChatSubmitModeArgs e9e1b74c3` over the whole tree, and `rg` over `$OMNYO_PLUGIN_CHECKOUT` (excluding `node_modules`). There are no other hits.
   - `@omnyo/client-core` is `"private": true`. It is re-exported only through its own `src/index.ts:33`, and no plugin SDK package depends on it.

*Counterevidence and intentional differences (kept at the call sites).*

- ThreadDetail `handleSend` keeps its handoff branch, `stageTimelineFollowUp`, `compactFirst` and its queue/send copy: "Failed to queue message" or "Failed to send message".
- Embedded `handleSubmit` always uses the fallback "Failed to send message", but it switches `lifecycleOperation` between `queue_message` and `send_message`. This copy difference is preserved as is. It is not a confirmed bug, because the fallback appears only when the error carries no message.
- ThreadDetail's queued-head shortcut wraps the send in `runWhileFollowUpShortcutSending` (`:424-435`), which feeds `isFollowUpSubmitting`. Embedded does not. That difference stays.
- The programmatic variants (`ThreadDetailPromptArea.tsx:1655-1786` `submitDraftProgrammatically`, and `EmbeddedThreadChat.tsx:551-620`) differ in kind. They clear the draft unconditionally when `clearCurrentDraft` is set, cancel a send reservation, and throw instead of showing a toast. They are a non-goal.

*Test coverage at the snapshot (inspection only; no suite was run, because the snapshot has no `node_modules`).*

- `EmbeddedThreadChat.test.tsx:572` checks that a draft is queued while the thread is active. `:596` checks an immediate send. `:642` checks that a failure is recovered after leaving the chat. `:689` checks steering a queued row.
- `ThreadDetailPromptArea.test.tsx:1449` checks the modifier shortcut sending the next queued message. `:1265` checks that the composer accepts the next message during a send.
- `composer-attachment-submission.test.ts` exercises the helper's `restoreFailed` at `:159`, and it uses the real journal (`recoverInterruptedComposerSubmissions`).
- No test drives the "draft changed during capture" path, the Embedded queued-delivery toast, or the Embedded modifier draft steer.

*Maintenance cost today.* A change to the journal or restore semantics, such as keeping attachments on failure or recording the failure reason, must be made at four sites in two large components, each with its own dependency array. One site already differs in a harmless but confusing way: the dead upload restore and head re-check in ThreadDetail.

**Proposed end state and preservation argument**

*What remains.* One function, `submitComposerDraft`, in `apps/app/src/lib/composer-attachment-submission.ts`, next to `prepareComposerAttachmentSubmission`. It owns the seven-step transaction:

```ts
type DraftSubmissionOutcome = "empty" | "changed" | "sent" | "failed";

export async function submitComposerDraft({
  promptDraft, // Pick<PromptDraftController, "clearIfCurrentMatches" | "restoreFailedDraft">
  draft,       // PromptDraftState, captured by the caller
  uploads,     // CapturedAttachmentUploads | null, captured by the caller
  scope,       // PromptDraftScope
  conversation, // EmbeddedConversation | undefined
  clearAttachmentError, // () => void
  send,        // (submission: ComposerAttachmentSubmission) => Promise<void>
  failure,     // Pick<MutationErrorMessageOptions, "fallbackMessage" | "lifecycleOperation">
}): Promise<DraftSubmissionOutcome> {
  const submission = prepareComposerAttachmentSubmission({ draft, scope, uploads, conversation });
  if (submission.input.length === 0) { submission.complete(); return "empty"; }
  if (!promptDraft.clearIfCurrentMatches(draft)) { uploads?.restore(); submission.complete(); return "changed"; }
  clearAttachmentError();
  try { await send(submission); submission.complete(); return "sent"; }
  catch (error) {
    submission.restoreFailed(promptDraft.restoreFailedDraft);
    showMutationErrorToast({ error, ...failure });
    return "failed";
  }
}
```

`ComposerAttachmentSubmission` is `ReturnType<typeof prepareComposerAttachmentSubmission>`. Export it as a named type. `PromptDraftController` comes from `apps/app/src/hooks/usePromptDraftStorage.ts:342`. The caller captures `draft` and `uploads` itself, because ThreadDetail's handoff branch needs them before the transaction starts.

*How each handler changes.*

- ThreadDetail `handleSend` keeps the handoff branch. It then calls `submitComposerDraft`. Its `send` closure holds the existing `stageTimelineFollowUp` check, `setFullHistoryThreadId(null)` and the queue/send choice. The closure returns early after staging; the helper then calls `complete()`, as the code does today at 1587. `failure` is the existing copy chosen by `isQueuingMessage`.
- ThreadDetail `handleModifierSubmit` calls `submitComposerDraft`. Its `send` closure sends `buildSteerFollowUpRequest({ execution, input: submission.input, threadId })` plus `options` and `prepareInput`. That builder becomes exported from client-core. On `"empty"`, the handler reads `queuedMessagesRef.current[0]`. If a head exists, it runs the existing `runWhileFollowUpShortcutSending(... sendQueuedMessageById({ guard: "current-head", messageId, mode: "steer" }))`. The dead re-check and the dead upload restore disappear.
- Embedded `handleSubmit` uses `send: (s) => defaultSendOrQueueInput(s.input, s.prepareInput, options)` with its current failure copy.
- Embedded `handleModifierSubmit` uses a `send` closure with `mode: "steer-if-active"` and its current `executionRequestFields`, followed by `reportQueuedSendDelivery(result.delivery)`. On `"empty"`, it calls the existing `sendQueuedMessageById({ guard: "current-head", ... })` for `queuedMessages[0]`.
- `reportQueuedSendDelivery` takes `SendMessageResponse["delivery"]`, and its three call sites pass `result.delivery` directly.
- `EmbeddedThreadChat.tsx:491-508` calls `buildFollowUpSubmitMode` with the same arguments minus `childThreadId`.

*What disappears.*

- Four inline copies of the transaction.
- In client-core: `buildSideChatSubmitMode` and `BuildSideChatSubmitModeArgs`, and `buildFollowUpShortcutRequest` with its private support (`BuildFollowUpShortcutRequestArgs`, `FollowUpShortcutRequest`, `buildSendQueuedMessageByIdRequest`, `BuildSendQueuedMessageByIdRequestArgs`). Delete `SendQueuedMessageByIdRequest` and `QueuedMessageForSend` too if the final `git grep` finds no other users; the snapshot has none outside this file.
- Three no-op delivery mappings, ThreadDetail's dead head re-check, and its dead upload restore.

*Why this preserves behaviour.*

- The helper performs the same calls in the same order as each site does today. The draft is cleared only if it is unchanged since capture. Uploads are restored when the draft changed. The attachment error is cleared before sending. `complete()` runs on success, including the staged-timeline path. On failure, `restoreFailed` runs before the toast.
- Everything up to the first `await` inside `send` runs synchronously, so the clear and the start of the mutation still happen in the same tick as the key press.
- The only timing change is on the `"empty"` path. The queued-head steer runs one microtask later, after the helper's promise resolves, instead of synchronously. This is harmless, because the steer is already guarded by `guard: "current-head"`.
- The modifier rule is unchanged, because "draft" ⇔ non-empty input (fact 2).
- The side-chat change returns the same value, because a non-null id forwards its arguments unchanged (fact 6).
- The delivery change does not alter which toasts appear (fact 5).

*Non-goals.* Programmatic and voice submission (`submitDraftProgrammatically` in both components); `NewThreadComposer`; execution-field construction (RF-100); the outbox and staging decision (RF-053); unifying the two components' copy or the `isFollowUpSubmitting` flag; any UI change.

**Expected gain and cost**

All numbers are projections from the snapshot, not measurements.

| Item | Change in handwritten production lines (projection) |
|---|---|
| Four handlers (342 physical lines today) shrink to helper calls plus caller-specific branches | about −110 to −150 |
| New `submitComposerDraft` and its exported types | about +35 to +45 |
| `buildSideChatSubmitMode` and its argument interface | −30 (certain) |
| Three no-op delivery mappings | about −12 (certain) |
| `buildFollowUpShortcutRequest` and its private support, net of exporting `buildSteerFollowUpRequest` | about −35 |
| **Net** | **about −80 to −130** |

- **Tests:** delete the null-branch test (`threadDetailPromptSubmission.test.ts:410-434`, about 25 lines). Retarget the two non-null side-chat tests (`:436-462`) to `buildFollowUpSubmitMode` so their coverage survives. Retarget the four `buildFollowUpShortcutRequest` tests (`:23-106`): keep "steers with the selected execution options" against `buildSteerFollowUpRequest`, and move the "empty draft uses the queued head" expectation to helper or component tests. Add about 60-100 lines of direct `submitComposerDraft` tests. Test lines therefore grow slightly overall. That is intended, because the invariant gets direct coverage for the first time.
- **Mechanisms before and after:** four copies of the transaction become one; two expressions of the shortcut rule become one outcome; one wrapper with a dead branch becomes zero; three delivery mappings become zero.
- **Maintenance link:** changing restore, journal or error-toast semantics becomes one edit in a small, unit-tested module instead of four edits in two large components.
- **Performance:** expected to be neutral. The work is the same, plus one extra async frame on a key press. No measurement was taken, and none is needed for a user-input path of this size.

**Execution steps**

1. **Reconfirm.**
   - Re-run the `git grep` commands in Context, facts 1, 2 and 6, on the branch you are working on.
   - Stop and re-plan if any of these appeared since the snapshot: a new caller of `buildSideChatSubmitMode` or `buildFollowUpShortcutRequest`; a nullable `threadId` in `EmbeddedThreadChat`; a `pendingTranscript` on a modifier path; or a fifth interactive handler with the same steps.
   - If RF-100 or RF-053 has landed, adapt the `send` closures to their result.
2. **Write characterization tests on the unchanged code** (checkpoint A). Run them and confirm they pass before the refactor.
   - `apps/app/src/components/thread/embedded-chat/EmbeddedThreadChat.test.tsx`:
     - (a) The modifier shortcut with a draft sends `mode: "steer-if-active"` and clears the draft.
     - (b) A send that resolves with `delivery: "queued"` shows the "Message queued until this thread can take it…" toast.
     - (c) A send failure restores the draft and shows an error toast.
   - `apps/app/src/views/thread-detail/ThreadDetailPromptArea.test.tsx`:
     - (d) The modifier shortcut with a draft sends `steer-if-active`.
     - (e) A queue failure shows "Failed to queue message" and restores the draft.
   - Reuse each suite's existing mutation mocks; see the tests at `:572`, `:642` and `:1449`.
3. **Add the helper** (checkpoint B). Add `submitComposerDraft`, `DraftSubmissionOutcome` and an exported `ComposerAttachmentSubmission` type to `apps/app/src/lib/composer-attachment-submission.ts`. Add direct tests to `composer-attachment-submission.test.ts`, using the real `getPromptDraftAccessor` and `recoverInterruptedComposerSubmissions`, as the file already does. Cover each outcome:
   - `"empty"`: the journal is closed and `send` is not called.
   - `"changed"`: the draft was edited after capture; the uploads' `restore` is called once, the journal is closed, and nothing is cleared.
   - `"sent"`: the draft is cleared, the attachment error is cleared before `send`, and the journal is closed.
   - `"failed"`: the uploads are restored, the draft is restored, the journal is closed, and the toast receives the given copy. Mock `@/lib/mutation-errors` for this.
   - In every case, `recoverInterruptedComposerSubmissions` returns nothing afterwards, so no journal entry leaked.
4. **Migrate Embedded** (checkpoint C).
   - In `EmbeddedThreadChat.tsx`, rewrite `handleSubmit` (640-692) and `handleModifierSubmit` (722-800) as described in the end state.
   - Change `reportQueuedSendDelivery`'s parameter to `SendMessageResponse["delivery"]`, import the type from `@omnyo/server-contract`, drop the `SendMessageDelivery` import if it becomes unused, and replace the three mappings at 536, 591 and 771 with `reportQueuedSendDelivery(result.delivery)`.
   - Trim each `useCallback` dependency array to what the new body reads.
   - Run the Embedded suite.
5. **Migrate ThreadDetail** (checkpoint D).
   - In `ThreadDetailPromptArea.tsx`, rewrite `handleSend` (1533-1653) and `handleModifierSubmit` (1874-1962).
   - Export `buildSteerFollowUpRequest` from `packages/client-core/src/prompt/threadDetailPromptSubmission.ts` (it is a private function at :263), and use it in the modifier `send` closure.
   - Keep `runWhileFollowUpShortcutSending` for the queued-head path.
   - Run the ThreadDetail suites.
6. **Remove the superseded client-core machinery** (checkpoint E).
   - Replace the `buildSideChatSubmitMode` call at `EmbeddedThreadChat.tsx:491-508` with `buildFollowUpSubmitMode`, and update the import at `:91-95`.
   - Delete `buildSideChatSubmitMode`, `BuildSideChatSubmitModeArgs`, `buildFollowUpShortcutRequest`, `BuildFollowUpShortcutRequestArgs`, `FollowUpShortcutRequest`, `buildSendQueuedMessageByIdRequest` and `BuildSendQueuedMessageByIdRequestArgs`. Delete `SendQueuedMessageByIdRequest` and `QueuedMessageForSend` if `git grep` shows no remaining users.
   - Update `packages/client-core/test/threadDetailPromptSubmission.test.ts` as described in Expected gain.
   - Run the client-core suite.
7. **Close out.**
   - Format and lint the changed files.
   - Inspect the full diff for leftover old paths. `git grep -n 'clearIfCurrentMatches(' -- apps/app/src` should list only the helper, the two programmatic variants, `NewThreadComposer` and `usePromptDraftStorage`.
   - Recount the handler line totals with the same `python3` method against the 342-line baseline.

**Verification and acceptance criteria**

Commands come from the snapshot's `package.json` files. They were not run in this audit, because the snapshot has no `node_modules`.

- App tests (`apps/app` script `test` is `vitest run --config vitest.config.ts`). From `apps/app`, run `pnpm test src/lib/composer-attachment-submission.test.ts src/components/thread/embedded-chat/EmbeddedThreadChat.test.tsx src/views/thread-detail/ThreadDetailPromptArea.test.tsx src/views/thread-detail/ThreadDetailPromptArea.keystrokes.test.tsx`. All tests must pass, including the characterization tests from step 2, without editing pre-existing expectations.
- Client-core tests (`packages/client-core` script `test`). From `packages/client-core`, run `pnpm test test/threadDetailPromptSubmission.test.ts`.
- Typecheck: run `pnpm typecheck` in `apps/app` and in `packages/client-core`. Both scripts exist.
- Format and lint: from the repository root, run `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. The root scripts `format:check` and `lint` exist; the `oxlint` flags follow the global agent instructions and were not run here.
- Behaviour that must hold:
  - The draft is cleared only when unchanged since capture.
  - Uploads are restored exactly once on the changed and failed paths.
  - No journal entry survives any outcome.
  - The ThreadDetail queue failure copy stays "Failed to queue message".
  - The Embedded queued-delivery toast still appears for `delivery: "queued"` and never for `"stored"` or `"waiting"`.
  - The empty-draft modifier shortcut steers the head queued message with `guard: "current-head"`.
  - Submit-mode values in the embedded chat are unchanged.
- Manual UI check (Alex tests UI himself; this is the recipe): on a thread page and in a plugin side chat, (1) send while idle, (2) queue while active, (3) Cmd/Ctrl+Enter with a draft while active, (4) Cmd/Ctrl+Enter with an empty draft and one queued message, (5) attach a file and send, and (6) send with the network offline. Then reload and confirm that no ghost pending message is recovered.
- Structural completion:
  - `git grep -n -e buildSideChatSubmitMode -e buildFollowUpShortcutRequest` returns nothing.
  - `git grep -n '"stored" || result.delivery === "waiting"'` returns nothing.
  - Each of the four handlers calls `submitComposerDraft`, and none calls `prepareComposerAttachmentSubmission` directly.

**Rollback and stop conditions**

- **Rollback.** Each checkpoint (B through E) is a separate local commit touching only these files. No persisted format changes: the journal schema and storage keys are untouched. Reverting any commit restores the previous behaviour.
- **Stop if:**
  - a characterization test from step 2 cannot pass on the unchanged code, because the current behaviour is then not what this card assumes;
  - the helper needs a caller-specific switch beyond `send` and `failure`, such as staging, handoff or reservation flags; keep the sites inline and land only checkpoint E plus the delivery mapping change;
  - a new consumer of `buildFollowUpShortcutRequest` or `buildSideChatSubmitMode` exists, for example in mobile or a plugin;
  - RF-053 removes `stageTimelineFollowUp` in a way that changes when `complete()` must run.
- **Smaller safe alternative.** If the helper extraction stalls, checkpoint E (side-chat wrapper) and the `reportQueuedSendDelivery` type change are independent and safe on their own: about 42 production lines, Proven by inspection.
