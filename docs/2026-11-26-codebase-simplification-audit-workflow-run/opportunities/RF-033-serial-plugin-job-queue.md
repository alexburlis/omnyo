# RF-033 — One serial job-queue core for the plugin install and plugin update job services

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicated queue lifecycle is real, but the sweep overstated the gain, and its proposed shared route helper is not worth building (see "Rejected part of the original proposal" below).
- **Potential:** low. About 35–70 handwritten production lines disappear, and one duplicated concurrency mechanism goes with them.
- **Confidence:** high that the duplication exists (proven by inspection). Medium on the line projection.
- **Readiness:** ready. No owner decision is needed, because both wire contracts, the state names and both queue instances stay as they are.
- **Effort:** small, about half a day including the focused tests.
- **Risk:** low. The change touches two in-memory services in `apps/server`. Nothing is persisted and no public type changes. The realistic regressions are ordering and timing ones: when `run()` starts, how many `notifyChanged` calls happen, and which states count as active for deduplication.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** RF-063 (bringing plugin routes into the typed public route table) touches the same route files, `apps/server/src/routes/plugin-install-jobs.ts` and `apps/server/src/routes/plugin-update-jobs.ts`. The two changes are independent, but whichever lands second must rebase onto the other. RF-107 (routing CLI plugin commands through the SDK client) is a consumer of these routes only. None of these share savings with RF-033.
- **Why it deserves its place:** this is a small but genuine piece of duplicated knowledge. Two copies of a single-runner pump, retention window, deduplication rule and settle promise already disagree in spelling, because the retention window is a named constant in one file and an inline literal in the other. It ranks low because the benefit is modest and neither copy changes often. The snapshot history is one squashed commit, so it gives no churn evidence either way.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the audit brief was no longer present, so every file below was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. The snapshot has no `node_modules`, so no tests were run, and every behavioral claim below is **Proven by inspection**.

What the subsystem does. The server runs plugin installs and plugin updates as in-memory background jobs. Each job type has its own queue, which runs one job at a time, folds a repeated request into the active job, keeps finished jobs for 10 minutes so pollers can read the outcome, and signals the hub on every change. HTTP callers that send `Prefer: respond-async` get the job immediately with status 202 and poll it. Other callers wait for the job to settle and get the old synchronous response.

Observed duplication (both files read in full):

| Concern | Install: `apps/server/src/services/plugins/plugin-install-jobs.ts` (185 lines) | Update: `apps/server/src/services/plugins/plugin-update-jobs.ts` (131 lines) |
|---|---|---|
| Entry record | `JobEntry` lines 13–21 (`job`, `key`, `run`, `controller`, `finishedAt`, `settled`, `settle`) | `JobEntry` lines 8–14 (`job`, `run`, `finishedAt`, `settled`, `settle`) |
| Retention | `FINISHED_JOB_RETENTION_MS = 10 * 60_000` at line 9; `pruneFinished` lines 59–67 | inline `10 * 60_000` at line 39; `pruneFinished` lines 35–44 |
| Transition and settle | `update` lines 69–78, which settles when `!isActive(job)` | `update` lines 46–55, which settles when the state is `"completed"` or `"failed"` |
| Single-runner pump | `pump` lines 80–116, using `current: JobEntry \| null` | `pump` lines 57–86, using `running: boolean` |
| Start with deduplication | `start` lines 119–149, deduplicating by `targetKey(target)` (lines 35–39) among `queued`, `running` and `cancelling` | `start` lines 89–118, deduplicating by `pluginId` among `queued` and `running` |
| Read side | `settled` / `get` / `list` lines 150–162 (`get` and `list` prune; `settled` does not) | the same at lines 119–129 |
| Type-specific | `cancel` lines 163–183; an `AbortController` per entry; `runCancellableInstall` from `install-cancellation.ts:17`; an aborted rejection maps to `cancelled` | phase progress through `withPluginUpdateProgress` (`plugin-update-progress.ts:6`); `running` carries `phase`, starting at `"preparing"` |

By count, roughly 70 lines per file are the same lifecycle written twice: the entry fields, retention pruning, transition and settle, the pump skeleton, start with deduplication and settle-promise creation, and the read methods. Only the outcome mapping inside `pump` and the install-only `cancel` differ.

Consumers checked. This search ran over the whole snapshot, excluding Markdown: `git grep -n -E 'respondWithInstallJob|prefersRespondAsync|createPluginInstallJobs|createPluginUpdateJobs|PluginInstallJobs\b|PluginUpdateJobs\b|updateJobs\.|installJobs\.' e9e1b74c3 -- ':!*.md'`.

- Construction: `apps/server/src/server.ts:1545-1551` builds one instance of each queue. The install queue notifies `"plugin-install-jobs-changed"` and the update queue notifies `"plugin-update-jobs-changed"`. Routes are registered at lines 1553–1559.
- Route users: `apps/server/src/routes/plugin-catalog.ts:112-124` (catalog install), `apps/server/src/routes/plugins.ts:884-909` (update) and `apps/server/src/routes/plugins.ts:935-944` (source install).
- Wire contract: `packages/server-contract/src/api/plugins.ts:117-150` (`pluginUpdateJobSchema` and its response schemas) and `:365-403` (`pluginInstallJobSchema`, `pluginInstallJobStartResponseSchema` with `ok: true`, and `pluginInstallJobResponseSchema`).
- Client pollers that encode the active-state sets:
  - `packages/sdk/src/areas/plugins.ts:519-541` ("installAndWait", which loops while the state is `queued`, `running` or `cancelling`).
  - `packages/sdk/src/areas/plugins.ts:666-681` ("applyUpdate", which loops while the state is `queued` or `running`).
  - `apps/app/src/hooks/queries/plugin-install-job-queries.ts:34,64` and `apps/app/src/hooks/queries/plugin-update-job-queries.ts:13`.
  - `apps/cli/src/commands/plugin.ts:1356,1402`.
- Tests that construct the services: `apps/server/test/services/plugins/plugin-install-jobs.test.ts`, `plugin-update-jobs.test.ts`, `plugin-update.test.ts:400-406`, `official-plugins.test.ts:96-97`, `plugin-settings-storage.test.ts:314-419` and `apps/server/test/services/plugin-catalog/plugin-catalog-routes.test.ts:64`.

Neither service is exported from the plugin SDK or the public SDK. Both are internal to `apps/server`, so no external plugin or older client imports them. Plugins do not discover them by id or manifest, nothing persists them, and no migration refers to them.

A search for a third copy came up empty: `git grep -l -E 'finishedAt !== null' e9e1b74c3 -- apps/server/src packages` matched only these two files. That search does not prove no other job queue exists, because another one could be written differently. It does mean the shared core starts with exactly two users.

Counterevidence and current requirements:

- The queues must stay separate instances. Installs and updates are serialized independently today, so an install can run while an update runs. Per-plugin safety comes from `withLifecycleLock` inside `apps/server/src/services/plugins/plugin-service.ts` (for example at lines 783 and 837), not from these queues. Merging the queues into one instance would change throughput and ordering, so this card keeps two.
- The two job types do differ, in their state sets, cancellation and progress phases. That is why the core is parameterized by one `isActive` predicate and one `execute` hook rather than by a list of flags.

Rejected part of the original proposal. The sweep also proposed one route helper, `respondWithJob`, for both routes. The responses are too different for a shared helper to pay off:

| Response | Install (`routes/plugin-install-jobs.ts:14-34` "respondWithInstallJob") | Update (`routes/plugins.ts:896-909`) |
|---|---|---|
| 202 body | `{ ok: true, job }` | `{ job }` |
| Success | `{ ok: true, plugin }` | the raw `PluginApplyUpdateResult` |
| Failure | a caller-supplied body (`{ ok: false, error }` for a source install, `{ error }` for a catalog install), with the fallback text `"install cancelled"` | `{ error }`, with the fallback text `"update did not complete"` |

A shared helper would need three caller callbacks to replace about 10 lines of straightforward code. `prefersRespondAsync` (`routes/plugin-install-jobs.ts:5`) is already shared. The route layer therefore stays unchanged.

**Proposed end state and preservation argument**

The end state adds one new module, `apps/server/src/services/plugins/serial-job-queue.ts`. It owns everything the two services duplicate: the entries map, the 10-minute retention constant, pruning, transitions with settle-on-finish, the single-runner pump, start with deduplication by key, and `settled`, `get` and `list`. The two existing modules keep their exported names and signatures (`createPluginInstallJobs`, `PluginInstallJobs`, `createPluginUpdateJobs` and `PluginUpdateJobs`) and become thin adapters, so no caller, route or test import changes.

Core shape:

```ts
// apps/server/src/services/plugins/serial-job-queue.ts
export const FINISHED_JOB_RETENTION_MS = 10 * 60_000;

export interface SerialJobQueue<Job extends { id: string; state: string }, Context> {
  /** Returns the active job with the same key instead of queueing a duplicate. */
  start(args: { key: string; job: Job; context: Context }): Job;
  settled(id: string): Promise<Job> | undefined; // does not prune (unchanged)
  get(id: string): Job | undefined;             // prunes first (unchanged)
  list(): Job[];                                 // prunes first, insertion order (unchanged)
  /** For out-of-band transitions such as cancel; does not prune (unchanged). */
  lookup(id: string): { job: Job; context: Context } | undefined;
  transition(id: string, job: Job): void;
}

export function createSerialJobQueue<Job extends { id: string; state: string }, Context>(deps: {
  notifyChanged: () => void;
  now?: () => number;
  isActive: (job: Job) => boolean;
  /** Called synchronously from pump for the first queued job. It must set the
   *  running state itself, map every outcome to a finished job through `update`,
   *  and never reject. */
  execute: (job: Job, context: Context, update: (job: Job) => void) => Promise<void>;
}): SerialJobQueue<Job, Context>;
```

How the core behaves:

- An internal `update(entry, job)` sets `entry.job`. When `!isActive(job)`, it records `finishedAt = now()` and settles the entry's promise. It always calls `notifyChanged()`.
- `pump()` returns if a job is already current. Otherwise it takes the first entry in insertion order whose `job.state === "queued"`, marks it current, and calls `deps.execute(...)` **synchronously**. In a `.finally`, it clears the current job and calls `pump()` again.
- `start` prunes, deduplicates by `key` among active jobs, creates the settle promise, stores the entry, calls `notifyChanged()`, then calls `pump()` and returns the job.

The install adapter keeps the following:

- `targetKey`.
- Its `isActive`, which treats `queued`, `running` and `cancelling` as active.
- An `AbortController` as each entry's `Context`.
- An `execute` that first calls `update({ ...base, state: "running" })` and then runs `runCancellableInstall(controller.signal, run)`. A resolved run maps to `succeeded`. A rejected run maps to `cancelled` if `controller.signal.aborted`, and otherwise to `failed` with `error instanceof Error ? error.message : String(error)`.
- `cancel(id)`, which uses `lookup` and `transition` with exactly the current branches. A `queued` job is aborted and moves to `cancelled` without `plugin` or `error`. A `running` job is aborted and moves to `cancelling`. Every other state is returned unchanged. An unknown id returns `undefined`.

The update adapter keeps the following:

- Its `isActive`, which treats `queued` and `running` as active.
- A context holding `run`.
- An `execute` that calls `update({ ...base, state: "running", phase: "preparing" })` and then runs `withPluginUpdateProgress((phase) => update({ ...base, state: "running", phase }), async () => run())`. A resolved run maps to `completed` with `result`, and a rejection maps to `failed` with the message.

What must survive, and why it does:

- **Wire contract.** The objects stored as jobs are built by the adapters with the same fields as today, so the `PluginInstallJob` and `PluginUpdateJob` JSON is byte-identical. The routes do not change.
- **Hub events.** Each adapter passes its own `notifyChanged`, and `server.ts` is unchanged. The number and order of notifications stay the same: on `start` into an idle queue, one notification for `queued` and one for `running`. Every phase change and the finish each send one more.
- **Timing.** `run()` still starts synchronously inside `start()` when the queue is idle. This matters because `runCancellableInstall` and `withPluginUpdateProgress` both call `run` synchronously through `AsyncLocalStorage.run`. Do not insert `await` or `Promise.resolve().then` before `execute`.
- **Deduplication.** The install queue still folds a repeat into a `cancelling` job. The update queue never sees `cancelling`.
- **Retention.** Pruning still uses `finishedAt <= now() - 10 minutes`, and it still happens only in `start`, `get` and `list`, never in `settled` or `cancel`.
- **Failure propagation.** Today an exception thrown by `notifyChanged` inside the outcome handlers becomes an unhandled rejection, because the chain is `void ... .then(...).finally(...)`. The core keeps `void` plus `.finally` and does not add a catch. This preserves current behavior rather than quietly changing it.

Non-goals: merging the two queues into one instance; persisting jobs; changing the route responses; changing the SDK, app or CLI pollers; extracting a shared route helper; adding cancellation to updates.

Why this is the simplest sufficient option: one generic function with two hooks (`isActive` and `execute`) covers every difference, with no boolean switches. The smaller alternative, sharing only the retention constant, removes one spelling difference but leaves the pump, deduplication and settle logic duplicated, so it does not remove the mechanism.

**Expected gain and cost**

- **Observed baseline:** 316 handwritten production lines across the two services, counted with `git show e9e1b74c3:<file> | wc -l` (185 + 131). Route files are out of scope and stay at 69 + 23 lines.
- **Projection:** the core is about 80–90 lines including types. The install adapter shrinks to about 110–125 lines and the update adapter to about 55–70. The total lands near 245–280 lines, a **net reduction of about 35–70 handwritten production lines**. The sweep's 80–140 assumed a route-helper saving and thinner adapters than the type-specific outcome mapping allows.
- **Tests:** no line change is required, and existing tests keep their imports. A dedicated `serial-job-queue.test.ts` is optional: the two service tests already exercise serialization, deduplication, failure continuation, cancellation and retention through the adapters.
- **Mechanisms:** two single-runner pumps, two retention rules, two settle-promise constructions and two deduplication scans become one of each. The two adapters remain, each holding only its type's state names and outcome mapping.
- **Maintenance example:** changing the retention window, the settle-on-finish rule, the queue-selection order or the pump's re-entry behavior is two coordinated edits today, and the files already disagree in form. After the change it is one edit in `serial-job-queue.ts`.
- **Cost:** one new generic module, and readers of an adapter must look at the core to see the lifecycle. Both are acceptable because the core is small and has exactly two users.
- **Performance:** neutral (a hypothesis, not measured). The same list scans run at the same frequency, on queues of a handful of in-memory entries.

**Execution steps**

1. **Reconfirm.** In the checkout you will edit, run `git log --oneline -5 -- apps/server/src/services/plugins/plugin-install-jobs.ts apps/server/src/services/plugins/plugin-update-jobs.ts apps/server/src/routes/plugins.ts`. Re-read both services and confirm the line anchors above. **Re-plan** if either service has gained persistence, cross-queue coordination, cancellation for updates, or a third job type with different semantics. **Re-plan** if `isActive` or the update states have changed in `packages/server-contract/src/api/plugins.ts`.
2. **Baseline.** Run the focused tests listed under "Verification" before editing, and record that they pass. No new behavioral evidence is required, because the existing tests cover the contract. If you want an extra characterization, first add one assertion to `plugin-install-jobs.test.ts` that counts `notifyChanged` calls for a single successful job (expect 3: queued, running, succeeded). It must pass before the refactor.
3. **Add the core** in `apps/server/src/services/plugins/serial-job-queue.ts` with the signature above. Move `FINISHED_JOB_RETENTION_MS` there. Implement `start`, `settled`, `get`, `list`, `lookup` and `transition` with the pruning rules stated in the end state. `transition(id, job)` looks up the entry and calls the internal `update`, and does nothing for an unknown id.
4. **Rewrite `createPluginInstallJobs`** in `plugin-install-jobs.ts` on top of `createSerialJobQueue<PluginInstallJob, AbortController>`:
   - Keep `targetKey`, `isActive`, the `PluginInstallJobs` interface and the `start({ target, displayName, run })` signature.
   - `start` builds `{ id: randomUUID(), target, displayName, state: "queued" }` and a fresh `AbortController`. It passes `run` through the context. Either make the context `{ controller, run }`, or close over `run` in a per-job `execute`. Prefer the context form: `Context = { controller: AbortController; run: () => Promise<InstalledPlugin> }`.
   - Port `pump`'s outcome mapping into `execute` unchanged.
   - Port `cancel` onto `lookup` and `transition` unchanged.
   - Remove the local `JobEntry`, `entries`, `current`, `pruneFinished`, `update` and `pump`.
5. **Checkpoint:** run the install tests and the catalog route test, then typecheck.
6. **Rewrite `createPluginUpdateJobs`** in `plugin-update-jobs.ts` on top of `createSerialJobQueue<PluginUpdateJob, { run: () => Promise<PluginApplyUpdateResult> }>`:
   - Use `key = pluginId` and `isActive = state === "queued" || state === "running"`.
   - Port `execute` with `withPluginUpdateProgress` unchanged.
   - Remove the local `JobEntry`, `entries`, `running`, `pruneFinished`, `update` and `pump`, along with the inline `10 * 60_000`.
7. **Checkpoint:** run the update tests, then typecheck.
8. **Clean up.** Confirm that no file still declares its own retention literal or pump: `rg -n '10 \* 60_000|function pump|finishedAt' apps/server/src/services/plugins` should report only `serial-job-queue.ts`. Leave `routes/plugin-install-jobs.ts`, `routes/plugin-update-jobs.ts`, `routes/plugins.ts` and `server.ts` untouched. Format and lint the three changed files.
9. **Review and recount.** Inspect the full diff for unrelated changes. Recount with `wc -l` on the three files, and report the net change against the 316-line baseline.

**Verification and acceptance criteria**

These commands come from the snapshot's `apps/server/package.json` scripts (`test` = `vitest run --config vitest.config.ts`, `typecheck` = `tsc --noEmit`) and the root `package.json`. They were not run in this audit, because the snapshot has no `node_modules`.

- Focused tests. From `apps/server` (or the equivalent lane), run:
  `pnpm test -- test/services/plugins/plugin-install-jobs.test.ts test/services/plugins/plugin-update-jobs.test.ts test/services/plugins/plugin-update.test.ts test/services/plugin-catalog/plugin-catalog-routes.test.ts test/services/plugins/official-plugins.test.ts`
  Expected result: all pass, with no edits to their assertions. The tests that guard the behavior are these:
  - `plugin-install-jobs.test.ts`. Serial execution and folding a repeat into the active job are covered at lines 52–85. A cancelled queued job never runs (87–109). A cancelled running job settles as `cancelled` or `succeeded` (111–135). Failure messages and the exact 10-minute retention boundary are covered at 137–162. The respond-async 202, `ok: true`, the hub event, the synchronous 200 and the 404 bodies are covered at 216–285.
  - `plugin-update-jobs.test.ts`. Deduplication, queueing, the `checking` phase, and continuing after a failure.
  - `plugin-update.test.ts`. The 202 and reconnect path at 603–652, the 422 at 789–834, and serialized updates for one plugin at 836–880.
- Typecheck: from `apps/server`, `pnpm typecheck`.
- Format and lint (the global Oxc recipe): from the repository root, `pnpm exec oxlint --fix <changed files>`, `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. The root defines `format:check` (`oxfmt . --check`) and `lint` (`turbo run lint`). Running `oxlint` directly through `pnpm exec` was not confirmed against the lockfile in this audit.
- Contract checks. No change appears in `packages/server-contract`, the route files or `server.ts` (`git diff --stat` shows only the three service files). The hub event names in `server.ts:1546` and `:1550` are unchanged.
- Lifecycle checks, by review of the diff:
  - `execute` is called synchronously from `pump`.
  - `settled`, `lookup` and `transition` do not prune.
  - The install `isActive` still includes `cancelling`.
  - The queued-cancel path still produces a job without `plugin` or `error` fields.
- Structural completion: exactly one retention constant, one pump and one deduplication scan exist under `apps/server/src/services/plugins`, and each adapter contains only its key, its active-state predicate, its outcome mapping and (for installs) `cancel`.
- UI: none is affected. Performance: no measurement is required, because the work per call is unchanged.

**Rollback and stop conditions**

- Rollback boundary: one commit that touches three files in `apps/server/src/services/plugins`. Reverting it restores both services exactly, with no data or compatibility implications, because the jobs live in memory and the wire shapes do not change.
- Stop and keep the explicit copies if any of the following happens:
  - A test needs an assertion change to pass.
  - Preserving synchronous `run()` start or the notification count forces flags or branches into the core beyond `isActive` and `execute`.
  - A planned change gives one job type persistence, cross-queue serialization or update cancellation. Those would make the queues diverge, and a shared core would then fight the change.
- Safer smaller alternative if stopped: export one `FINISHED_JOB_RETENTION_MS` from `plugin-install-jobs.ts` and use it in `plugin-update-jobs.ts`. That removes the spelling difference but not the mechanism, and is not worth a separate card.
