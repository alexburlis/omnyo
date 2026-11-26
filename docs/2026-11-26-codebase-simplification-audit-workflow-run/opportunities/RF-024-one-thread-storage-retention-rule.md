# RF-024 — Make the core orphan sweep use the host's thread-storage retention rule, and replace the English refusal message with a typed code

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the core host has two removal paths for thread-storage directories, and only one of them honours the `storage-retention.json` receipt. Three corrections apply to the sweep reports. First, no mixed-version compatibility work is needed, because the server rejects any daemon whose protocol version differs from its own (see Context). Second, the change adds a few production lines rather than removing them. Third, a third receipt-aware removal path exists in the Storage & Retention plugin; it is plugin-owned and stays out of scope.
- **Potential:** low as a simplification, though the change also fixes a P2 policy defect. One receipt rule and one typed refusal code replace a rule that is applied on one path only and an English message compared as a string between the host and the server.
- **Confidence:** high on the facts, all Proven by inspection; medium on the chosen design.
- **Readiness:** decision-needed. Alex must confirm that orphaned thread storage with a retention receipt is kept and not removed. Documentation already promises this, and the plugin's own orphan removal already keeps such storage, but the change alters which directories the core sweep deletes.
- **Effort:** about half a day, including a host-daemon protocol version bump and focused tests.
- **Risk:** low to medium. The work touches the host protocol and a destructive path. Retained orphans will accumulate until someone removes the receipt, which is the intended result.
- **Prerequisites:** the owner decision above. There is no code prerequisite.
- **Related and overlapping:** RF-054 (one owner for the effects of a deleted thread) touches `requestThreadStorageDeletion` in the same file, so sequence the two or rebase carefully. RF-065 (worktree deletion-safety rules shared with storage-retention) and RF-070 (Storage & Retention job runner) touch the plugin's separate removal path, which this card leaves alone.
- **Why it earns its place:** it is the only place where a documented data-protection rule, "Any `storage-retention.json` entry protects its whole storage owner", is silently bypassed. The fix is small, and it also removes a fragile coupling on a message string.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The facts below are Proven by inspection of that commit's files, read through `git show <commit>:<path>`. No test suite was run, because the snapshot has no `node_modules`.

Every thread has a per-host storage directory, `<dataDir>/thread-storage/<threadId>`. A user or an agent can place a `storage-retention.json` receipt in that directory to protect its contents from automatic cleanup. Three code paths remove these directories.

1. **Normal thread deletion (host main process).** The server calls `requestThreadStorageDeletion` (`apps/server/src/services/threads/thread-lifecycle.ts:1459`), which sends `thread.storage.delete` through `runLiveHostCommand` (around lines 1524-1531). On the host, the dispatch table runs `stopThreadRuntime` and then `deleteThreadStorage` (`apps/host-daemon/src/command-dispatch.ts:853-858`). `deleteThreadStorage` (`apps/host-daemon/src/command-handlers/thread.ts:63-92`, 30 lines) checks containment lexically with `requireContainedPath`. Its inner `requireUnretained` uses `lstat` on `storage-retention.json`, so a malformed receipt or a dangling link also counts. The function checks the receipt, calls `killProcessesWithCwdUnder`, checks the receipt again and then runs `fs.rm(..., { recursive: true, force: true })`. A refusal throws `ExpectedCommandDispatchError("command_failed", "Thread storage has a retention receipt")` (lines 82-85).
2. **The core idle orphan sweep (host mutation child).** `runThreadStorageOrphanSweep` runs every 60 seconds (`THREAD_STORAGE_ORPHAN_SWEEP_CADENCE_MS`, `apps/server/src/services/threads/thread-storage-orphans.ts:19`). It is scheduled from `apps/server/src/services/system/periodic-sweeps.ts`. `listOrphanedThreadStorage` (lines 165-206) derives `<dataDir>/thread-storage` on the server at line 169, lists it with `host.browse_directory`, and keeps the thread-shaped directory names that have no row according to `listExistingThreadIds`. `removeOrphanedThreadStorage` (lines 85-163) then sends a generic `host.remove_path { path, recursive: true, rootPath }` for each orphan (lines 128-138). On the host, `host.remove_path` runs in the isolated filesystem-mutation child: `mutateIsolatedHostCommand` (`apps/host-daemon/src/command-dispatch.ts:705`, registered at :1167) calls `executeFilesystemMutation` (`apps/host-daemon/src/workspace-mutation-rpc.ts:32`), which calls `removeHostPath` (`apps/host-daemon/src/command-handlers/path-mutations.ts:136-164`, 29 lines). `removeHostPath` refuses symbolic links, checks containment with `realpath`, refuses the root itself, kills processes and removes the directory with `force: false`. **It never reads the retention receipt.**
3. **The Storage & Retention plugin's removal (plugin host worker, out of scope).** `omnyo storage remove-orphans`, archived-file cleanup and clear-thread reach the plugin worker's `discard` handler (`plugins/storage-retention/src/host.ts:270`). That handler checks `hasRetentionReceipt` (`host.ts:92-101`) before and after killing processes. On the server side, `discard` (`plugins/storage-retention/src/storage.ts:1164`) also skips directories that hold a live environment workspace (`entriesHoldingWorkspaces`, `storage.ts:246`). The plugin throws its own copy of the message at `storage.ts:1828`. The plugin must stay forkable (`docs/forkable-plugins.md`), so it keeps its own copy of the rule. This card does not touch it.

The core sweep therefore deletes, within about a minute, a retained orphan that the plugin's explicit `remove-orphans` command refuses to delete. That contradicts three documents: `plugins/storage-retention/skills/storage-retention/SKILL.md:227-229` ("Any `storage-retention.json` entry protects its whole storage owner … Cleanup skips protected owners before stopping processes or removing files"), `docs/configuration.md:2750` ("Thread storage protected by a retention receipt remains protected") and the global storage instructions under which agents write receipts.

**How a retained orphan arises (counterevidence on exposure).** A thread row is hard-deleted only by `deleteThread` (`packages/db/src/data/threads.ts:3018`), which is called once (`thread-lifecycle.ts:3094`). That call happens after `storageDeletedAt` is set, or when the thread has no environment (lines 3076-3092). A receipt refusal keeps `storageDeletedAt` null and retries every hour (`THREAD_STORAGE_RETENTION_RETRY_MS`, line 1443), so normal deletion never orphans a retained directory. Project deletion waits until no project threads remain (`apps/server/src/services/projects/project-deletion.ts:223` "advanceProjectDeletion") before it runs `deleteProject`, so the `threads.projectId` cascade (`packages/db/src/schema.ts:632-634`) does not orphan storage either. A retained orphan therefore needs the row to disappear without a host-side deletion. Three cases cause that: the host record was destroyed (`host.destroyedAt` marks storage deleted without contacting the host, `thread-lifecycle.ts:1473-1481`) and the machine was later re-enrolled with the same data directory; a database restore; or a server move to an older database. The exposure is rare, but the loss cannot be undone.

**Message coupling.** The server recognizes a retention hold by comparing `error.body.code === "command_failed"` and `error.body.message === THREAD_STORAGE_RETENTION_RECEIPT_MESSAGE` (`thread-lifecycle.ts:1440-1457`, `isThreadStorageRetentionRefusal`). The host and the server each hold a copy of the string. If someone rewords it, a hold silently becomes a generic failure: the hourly retention retry stops, and the server logs a warning instead of one informational line. Typed codes already exist for comparable cases: `COMPETING_TURN_ERROR_CODE` and the other codes in `packages/host-daemon-contract/src/commands.ts:1517-1525`. Host error codes reach the server unchanged as `ApiError.body.code` (`apps/server/src/services/hosts/online-rpc.ts:339`).

**Version compatibility (correction to the sweep reports).** `HOST_DAEMON_PROTOCOL_VERSION` is `267` (`packages/host-daemon-contract/src/protocol.ts:1`). The server rejects a session whose `protocolVersion` differs from its own (`apps/server/src/internal/session.ts:118-136`, `protocol_version_mismatch`). A daemon and a server at different versions are therefore never connected, so a legacy-message fallback or a capability gate would be dead code. Bumping the version is enough.

**Tests that encode the current contract.**
- `apps/host-daemon/src/thread-storage-deletion.test.ts`: lines 19-118 run both cleanups, "thread deletion" and "orphan removal" via `host.remove_path`, and check process termination. Lines 128-200 check that valid, malformed and dangling-link receipts are preserved, and expect `errorCode: "command_failed"` and the English message (lines 174-177).
- `apps/server/test/threads/thread-storage-deletion-retention-receipt.test.ts` holds `RETENTION_RECEIPT_MESSAGE` at line 20 and uses `errorCode: "command_failed"` at lines 100 and 170.
- `apps/server/test/threads/thread-storage-orphans.test.ts` (465 lines) covers batching, the time budget, rejection, parking and candidate selection.
- `apps/host-daemon/src/command-handlers/path-mutations.test.ts` covers the generic `host.remove_path`.
- `packages/host-daemon-contract/test/contract.test.ts:1502-1505` pins `HOST_DAEMON_PROTOCOL_VERSION` to `265`, while the source says `267`. This looks like an existing stale assertion; see the incidental issue in the structured summary.

**Searches run** (with `git grep` at the snapshot commit):
- `storage-retention.json` outside Markdown: the core hits are only `thread.ts:75` and one test; the other hits are in the plugin.
- `has a retention receipt|retention receipt` across `apps`, `packages` and `plugins`: the hits are the host, the server, the plugin and their tests listed above.
- `host.remove_path`: the server callers are `thread-storage-orphans.ts:131` and the public file route `apps/server/src/routes/files.ts:388`, which this card leaves untouched. The remaining hits are registry sites.
- `thread.storage.delete`: one server sender (`thread-commands.ts:642`) and one host handler.

No plugin or SDK export exposes either command, but a search with no hits does not prove absence. The check that would show otherwise is a search for these command strings in the private `omnyo-plugins` repository, which was not run.

**Maintenance cost today.** Anyone who changes the receipt semantics, for example by recognising a new receipt name, has to audit every core removal route. Today one of the two core routes has already drifted. The refusal is identified by matching prose across a process boundary.

**Proposed end state and preservation argument**

What remains, and who owns it:
- **One host-owned retention rule.** A new module, `apps/host-daemon/src/thread-storage-retention.ts`, owns the receipt name, the receipt check and the check-kill-recheck-remove order. A sketch:

  ```ts
  export const THREAD_STORAGE_RETENTION_RECEIPT = "storage-retention.json";

  // Throws ExpectedCommandDispatchError(THREAD_STORAGE_RETAINED_ERROR_CODE, ...)
  // when <directory>/storage-retention.json exists in any form (lstat).
  // ENOENT means the directory is unretained; any other error is rethrown.
  export async function requireUnretainedThreadStorage(directory: string): Promise<void>;

  // check receipt -> killProcessesWithCwdUnder([directory]) -> check receipt -> remove()
  export async function removeUnretainedThreadStorage(
    directory: string,
    remove: () => Promise<void>,
  ): Promise<void>;
  ```

  Import `ExpectedCommandDispatchError` from `apps/host-daemon/src/command-errors.ts`. Both the main process and the mutation child can load that module, and `path-mutations.ts` already imports from it.
- **A typed refusal code.** `export const THREAD_STORAGE_RETAINED_ERROR_CODE = "thread_storage_retained" as const;` goes next to `COMPETING_TURN_ERROR_CODE` in `packages/host-daemon-contract/src/commands.ts`. The message text stays "Thread storage has a retention receipt" so that logs read the same.
- **`thread.storage.delete`.** `deleteThreadStorage` keeps its lexical containment and its `force: true` removal, and calls `removeUnretainedThreadStorage(storagePath, () => fs.rm(storagePath, { recursive: true, force: true }))`. Its private `requireUnretained` disappears.
- **The orphan path.** `hostRemovePathCommandSchema` (`commands.ts:661-668`, `.strict()`) gains an optional `requireUnretainedThreadStorage: z.literal(true).optional()`. When the flag is set, `removeHostPath` keeps all of its existing checks (absolute path, no symbolic link, `realpath` containment, refusal of the root). It also requires `rootPath`, a directory target and `recursive: true`. It then calls `removeUnretainedThreadStorage(target, () => fs.rm(target, { recursive: true, force: false }))` instead of its own kill-and-remove lines. Without the flag, `removeHostPath` behaves exactly as today, so the public `omnyo file remove` route is unchanged.
- **The server.** `removeOrphanedThreadStorage` sends the flag. A refusal carrying `THREAD_STORAGE_RETAINED_ERROR_CODE` is logged once at info ("Orphaned thread storage is held by a retention receipt") rather than as the generic warning. The sweep does not park on it; it moves on to the next orphan, as it already does for other `ApiError`s. Discovery, session matching, batching, the time budget, the server-move freeze and the parking rules stay as they are. `isThreadStorageRetentionRefusal` compares the code only, and the constant `THREAD_STORAGE_RETENTION_RECEIPT_MESSAGE` is deleted.
- **The protocol.** `HOST_DAEMON_PROTOCOL_VERSION` goes from 267 to 268.

Why this design is the simplest sufficient one. An alternative is a dedicated `thread.storage.remove_orphan { threadId }` online RPC, which would let the host derive the path itself. It would add six registry sites: the contract schema and descriptor, `packages/host-daemon-contract/src/session.ts`, `apps/server/src/services/hosts/wake-policy.ts`, the dispatch table, `apps/host-daemon/src/workspace-read-protocol.ts` and the switch in `workspace-mutation-rpc.ts`. The mutation child would also need the host's `threadStorageRootPath`; today it receives only `dataDir` (`command-router.ts:134-136`). The derivation benefit is partial as well, because the server still needs `thread-storage` naming to list candidates (`thread-storage-orphans.ts:169`). The flag keeps orphan removal in the isolated mutation child, which preserves today's isolation of large recursive removals from the daemon main process, and it needs one schema field. Choose the dedicated RPC only if a reviewer objects to a domain flag on a generic file command.

Preservation argument:
- Normal deletion keeps its exact semantics: the same containment, the same order of checks, the same `force: true` and the same message. Only the error code changes, from `command_failed` to `thread_storage_retained`. The one consumer of that code changes in the same commit.
- Unretained orphans are removed exactly as today: the same symbolic-link refusal, root containment, process kill and `force: false`.
- The intended behaviour change: an orphan that holds a receipt (valid, malformed or a dangling link) is kept, and the sweep moves on. This matches the documented policy and the plugin's `remove-orphans`.
- Older daemons need no compatibility work, because protocol equality already enforces upgrade together.

Non-goals:
- Do not change the symbolic-link policy of `thread.storage.delete`. Today it removes only the link and never refuses. Changing that needs its own decision.
- Do not touch the plugin's `hasRetentionReceipt`, its `discard` handler or its message copy at `storage.ts:1828`; forkability requires the plugin to keep its own copy.
- Do not add the plugin's live-workspace exclusion to the core sweep here. It is recorded separately as a suspected issue.
- Do not move orphan discovery onto the host.

**Expected gain and cost**

These figures are projections, not measurements.

- **Production lines.** The new module adds about 30 lines. `thread.ts` loses about 15 (the inner `requireUnretained` and the separate kill and recheck lines). `path-mutations.ts` gains about 10 and loses the 4 lines of its own kill branch on the flagged path. The contract gains about 3, the orphan sweep about 8, and `thread-lifecycle.ts` loses about 3. The net is roughly +15 to +30 production lines. **This change does not reduce line count.**
- **Tests.** Expect about +40 to +60 lines for the new retained-orphan cases and code assertions.
- **Mechanisms.** Core removal routes for thread storage that apply the receipt rule go from one of two to two of two, and both share one implementation. Copies of the refusal string compared across the host-server boundary go from two to zero: a typed code replaces them.
- **Maintenance.** A change to the receipt rule becomes one edit in `thread-storage-retention.ts`. Rewording the refusal message can no longer disable the hourly retention retry.
- **Performance.** Each orphan removal adds two `lstat` calls on the host. Orphan sweeps are limited to 100 removals and 10 seconds per pass, so the effect is expected to be negligible. This was not measured.
- **Unknown.** Whether any private plugin sends `host.remove_path` against thread storage or matches the English message. See the stop conditions.

**Execution steps**

1. **Reconfirm the anchors and get the owner decision (the gate).** On the current `main`, re-read the symbols named under Context. Confirm three facts: `removeHostPath` still lacks a receipt check, `isThreadStorageRetentionRefusal` still compares the message, and `session.ts` still rejects any protocol mismatch. Obtain the owner's confirmation that retained orphans are kept. **Stop and re-plan** in any of these cases: Alex wants orphans always removed (then do only the typed-code part, steps 3, 5 and 6); the server has started accepting a range of protocol versions (then a legacy fallback is needed); or RF-054 has already moved `requestThreadStorageDeletion`.
2. **Write the failing regression test first.** In `apps/host-daemon/src/thread-storage-deletion.test.ts`, extend the receipt test at lines 128-200 with an `it.for([...])` axis over `"thread deletion"` and `"orphan removal"`. The orphan case dispatches `host.remove_path` with `requireUnretainedThreadStorage: true`, `recursive: true` and `rootPath`, through an `IsolatedFilesystemMutator`, as the test at lines 70-101 does. For valid, malformed and dangling-link receipts, assert three things: `errorCode: "thread_storage_retained"`, the `evidence` file survives, and `logger.warn` is not called. Run the test and watch the orphan case fail, because today it removes the directory. This only becomes red after step 3 adds the schema field; until then, the strict schema rejects the flag. So for the first red run, assert the current behaviour without the flag: the directory is removed even though it has a receipt.
3. **Contract.** In `packages/host-daemon-contract/src/commands.ts`, add `THREAD_STORAGE_RETAINED_ERROR_CODE` beside `COMPETING_TURN_ERROR_CODE` (around line 1517) and export it through the package entry the same way. Add `requireUnretainedThreadStorage: z.literal(true).optional()` to `hostRemovePathCommandSchema` (lines 661-668). In `packages/host-daemon-contract/src/protocol.ts`, bump `HOST_DAEMON_PROTOCOL_VERSION` to 268. In `packages/host-daemon-contract/test/contract.test.ts:1503`, set the pinned value to 268; this also repairs the stale 265 pin.
4. **Host rule.** Create `apps/host-daemon/src/thread-storage-retention.ts` with the two functions sketched under the end state. In `apps/host-daemon/src/command-handlers/thread.ts`, replace the inner `requireUnretained`, the kill, the recheck and the `fs.rm` in `deleteThreadStorage` with a single `removeUnretainedThreadStorage` call, and drop the now-unused `killProcessesWithCwdUnder` import if nothing else uses it. In `apps/host-daemon/src/command-handlers/path-mutations.ts`, add the flagged branch to `removeHostPath` after the root-equality check. If `root === null`, or the target is not a directory, or `recursive` is false, throw `CommandDispatchError("invalid_path", ...)`. Otherwise call `removeUnretainedThreadStorage(target, () => fs.rm(target, { recursive: true, force: false }))` and return `{ ok: true }`. Leave the unflagged path byte-for-byte unchanged. **Checkpoint:** the step 2 test passes, the existing "orphan removal" process-termination case at lines 19-118 still passes, and `path-mutations.test.ts` passes unchanged.
5. **Server.** In `apps/server/src/services/threads/thread-lifecycle.ts`, delete `THREAD_STORAGE_RETENTION_RECEIPT_MESSAGE` (lines 1440-1441). Make `isThreadStorageRetentionRefusal` return `error instanceof ApiError && error.body.code === THREAD_STORAGE_RETAINED_ERROR_CODE`, importing the constant from `@omnyo/host-daemon-contract`. In `apps/server/src/services/threads/thread-storage-orphans.ts`, add `requireUnretainedThreadStorage: true` to the command at lines 130-135. In the `catch` block, check the retained code before the generic `warn`: log at info with `{ hostId, threadId }` and `continue`, without parking.
6. **Tests and docs.**
   - Update `apps/server/test/threads/thread-storage-deletion-retention-receipt.test.ts`. Use `errorCode: THREAD_STORAGE_RETAINED_ERROR_CODE` at lines 100 and 170. Keep the message text so that the existing log assertions stay meaningful.
   - Add a case to `apps/server/test/threads/thread-storage-orphans.test.ts`, modelled on the "continues removing orphaned directories after a removal fails" test at line 146. The responder returns `{ ok: false, errorCode: "thread_storage_retained", ... }` for one path. Assert four things: the next orphan is still attempted, the queue is not parked, one info line is logged, and no warning is logged. Also assert that every `host.remove_path` request carries `requireUnretainedThreadStorage: true`.
   - Update the docs that describe orphan cleanup: `docs/configuration.md:2750` (add that the idle orphan sweep also skips owners with a receipt), `plugins/storage-retention/skills/storage-retention/SKILL.md:227-229`, `packages/templates/src/templates/omnyo-guide-threads.md:837-841` and `plugins/omnyo-guide/skills/omnyo-cli/references/thread-operation.md:368-372`. Check whether `plugins/omnyo-guide/...` is generated from `packages/templates`; if it is, edit only the source and regenerate it through its own script.
7. **Final review.** Run the verification below and read the whole diff. Confirm with `rg -n "Thread storage has a retention receipt" apps packages` that the message survives only as the host's message text and in tests, not in any server comparison. Confirm with `rg -n "storage-retention.json" apps packages` that the core has only the one constant. Recount production lines against this card's projection.

**Verification and acceptance criteria**

All commands run from the repository root, `$OMNYO_CHECKOUT`, after `pnpm install`. The script names were confirmed in each package's `package.json` at the snapshot. The single-file `exec vitest run <file>` form is the normal Vitest command-line usage; it was not run here.

- `pnpm --filter @omnyo/host-daemon exec vitest run --config vitest.config.ts src/thread-storage-deletion.test.ts src/command-handlers/path-mutations.test.ts` passes. The new retained-orphan cases fail before step 4 and pass after it.
- `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/threads/thread-storage-orphans.test.ts test/threads/thread-storage-deletion-retention-receipt.test.ts` passes.
- `pnpm --filter @omnyo/host-daemon-contract test` passes, including the pinned version 268.
- `pnpm --filter @omnyo/host-daemon typecheck`, `pnpm --filter @omnyo/server typecheck` and `pnpm --filter @omnyo/host-daemon-contract typecheck` pass.
- Format and lint: run `pnpm exec oxfmt <changed files>` and then `pnpm exec oxlint --deny-warnings --format=agent`, following the repository's Oxc setup. The root `format:check` script is `oxfmt . --check`.

Behavioural acceptance:
- Normal deletion: an unretained directory is removed and its processes are terminated. A retained directory (valid, malformed or dangling link) survives, and the refusal carries `thread_storage_retained` and today's message. The server keeps the hourly retry and logs "held by a retention receipt" once.
- Orphan sweep: an unretained orphan is removed as before. A retained orphan survives with no host warning and one server info line, and the sweep continues with the next candidate. Timeouts and `host_demo` still park the queue.
- A receipt that appears between the first check and the process kill is caught by the second check, so nothing is removed. To test this, add a `killProcessesWithCwdUnder` spy that writes the receipt; this is optional but recommended.
- The unflagged `host.remove_path` (the public file route) behaves as before, which `path-mutations.test.ts` shows unchanged.

Structural completion:
- One receipt implementation exists in core host code, and `thread.ts` no longer contains a private copy.
- No server code compares the refusal message.
- The protocol version is bumped, and the docs state that the sweep honours receipts.

Performance: no benchmark is required. The added cost is two `lstat` calls per orphan within the existing pass limit of 100 removals.

**Rollback and stop conditions**

- **Rollback boundary.** Make one commit covering the contract, the host, the server, the tests and the docs. Reverting it restores today's behaviour. The change involves no persisted data and no migration. A reverted server and daemon must still ship together, as with any protocol bump.
- **Stop if** Alex decides orphans must always be removed. In that case drop the flag and keep only the typed code (steps 3, 5 and 6, without the orphan-sweep flag).
- **Stop if** the server starts accepting a range of protocol versions before this lands. A legacy-message fallback is then required, with a removal condition such as the minimum accepted version passing 268.
- **Stop if** a search of the private `omnyo-plugins` repository finds a consumer that matches `"command_failed"` plus the English message for `thread.storage.delete`, or that sends `host.remove_path` into thread storage. Change that consumer in the same series, or keep the message comparison alongside the code for one release.
- **Stop if** a reviewer rejects a domain flag on the generic `host.remove_path`. Switch to the dedicated `thread.storage.remove_orphan` RPC described under the end state, and pass `threadStorageRootPath` into `IsolatedFilesystemMutator`.
- **Stop if** routing the receipt check through the mutation child causes a module-boundary problem (for example, the child bundle cannot import `command-errors.ts`). Put the helper in a module that the child bundle already includes, rather than moving orphan removal into the main process.
