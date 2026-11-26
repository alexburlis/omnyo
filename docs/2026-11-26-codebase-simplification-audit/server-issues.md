# Server-lane incidental findings

Inspected revision: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` on 26 November 2026. This is an audit-only backlog. No application edits, live operations, exploit reproduction, provider requests or dependency installation occurred. Existing defects are separated from the behavior-preserving simplification work.

Priorities use the audit skill's defaults: P0 is confirmed active/imminent severe impact. P1 is urgent high-impact core/reliability/security exposure. P2 is bounded correctness/reliability impact. P3 is low impact. Confidence and urgency are separate. Neither item below is an observed live incident.

## ISS-200 — Orphan removal bypasses the thread-storage retention check

- **Priority** P2, provisional exposure. The potential effect is deletion of retained storage, but the inspected trigger requires a thread-shaped storage directory missing from the primary DB and eligibility for idle orphan cleanup. No affected live directory or actual deletion was established. This evidence does not justify P0/P1 incident language.
- **Status/evidence** Proven by inspection. `apps/server/src/services/threads/thread-storage-orphans.ts::removeOrphanedThreadStorage` dispatches `host.remove_path`. `apps/host-daemon/src/command-handlers/path-mutations.ts::removeHostPath` never inspects `storage-retention.json`. The normal `command-handlers/thread.ts::deleteThreadStorage` refuses that receipt before and after process termination. Existing normal retention tests establish that a receipt is intended to hold deletion.
- **Expected versus actual** A thread-storage retention receipt should hold storage removal regardless of whether a database row remains. Currently only the normal lifecycle path has that guard. Orphan discovery checks DB membership and directory type. It omits the receipt.
- **Affected users/configurations** A host with eligible unrecorded thread-storage directories carrying receipts, including restored/retained directories. The live incidence and receipt lifecycle are unknown.
- **Safe confirmation** In a future authorized repair, use disposable synthetic directories for both dispatch paths, with a receipt present before entry and one created while a fixture child terminates. Assert refusal and preserved bytes. Do not run generic recursive deletion against user storage for diagnosis.
- **Cause/fix** Filesystem policy is split between a thread-specific lifecycle command and a generic path mutation. Add a dedicated host-owned operation for orphan storage and reuse the normal policy, as specified in [RF-200](opportunities/RF-200-thread-storage-policy.md). Preserve session gates, budgets and uncertain-outcome parking.
- **Risk/dependencies** Destructive filesystem semantics, mixed host protocol versions, root/symlink handling and process enumeration. The behavior correction must be explicitly included in implementation scope, distinct from the later extraction.
- **Verification** RF-200 names exact host/server/contract test commands and platform limits. Both paths must hold receipts, preserve neighbors and keep retry behavior. Source-only inspection is not a fixed-state runtime proof.

## ISS-201 — Callback readers classify the same source differently

- **Priority** P2. State can differ between callback APIs/prompt context and attention/work surfaces, misleading dependency handling. The effect is bounded to certain work kinds/overlapping states. No live user action or lost callback was demonstrated.
- **Status/evidence** Proven by inspection in `packages/db/src/data/thread-attention.ts`. `getCallbackSourceState` checks agent counts and native workers but ignores command/workflow counts. `readThreadAttentionFacts` includes all three background counts. The single reader checks queued interaction after error/work. The batch reader adds it to needs-input before those states. The previous audit reported a runtime fixture. That fixture was not rerun here.
- **Expected versus actual** The same callback source should have one state across supported readers. An idle source with an active command/workflow can be idle in the single reader and working in the batch reader. An error/working source with an eligible interaction-waiting queue can also receive different precedence. The underlying cause is exact. Current runtime reproduction remains unexecuted.
- **Affected consumers** `apps/server/src/routes/thread-attention.ts`, `services/interactions/thread-attention.ts`, `services/threads/thread-runtime-config.ts`, and runtime/list work projection through `thread-runtime-display.ts`. The mismatch reaches supported server consumers.
- **Safe confirmation** Extend `packages/db/test/data/thread-attention.test.ts` with a synthetic in-memory DB owner/source/callback fixture. Feed the same state through `getCallbackSourceState`, `listThreadCallbacks` and `readThreadAttentionFacts`, including command/workflow/agent/native-worker work and queued interactions overlapping active/error states. Observe the mismatch before changing policy.
- **Cause/fix** Two separately maintained fact loaders/classifiers. Agree the explicit state precedence under correction scope, then consolidate with [RF-201](opportunities/RF-201-callback-source-state.md). Do not hide the correction behind an output-neutral refactor claim.
- **Risk/dependencies** Preserve owner eligibility, null/missing/archived/deleted handling, failed queue exclusion, title/order, generation/marker/cursor semantics and 400-ID batching. No database migration is needed.
- **Verification** RF-201 gives exact focused DB/server commands and a cross-reader matrix. Acceptance requires equal states and unchanged callback lifecycle/ordering. Query counts must not regress to a per-callback loop.

## Cross-lane issue

The provider lane owns **ISS-300**, the fake backend hook registration lifecycle mismatch, and [RF-303](opportunities/RF-303-backend-hook-registration.md). Server production `plugin-api.ts::experimental_hooks.on` still calls `assertLive` before duplicate checks and storage. Do not duplicate its issue or savings here.

## Rejected as unconfirmed issues

No defect is asserted solely from generic file replacement, archive staging, watcher retries, legacy migrations or the presence fallback. These mechanisms have materially different ownership and failure contracts. Their retention/simplification dispositions are recorded in [server coverage](server-coverage.md).
