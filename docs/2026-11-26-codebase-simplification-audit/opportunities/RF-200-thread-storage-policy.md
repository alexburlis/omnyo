# RF-200 — Give thread-storage removal one host-owned policy

## Rank and disposition

- **Potential** High reduction in policy drift. The shared policy may require a small source addition. Server-lane impact rank 2, execution order 3.
- **Confidence** High for the divergent paths, medium for the projected edit size.
- **Readiness** Conditional on a separately authorized correction of [ISS-200](../server-issues.md#iss-200--orphan-removal-bypasses-the-thread-storage-retention-check). The structural change must not silently choose between contradictory behavior.
- **Effort/risk** Medium, approximately 1–2 implementation days including focused verification. Elevated risk because the path deletes files and crosses the host protocol.
- **Dependencies** No dependency on other RF cards. Coordinate a host protocol change with the existing version gate. No deployment or deletion of actual user data is authorized by this card.

## Context and evidence

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`, inspected read-only on 26 November 2026.

`apps/server/src/services/threads/thread-storage-orphans.ts::removeOrphanedThreadStorage` finds thread-shaped directories absent from the primary database and sends `host.remove_path` with a server-computed root/path. It preserves host session identity, database/server-move maintenance gates, per-pass removal count, elapsed budget and a parked queue after uncertain outcomes.

`apps/host-daemon/src/command-handlers/thread.ts::deleteThreadStorage` derives a path from the daemon's `threadStorageRootPath`, checks `storage-retention.json`, stops processes rooted there, checks the receipt again, then removes the directory. `command-dispatch.ts` stops the associated runtime before calling it. In contrast, `command-handlers/path-mutations.ts::removeHostPath` checks containment/type and stops directory processes but has no retention check. The generic operation travels through `workspace-read-protocol.ts`, `IsolatedFilesystemMutator`, `workspace-read-child.ts` and `workspace-mutation-rpc.ts::executeFilesystemMutation`.

Consumers and counterevidence:

- Normal lifecycle deletion is constructed by `apps/server/src/services/threads/thread-commands.ts::buildThreadStorageDeleteCommand`. It requires environment/runtime metadata. An orphan has no such row. Reusing that whole lifecycle command would invent metadata or couple orphan collection to runtime ownership.
- Generic `host.remove_path` also implements user path mutations and must remain generic. It is not a globally dead API.
- `apps/host-daemon/src/thread-storage-deletion.test.ts` already exercises normal and orphan removal with child-process cleanup and preserved neighbors, but not equal receipt handling. Its process enumeration case explicitly skips Windows.
- `apps/server/test/threads/thread-storage-orphans.test.ts` covers idle admission, batching, rejection, budgets and timeout parking. `thread-storage-deletion-retention-receipt.test.ts` covers the normal retention backoff. These are separate obligations.

Inspection establishes policy divergence. Live incidence is unknown. No removal fixture ran in this audit.

## Proposed end state and preservation argument

Keep orphan discovery and lifecycle/runtime shutdown in their current owners. Give the host one internal `removeThreadStorage({ rootPath, threadId })` filesystem operation. It owns derived-path containment, root/directory symlink rejection, receipt checks on both sides of process termination and final recursive removal. The existing normal lifecycle adapter calls it after stopping the runtime.

Add an online RPC named `host.delete_thread_storage` taking only `{ threadId }` and returning `{ ok: true }`. The host derives `thread-storage` under its own configured data directory. The server cannot supply a deletion root. Route the orphan RPC through the existing isolated filesystem mutation lane. Pass the host-owned root to that child from the daemon, never from the server request. Keep `host.remove_path` for its unrelated consumers. Do not add a fallback to generic removal when an old host rejects the new command. Leave cleanup deferred behind the existing protocol gate.

Correcting orphan receipt handling and any tightened symlink behavior is an explicit correctness checkpoint under ISS-200 and requires separate correctness scope. Establish that intended contract first. The later structural extraction preserves it, including existing error text/code consumed by normal deletion backoff. No database or on-disk receipt migration is needed. Keep missing-directory semantics explicit in the two adapters if their existing return behavior differs. Do not make user path removal idempotent as a side effect.

## Expected gain and cost

Projected source change: remove roughly 25–50 production lines of duplicated derivation/process/removal responsibility and add roughly 45–90 lines of shared operation plus contract/dispatch wiring: a possible **net addition of 0–65 lines**. The value is one host-owned filesystem policy across both deletion paths. Tests may add 80–160 lines. Protocol/schema additions are production code in that estimate. Generated declarations, tests and documentation are separate. The existing server orphan queue and generic mutation operation remain.

A retention-rule change would update one host operation and its shared cases. No latency improvement is claimed. Preserve isolation and batching. Measure directory-removal/process-stop time on disposable representative trees if the extraction changes execution placement.

## Execution steps

1. Reconfirm both call paths and protocol registration in `packages/host-daemon-contract/src/commands.ts`. Stop if storage retention is now owned elsewhere or a supported older host lacks an established negotiation path.
2. Establish ISS-200's intended behavior with separate safe fixtures: retained/unretained directories, receipt appearing during process shutdown, missing directory and symlink at the directory/root. Do not characterize by deleting live storage. Preserve existing normal and orphan error semantics outside the explicit correction.
3. Add the internal operation in `apps/host-daemon/src/thread-storage-removal.ts`. Move filesystem checks and process stopping out of `deleteThreadStorage`. Keep runtime stopping in `command-dispatch.ts`.
4. Add the dedicated online descriptor/schema/result to `packages/host-daemon-contract/src/commands.ts`, its protocol compatibility treatment in `protocol.ts`, the mutation union in `workspace-read-protocol.ts`, the host-owned root input in the internal mutate request if needed, and the case in `workspace-mutation-rpc.ts`. Register the dispatch adapter using `mutateIsolatedHostCommand`.
5. Change only orphan removal dispatch to the new command. Preserve queue discovery, session matching, gates, backoff/parking and pass limits. Update request assertions in orphan tests. Remove the superseded orphan-specific path construction and duplicated filesystem work. Retain the generic API and historical contracts required by supported hosts.
6. Run the focused checks below. Inspect the complete diff and classify actual production additions/deletions separately from tests and contract generation.

## Verification and acceptance

Commands are supported by the inspected package scripts but **were not run**: the audit checkout has no `node_modules`, and installation is excluded from this audit. Run from the repository root after using the project's existing dependency setup:

```sh
pnpm --filter @omnyo/host-daemon test src/thread-storage-deletion.test.ts src/command-handlers/path-mutations.test.ts src/workspace-read-client.test.ts
pnpm --filter @omnyo/server test test/threads/thread-storage-orphans.test.ts test/threads/thread-storage-deletion-retention-receipt.test.ts
pnpm --filter @omnyo/host-daemon-contract test test/contract.test.ts test/command-result-events.test.ts
pnpm --filter @omnyo/host-daemon typecheck
pnpm --filter @omnyo/server typecheck
pnpm --filter @omnyo/host-daemon-contract typecheck
```

Both adapters must refuse a receipt before stopping/removing, recheck a late receipt, preserve neighboring processes/directories, and preserve error/backoff and timeout-parking behavior. Verify disconnected/reconnected sessions and mixed protocol versions through existing host harnesses. Run the process cleanup cases on macOS/Linux. Windows's existing skip is not Windows proof and cannot be relabeled as a pass. A Windows-specific safe test is required if process cleanup semantics change there. No UI layout/copy changes are expected. User-visible cleanup errors must remain stable outside the explicitly approved correction.

Structural acceptance: the orphan path sends no arbitrary removal path, both thread-storage adapters call the same policy operation, and no receipt-bypassing fallback remains. Generic user filesystem operations retain their contract.

## Rollback and stop conditions

Keep the correctness checkpoint and protocol/extraction checkpoint separately reviewable. Revert only the implementing change's exact files/commit after preserving foreign edits. There is no data migration, but successful file deletions cannot be rolled back by source changes. Use only disposable fixtures during verification. Stop for unresolved receipt semantics, a supported host compatibility gap, changed root ownership, symlink behavior that cannot be preserved/authorized, or slower/unbounded filesystem work in the daemon event loop. Retaining duplicate adapters temporarily is safer than falling back to generic deletion. It must have an explicit removal condition.
