# RF-131 — Define project-checkout's branch-switch blocker order and reasons once, for the picker and the validate pre-check

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but it is smaller than the sweep reported, and the two copies disagree in a way that matters for a common Git state.
- **Potential:** low. About 92 handwritten production lines of rule code across two files become about 70 to 80 lines. One precedence order and one set of five reason strings disappear.
- **Confidence:** high that the duplication and the disagreement exist (proven by inspection, with one Git behaviour reproduced). Medium on the exact line savings, which are a projection.
- **Readiness:** conditional. Choosing one order changes the server's refusal message whenever several blockers apply at once. Alex needs to accept that copy change (gate G1 below).
- **Effort:** small. Two to three hours, including tests.
- **Risk:** low. Only the reason text changes, and only in states with more than one blocker. The rule is plugin-local, has no SDK export and has no external consumer.
- **Prerequisites:** none. RF-062 is related but optional (see below).
- **Related or overlapping items:**
  - RF-062 ("Share checkout-ref, git-operation and dirty-state inspection through createGitQueries") would replace this plugin's `host/git.ts` inspectors. If RF-062 lands first, the server's inspection shape may move to the `@omnyo/domain` types the app already uses, and the adapter in step 4 gets smaller. Each item can land without the other.
  - The host check (`host/checkout.ts` "assertSwitchable") has the same order problem. This card keeps it out of scope; see the new issue in the summary.
- **Why it deserves a place:** a small but real single-owner win. Today a new blocker means editing two functions in two files and keeping two string sets identical. The server's current order also gives the wrong reason during a rebase (reproduced below). The gain is too small to rank above the mechanism removals in this audit.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The worktree named for this audit did not exist when this card was written. Every file was therefore read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`.

The Project Checkout plugin (`plugins/environment-project-checkout`) runs a thread in the project's own checkout and can create or switch a branch first. A branch switch is refused when the checkout cannot safely change branches. Three places check this. Two of them, the picker and the validate pre-check, are the subject of this card.

1. **App picker (UX feedback before submit).** In `plugins/environment-project-checkout/app.tsx`, "operationName" (lines 102-117) and "checkoutBlocker" (lines 119-184) take the SDK `CheckoutState` (`packages/plugin-sdk/src/app-contract.ts:3756`). The app fills that state in `apps/app/src/components/plugin/usePluginBranchPickerState.ts` "usePluginCheckoutState" from the core project-branches query, which `apps/host-daemon/src/command-handlers/host-branches.ts` answers (lines 308-332: checkout, hasUncommittedChanges, operation). The function returns `{label, reason, guidance}` and checks, in order:
   - `isGit === null`, which returns "Checking" (a loading state, not a Git rule);
   - `!isGit`, which returns "Unknown" with "Checkout state is unavailable";
   - an operation with conflicts, which returns "Checkout blocked by unresolved conflicts";
   - any other operation, which returns `Checkout blocked by an in-progress ${name.toLowerCase()}`;
   - dirty, which returns "Checkout blocked by uncommitted changes";
   - detached, which returns "Checkout blocked while HEAD is detached";
   - unborn, which returns "Checkout blocked before the first commit".

   The caller "CheckoutInputsControl" (`app.tsx:363-377`) sends `onChange({status: "blocked", reason})` when a branch is selected. `apps/app/src/components/pickers/machine-provider-inputs.tsx:92` turns that into the composer's `blockedReason`. `app.tsx:569-602` disables the New branch and Checkout intents, uses `reason` as their `title` and shows `guidance` in a `role="status"` element.
2. **Server validate pre-check (authoritative refusal before the attach call).** In `plugins/environment-project-checkout/server.ts`, the constants `DETACHED_MESSAGE`, `UNBORN_MESSAGE`, `CONFLICTS_MESSAGE` and `DIRTY_MESSAGE` (lines 31-37) and the nested function "branchSwitchBlocker" (lines 104-159) call the plugin host's `inspectCheckout` (`contract.ts:58-70`, `CheckoutInspection`). The function checks, in order:
   - a failed inspection or a non-Git path, which accepts and defers to the host;
   - an existing target equal to the current or unborn branch, which accepts (the same-branch exemption);
   - detached, which refuses;
   - unborn, which refuses;
   - an `unknown` checkout, which accepts;
   - conflicts, which refuse;
   - an operation, which refuses with `Checkout blocked by an in-progress ${operation.kind}`;
   - dirty, which refuses.

   Its only caller is `validate` (`server.ts:289-297`).
3. **Host locked check (trust boundary, out of scope).** `plugins/environment-project-checkout/host/checkout.ts:58-125` "assertSwitchable" uses different strings ("Cannot checkout branch while …") with `WorkspaceError` codes. The order is: same-branch, detached, unborn, unknown (throws), missing branch, conflicts, operation, dirty. It runs under the checkout mutation lock and reads Git lazily. It stays.

Observed facts (proven by inspection unless stated otherwise):

- The app and the server use five identical reason strings: the four constants at `server.ts:31-37` and the template at `server.ts:151`, which match `app.tsx:141`, `:151`, `:159`, `:168` and `:177`. Search: `git grep -n "Checkout blocked\|checkoutBlocker\|branchSwitchBlocker" e9e1b74c3 -- .` finds them only inside this plugin. No docs, SDK, CLI or other plugin references them. `checkoutBlocker` is exported from `app.tsx`, but nothing imports it; `app.test.tsx` tests it through the rendered slot.
- **The orders disagree.** The app puts operations and dirty state first and detached and unborn last. The server puts detached and unborn first and operations and dirty state last. These states can show different reasons:
  - detached plus an operation;
  - detached plus dirty;
  - unborn plus dirty.
- **Reproduced:** during a conflicted `git rebase` (run in a disposable repository under `$TMPDIR`, since deleted), `.git/rebase-merge` exists, `git symbolic-ref --quiet --short HEAD` exits 1, HEAD still resolves to a SHA and `git status --porcelain=v1` shows `AA f`. So `host/git.ts:35-64` "getCheckoutRef" returns `{kind: "detached"}` during every rebase. The server's "branchSwitchBlocker" then refuses with "Checkout blocked while HEAD is detached". The app's order shows "Checkout blocked by unresolved conflicts", or "an in-progress rebase" when there is no conflict. That reason is the actionable one.
- The intended differences are real and must survive:
  - The app's "Checking" and "Unknown" states. The server instead accepts unknown or failed inspections and lets the host throw `checkout_unknown`.
  - The server's same-branch exemption. The app does not apply it, because it disables the Checkout intent as a whole.
  - The app's `label` and `guidance` copy, which the server lacks.
  - The operation sets differ. The SDK `WorkspaceGitOperation` (`packages/domain/src/git-checkout.ts:79-104`) includes `unknown` (named "Operation" in the app). The plugin contract's set (`contract.ts:46-54`) does not.
- The current requirement behind keeping two call sites is sound: UX feedback before submit (app) and a refusal before attaching (server). Only the rule, its order and its strings are duplicated.
- Tests that encode the contract:
  - `app.test.tsx:218-255` covers the dirty-only state: the reason, the disabled title and the guidance.
  - `server.test.ts:180-275` covers dirty only; detached only; branch plus rebase plus dirty, expecting "in-progress rebase"; branch plus merge-with-conflicts plus dirty, expecting "unresolved conflicts"; and the dirty same-branch exemption.
  - No existing test covers detached or unborn combined with another blocker. Every existing test therefore passes under either order.

Maintenance cost today: a new blocker (for example a sparse or bisect state) or a wording change means editing "checkoutBlocker" and "branchSwitchBlocker" separately and keeping two string sets in step. The order has already drifted, with the user-visible result reproduced above.

Line count (command: `sed -n 'A,Bp' <file> | grep -cv '^\s*$'` over the exported snapshot files). These are handwritten production lines:

| Region | Total lines | Non-blank lines |
| --- | --- | --- |
| `app.tsx:102-117` "operationName" and `app.tsx:137-181` (the Git rules in "checkoutBlocker") | 61 | about 54 |
| `server.ts:31-37` constants and `server.ts:135-158` (the rule body of "branchSwitchBlocker") | 31 | 24 |
| Duplicated rule code in scope | 92 | about 78 |

Out of scope: `app.tsx:120-135`, the Checking and Unknown states (16 lines, which stay); `server.ts:104-134`, the inspection call and the same-branch exemption (which stay); and `host/checkout.ts:58-125` (68 lines, which stay).

**Proposed end state and preservation argument**

A new plugin-local module, `plugins/environment-project-checkout/branch-switch-blocker.ts`, owns the Git blocker order and the reason strings. It has no imports. Both `app.tsx` and `server.ts` already import plugin-local modules (`./provider-id.js`, `./contract.js`), so this is not a sibling-plugin import and keeps the plugin forkable (`docs/forkable-plugins.md`).

```ts
export type BranchSwitchOperation =
  | { kind: "none" }
  | { kind: "merge" | "rebase" | "cherry-pick" | "revert" | "unknown"; hasConflicts: boolean };

export interface BranchSwitchFacts {
  detached: boolean;
  unborn: boolean;
  dirty: boolean;
  operation: BranchSwitchOperation;
}

export type BranchSwitchBlocker =
  | { kind: "conflicts" }
  | { kind: "operation"; operation: Exclude<BranchSwitchOperation["kind"], "none"> }
  | { kind: "dirty" }
  | { kind: "detached" }
  | { kind: "unborn" };

// One order: conflicts, operation, dirty, detached, unborn (the app's order today).
export function branchSwitchBlocker(facts: BranchSwitchFacts): BranchSwitchBlocker | null;

// "Merge", "Rebase", "Cherry-pick", "Revert", "Operation" (moved from app.tsx "operationName").
export function operationDisplayName(kind: Exclude<BranchSwitchOperation["kind"], "none">): string;

// The five existing strings, byte for byte, with the operation reason built from
// operationDisplayName(kind).toLowerCase().
export function branchSwitchBlockerReason(blocker: BranchSwitchBlocker): string;
```

What remains, and where:

- `app.tsx` "checkoutBlocker" keeps its Checking and Unknown branches. It then calls `branchSwitchBlocker({detached, unborn, dirty, operation})` on the SDK state and maps the result to `{label, reason: branchSwitchBlockerReason(b), guidance}`. A small `switch` keeps the existing label and guidance strings unchanged.
- `server.ts` "branchSwitchBlocker" keeps the inspection call, the failure and non-Git acceptance, the same-branch exemption and `unknown → null`. It then returns `reason` from the shared function, with `detached: checkout.kind === "detached"`, `unborn: checkout.kind === "unborn"`, `dirty: inspection.hasUncommittedChanges` and `operation`. The four message constants disappear. `LIVE_THREAD_MESSAGE` stays because it is not a Git rule. Rename the nested server function (for example to "inspectBranchSwitchBlocker") so that it does not shadow the import.
- `host/checkout.ts` "assertSwitchable" is unchanged. It is the locked trust-boundary check with its own error codes and lazy Git reads.

Why the app's order wins: it names the in-progress operation, which is the actionable fact, instead of reporting "HEAD is detached" while a rebase is running. If the server's order won instead, the app would show the label "Detached" and the guidance "Attach HEAD to a branch…" during a rebase, which misleads.

Preservation:

- **Unchanged:** every single-blocker state, which includes every currently tested state, on both surfaces; all `label` and `guidance` copy; the Checking and Unknown states; the server's same-branch exemption; its acceptance of unknown or failed inspections; and the host check.
- **Intentionally changed (gate G1):** the server's refusal reason when detached or unborn is combined with an operation or with dirty state. It changes from "…while HEAD is detached" or "…before the first commit" to the operation, conflicts or dirty reason, which matches what the picker already shows. This is a visible copy change on the server refusal path. App users rarely see it, because the picker blocks first. Callers outside the picker (Hypothesis: CLI or SDK thread creation with branch inputs, or a stale picker state) do see it. The app's displayed copy does not change.
- **Performance:** neutral. The function is pure and synchronous over facts both callers already have. No new Git calls are added.

Non-goals:

- Changing "assertSwitchable", its strings, its codes or its order.
- Adding the same-branch exemption to the app.
- Unifying the app's unavailable-state policy with the server's.
- RF-062's inspection sharing.

**Expected gain and cost**

- Removed (projection): the server's four message constants and its 24-line rule body; the app's five reason literals and their order logic; and the duplicate `operationName`.
- Added (projection): the shared module, about 40 lines, plus an app label and guidance mapping of about 25 lines.
- Net: about 92 rule lines become about 70 to 80, a net reduction of about 10 to 25 handwritten production lines. The sweep's estimate of 30 to 50 lines is overstated, because the app's label and guidance copy must stay.
- Mechanisms: two orderings and two string sets for the app and server become one, and the host keeps its own.
- Tests: about 20 to 40 added lines, for one unit test file and one or two server cases.
- Maintenance effect: a new Git blocker, or a wording change, is a single edit in `branch-switch-blocker.ts`, plus guidance copy in the app and, if wanted, the host check. The picker and the refusal cannot drift again.
- Cost: one more module in the plugin, and a small adapter in each caller.

**Execution steps**

1. **Reconfirm.** At the target commit, check that `app.tsx` "checkoutBlocker", `server.ts` "branchSwitchBlocker" with its constants and `contract.ts` `workspaceGitOperationSchema` still match the Context section. Run `git grep -n "Checkout blocked" -- .` from the repository root and confirm the hits are still only in `plugins/environment-project-checkout`. If RF-062 has landed, use the inspection types it produced in step 4. Re-plan if any of the following holds:
   - a new consumer of these strings exists outside the plugin;
   - the server's order is now relied on by a test or document;
   - the app no longer receives `operation` from the core branches query (`apps/host-daemon/src/command-handlers/host-branches.ts`).
2. **Gate G1 (decision).** Ask the owner to accept that the server refusal will use the picker's order. This changes the refusal reason only for detached or unborn checkouts that also have an operation or uncommitted changes, including every rebase. If Alex declines, stop and ship nothing: sharing only the strings would save about 4 lines and is not worth a module.
3. **Characterise first.** Add these cases to `server.test.ts`, inside the existing validate `describe` that uses "validateWith":
   - (a) `checkout: {kind: "detached"}` with `operation: {kind: "rebase", hasConflicts: true}` and `hasUncommittedChanges: true`, which expects "Checkout blocked by unresolved conflicts";
   - (b) `checkout: {kind: "detached"}` with `hasUncommittedChanges: true` and operation none, which expects "Checkout blocked by uncommitted changes".

   Both fail at the snapshot, because the server reports "HEAD is detached". Watch them fail before step 4. Then add `branch-switch-blocker.test.ts` covering:
   - each single blocker and its exact reason;
   - each operation kind, including `unknown`, which gives "an in-progress operation";
   - the precedence chain conflicts, then operation, then dirty, then detached, then unborn.
4. **Edits.**
   - Create `plugins/environment-project-checkout/branch-switch-blocker.ts` with the signature above. Move "operationName" there as "operationDisplayName", keyed by operation kind. Copy the five reason strings exactly from `app.tsx:141-177`.
   - In `app.tsx`, delete "operationName" (lines 102-117). Replace lines 137-181 in "checkoutBlocker" with a call to `branchSwitchBlocker({detached: state.detached, unborn: state.unborn, dirty: state.dirty, operation: state.operation})`, followed by a `switch (blocker.kind)` that returns the existing `label` and `guidance` strings unchanged. The operation case uses `operationDisplayName(...)` for the label and builds the guidance from its lowercase form. Set `reason` from "branchSwitchBlockerReason".
   - In `server.ts`, delete `DETACHED_MESSAGE`, `UNBORN_MESSAGE`, `CONFLICTS_MESSAGE` and `DIRTY_MESSAGE`. Rename the nested function to "inspectBranchSwitchBlocker". Keep lines 109-133 as they are, and keep `if (checkout.kind === "unknown") return null;`. Replace the remaining body with the shared call and `branchSwitchBlockerReason`. Update the call at line 289.
   - Checkpoint: `pnpm --filter omnyo-plugin-environment-project-checkout typecheck`.
5. **Clean up.** Confirm that no "Checkout blocked" literal remains in `app.tsx` or `server.ts`, and that `checkoutBlocker` keeps its `export` only if a test imports it.
6. **Verify and recount.** Run the checks below, read the full diff for unrelated changes and recount the lines changed in `app.tsx`, `server.ts` and the new module against the baseline in Context.

**Verification and acceptance criteria**

Run every command from the repository root. The plugin's `package.json` defines the `test` and `typecheck` scripts; the root `package.json` defines `check:plugin-forks`.

- `pnpm --filter omnyo-plugin-environment-project-checkout test`. All existing tests in `app.test.tsx`, `server.test.ts` and `host.test.ts` pass with their assertions unchanged. The step 3 server cases fail before the edit and pass after it. The new unit tests pass.
- `pnpm --filter omnyo-plugin-environment-project-checkout typecheck` passes.
- `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>`. The repository has `.oxfmtrc.json` and `.oxlintrc.json` at its root.
- `pnpm run check:plugin-forks` (root script `scripts/check-plugin-forks.mjs`) passes. This confirms the new module keeps the plugin forkable. The script's exact checks were not read for this card.
- Behaviour and contract:
  - the app's blocked `reason`, the disabled `title` and the `role="status"` guidance are byte-identical for every single-blocker state;
  - the server's same-branch exemption still accepts a dirty checkout (`server.test.ts` "accepts a dirty checkout when the branch is already the current one");
  - unknown or failed inspections are still accepted by validate.
- UI: no layout or style change. The existing `app.test.tsx` dirty test is the guard. Alex tests the picker by hand if he wants; no screenshot round is needed.
- Structural completion: one precedence order exists for the app and server, in `branch-switch-blocker.ts`, and no duplicate reason literals remain. The test suites could not be run for this card, because the snapshot has no `node_modules`.

**Rollback and stop conditions**

- Rollback: the change touches four files in one plugin (the new module and its test, `app.tsx` and `server.ts`) plus `server.test.ts`. Revert that one commit. No persisted data, migration, SDK export or wire contract is involved.
- Stop if any of the following holds:
  - Alex declines gate G1;
  - a consumer outside the plugin matches on the server's refusal strings or their order (re-run the step 1 search, including the CLI and `packages/sdk`);
  - the app's `CheckoutState` stops carrying `operation`;
  - keeping the app's label and guidance copy byte-identical would need more mapping code than the copies it removes (net gain under about 10 lines). In that case, record RF-131 as not worth doing, rather than shipping a module that only moves code.
