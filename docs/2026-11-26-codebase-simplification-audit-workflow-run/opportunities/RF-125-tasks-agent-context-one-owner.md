# RF-125 — One store query for "every attachment of a task" and one set of agent-facing Tasks section formatters

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. The sweep overcounted the attachment-set definitions: there are three full definitions in production code, not four. The store's `listAttachmentsForTaskComments` is a building block used by one RPC branch, not a fourth definition.
- **Potential:** low. About 45 to 60 handwritten production lines leave one plugin, and two copies of the same prompt knowledge that have already drifted become one. The delete paths lose an N+1 query pattern.
- **Confidence:** high on the facts (Proven by inspection). Medium on the line projection, which is not measured.
- **Readiness:** decision-needed for the formatter half, because unifying the drifted wording changes the text that agents receive. The attachment-query half (checkpoint A) is ready now and can ship on its own.
- **Effort:** small, about 2 to 3 hours including tests.
- **Risk:** low. Both outputs are agent prompts, and two tests pin their exact text. The blob cleanup in `deleteProject` and `deleteTask` must still cover attachments on comments.
- **Prerequisites:** none. All code is inside `plugins/tasks`, so the forkable-plugin rule in `docs/forkable-plugins.md` is not affected.
- **Related or overlapping RF ids:** none overlap. RF-046 (Tasks status and priority glyph module) and RF-069 (Tasks CLI domain calls) touch the same plugin but different code.
- **Why it deserves its place:** it is cheap and safe, and it removes duplicated knowledge that has already diverged. Adding a field to the agent context today, such as attachment size, needs the same edit in two formatters and up to three attachment queries.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had been removed when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b…:<path>`.

The Tasks plugin gives an agent a Markdown summary of a task in two places:

1. **Delegation seed prompt.** `plugins/tasks/delegate/index.ts:102` "buildSeedPrompt" builds the first prompt of a worker thread spawned by the `delegate` RPC (`handlers` at `:317`, call at `:339`).
2. **Mention context.** `plugins/tasks/mentions/index.ts:139` "buildTaskContext" builds the context that the `task` mention provider returns from `resolve` (`registerMentions` at `:201`).

Both render the same three sections with their own private copies of the formatters (Proven by inspection):

| Section | Delegate copy | Mention copy | Drift |
|---|---|---|---|
| Sub-tasks | `delegate/index.ts:69` "formatSubtasks": `- KEY · title (in_progress)` | `mentions/index.ts:92` "formatSubtasks": `- KEY · title — In Progress` | raw status in parentheses versus `displayName` after an em dash |
| Attachments | `delegate/index.ts:77` "formatAttachments": `- fileName · id` | `mentions/index.ts:103` "formatAttachments": `- id · fileName` | field order is swapped; the `Fetch with:` line is identical |
| Comments | `delegate/index.ts:91` "formatComments": `### author · user · createdAt` | `mentions/index.ts:117` "formatComments": `### author · User · createdAt` | raw kind versus `displayName(kind)` |

Only the mention context has `formatThreads` (`mentions/index.ts:128`) and the "Task details" block. Only the seed prompt has "Project context", "Preset instructions" and "Additional instructions". Both use the last five comments (`delegate/index.ts:328` `comments.slice(-5)`; `mentions/index.ts:15` `RECENT_COMMENT_LIMIT = 5`). The two action contracts ("Report-back contract" and "Action contract") differ on purpose: a delegated worker is already attached, while a mentioning agent must run `omnyo tasks attach` first.

"Every attachment of a task, including attachments on its comments" is computed three ways (Proven by inspection):

| Definition | Queries | Order |
|---|---|---|
| `delegate/index.ts:179` "collectAttachments" | `listAttachmentsForTask` plus one `listAttachmentsForComment` per comment, then de-duplicates by id in a `Map` | task attachments first, then comment attachments in comment order (`created_at, rowid`) |
| `mentions/index.ts:75` "attachmentManifest" (plus the `AttachmentManifestRow` interface at `:27` and the mapping at `:158`) | one raw SQL `LEFT JOIN comments … WHERE a.task_id = ? OR c.task_id = ? ORDER BY a.created_at, a.id` on the plugin database | chronological across task and comment attachments |
| `api/index.ts:345` "attachmentsForTasks", used by `deleteProject` (`:714`) and `deleteTask` (`:854`) | per task: `listAttachmentsForTask`, `listComments`, then one `listAttachmentsForComment` per comment | not relevant: the list only feeds `removeAttachmentBlobs` |

The store already owns the parts: `plugins/tasks/db/store.ts:1755` "listAttachmentsForTask", `:1766` "listAttachmentsForComment" and `:1777` "listAttachmentsForTaskComments". The last is used only by the `listAttachments` RPC branch `commentsOfTaskId` (`api/index.ts:1024`) and by `plugins/tasks/db.test.ts:756`.

Facts that make the merge safe:

- `plugins/tasks/db/schema.ts:82` has `CHECK ((task_id IS NOT NULL AND comment_id IS NULL) OR (task_id IS NULL AND comment_id IS NOT NULL))`, and `store.ts:1711` "createAttachment" enforces the same rule. An attachment can never appear in both sets, so the `Map` de-duplication in "collectAttachments" does nothing (Proven by inspection).
- `schema.ts:37` sets `parent_task_id … ON DELETE SET NULL`, so deleting a task leaves its sub-tasks alive. The delete paths therefore do not need sub-task attachments (Proven by inspection).
- `store.ts:1160` "listTasks" has no default status or archive filter, so `deleteProject` already sees every task in the project (Proven by inspection).
- `TasksStore` is `ReturnType<typeof createTasksStore>` (`store.ts:2126`), so a new store function needs only its definition and its entry in the returned object near `store.ts:2106`.

Consumer search (repository-wide at the snapshot, excluding Markdown): `git grep -n -E 'listAttachmentsForComment|listAttachmentsForTask|attachmentManifest|attachmentsForTasks|collectAttachments|listAttachmentsForTaskComments|FROM attachments' e9e1b74c3b -- . ':!*.md'`. Every hit is inside `plugins/tasks`. A search for `Fetch with|## Sub-tasks|attachment get ` found no third agent-context renderer. `plugins/tasks/cli/index.ts:1735` renders a "Sub-tasks" table for humans, which is a different output and out of scope. All the functions involved are module-private, so no plugin-SDK export or external plugin depends on them.

Tests that encode the current text (Proven by inspection; not run, because the snapshot has no `node_modules`):

- `plugins/tasks/delegate/delegate.test.ts:619` pins the whole seed prompt with `toMatchInlineSnapshot`, including `- TASK-2 · Add focused tests (in_progress)`, `- delegation-notes.md · 01J…06` and `### Sawyer · user · …`. It calls "buildSeedPrompt" with a hand-built attachment list, so it does not exercise "collectAttachments".
- `plugins/tasks/mentions/mentions.test.ts:184-200` asserts `MEN-2 · Verify mention output — Done`, the regex `- 01… · acceptance\.md`, `Sawyer · User` and `thr_demo · Mention worker · Working`. Its fixture has only a task-level attachment.
- `plugins/tasks/api/api.test.ts:895` checks that `deleteTask` removes both task and comment attachment blobs. `api.test.ts:974` checks `deleteProject` with a task-level attachment only.
- No test covers comment attachments in the seed prompt or in the mention context.

The history gives no reason for the drift: both files arrive in one squashed commit (`060950255 Publish Omnyo source`).

**Proposed end state and preservation argument**

What remains:

- One store query, `listAttachmentsIncludingComments(taskId: string): Attachment[]`, in `plugins/tasks/db/store.ts` next to "listAttachmentsForTaskComments". It uses the mention SQL (`LEFT JOIN comments c ON c.id = a.comment_id WHERE a.task_id = ? OR c.task_id = ? ORDER BY a.created_at, a.id`) through `attachmentFromRow`, so it returns full `Attachment` objects.
- One module, `plugins/tasks/shared/task-context.ts`, that exports `formatTaskSubtasks`, `formatTaskAttachments` and `formatTaskComments`. `formatThreads`, the "Task details" block, both headings and both action contracts stay with their own builders.

What disappears: `collectAttachments` (delegate), `attachmentManifest` with `AttachmentManifestRow` and its mapping (mentions), the body of `attachmentsForTasks` (api), and one of the two formatter sets.

How each consumer changes:

- `deleteTask` and `deleteProject` call `taskIds.flatMap((taskId) => store.listAttachmentsIncludingComments(taskId))`. `deleteProject` goes from `2T + C` queries (T tasks, C comments) to `T` queries. The order does not matter there, and the set is identical because of the exactly-one-owner CHECK.
- "buildTaskContext" calls `store.tasks.listAttachmentsIncludingComments(task.id)`. Its SQL and order are unchanged, so mention output stays byte-identical. The `database` handle stays only for `searchTasks`.
- The `delegate` handler calls the same store function. **Behavior change:** attachment order becomes fully chronological instead of "task attachments first". The text differs only when a comment attachment is older than a task attachment. Decision D1 below covers this.

Decisions for Alex (the formatter half waits for these):

- **D1, delegate attachment order.** Accept chronological order for the seed prompt (recommended: it matches the mention context and the store order), or keep task-first order by calling `listAttachmentsForTask` and then `listAttachmentsForTaskComments`. The second option still drops "collectAttachments" and its N+1, and the comment part becomes ordered by attachment time instead of comment time.
- **D2, section wording.** Pick one:
  - (a) Raw values everywhere: `(in_progress)`, `fileName · id`, `user`. Raw status values match the CLI vocabulary agents type (`omnyo tasks update … --status in_review`).
  - (b) Display names everywhere: `— In Progress`, `id · fileName`, `User`. This matches the UI and the mention "Task details" block.
  - (c) Keep both texts byte-for-byte with a `style: "raw" | "display"` parameter on the shared formatters. This changes no prompt but saves fewer lines, and the parameter keeps two styles alive.

  Without a decision, ship checkpoint A only and leave the formatters as they are.

Preservation argument: the set of attachments for every caller is the same because the schema forbids an attachment owned by both a task and a comment. The mention SQL is moved, not rewritten. Blob cleanup still covers comment attachments, and `api.test.ts:895` keeps guarding it. Agent-facing text changes only where D1 or D2 chooses a change, and the inline snapshot and mention assertions are updated to the chosen text on purpose. Do not bless them blindly.

Non-goals: merging "buildSeedPrompt" and "buildTaskContext"; changing either action contract, the headings ("Recent comments" versus "Last 5 comments"), or the five-comment window; a single project-wide attachment query in `deleteProject` (possible, but rare and not worth a second query shape); changing the `listAttachments` RPC contract.

**Expected gain and cost**

In scope today: 123 handwritten production lines, counted with `git show e9e1b74c3b:<file> | sed -n '<a>,<b>p' | wc -l` over `delegate/index.ts` 69-100 (32) and 179-197 (19), `mentions/index.ts` 27-30 (4), 75-90 (16), 92-126 (35) and 158-163 (6), and `api/index.ts` 345-355 (11).

Projection, not measured:

| Change | Removed | Added | Net |
|---|---|---|---|
| A: one attachment query | about 56 (collectAttachments, attachmentManifest with its row type and mapping, most of attachmentsForTasks) | about 17 (store function and export, call sites) | about -35 to -40 |
| B with D2 (a) or (b) | about 67 (both formatter sets) | about 35 (shared module and imports) | about -30 |
| B with D2 (c) | about 67 | about 50 | about -15 |

Total: about -45 to -70 production lines with a unified wording, or about -50 with (c). Tests gain about 20 to 40 lines for the new coverage below. Before, there are 3 attachment-set definitions and 2 formatter sets. After, there is 1 query and 1 formatter set.

Maintenance effect: adding attachment size or MIME type to agent context, or excluding a class of comments, becomes one edit in `shared/task-context.ts` and one in `store.ts`, instead of up to five places. Performance: the delete paths issue fewer SQLite queries per task. This is unmeasured and only matters for large projects. Mention resolution and delegation run the same or fewer queries.

**Execution steps**

1. **Reconfirm.** In a fresh worktree from current `main`, check that the anchors above still exist (`git grep -n -E 'collectAttachments|attachmentManifest|attachmentsForTasks|function formatSubtasks' -- plugins/tasks`) and that `schema.ts` still has the exactly-one-owner CHECK on `attachments`. Re-plan if a migration has relaxed that CHECK (the de-duplication would then matter), if a third agent-context builder has appeared, or if either formatter has gained a field the other lacks.
2. **Add missing characterization coverage before the edits.**
   - In `plugins/tasks/mentions/mentions.test.ts`, extend the "resolves complete task context…" fixture with one comment attachment and assert that both attachment ids appear in chronological order.
   - In `plugins/tasks/delegate/delegate.test.ts`, add a handler-level test (reuse the existing fake-host setup that asserts `TASK-1 · Implement delegation` near `:85`) that creates one task attachment and one comment attachment and asserts that the spawned `prompt` lists both.
   - In `plugins/tasks/api/api.test.ts`, extend the `deleteProject` blob test at `:974` with a comment attachment and assert that its blob directory is removed.
   - Run these tests and confirm they pass on the old code.
3. **Checkpoint A (ready now): one attachment query.**
   - `plugins/tasks/db/store.ts`: add `listAttachmentsIncludingComments(taskId)` after `listAttachmentsForTaskComments` (about `:1789`), selecting `a.*` with the SQL from `mentions/index.ts:79-89`, mapped through `attachmentFromRow`. Add it to the returned object near `:2108`.
   - `plugins/tasks/mentions/index.ts`: delete `AttachmentManifestRow` (`:27-30`) and `attachmentManifest` (`:75-90`), and replace `:158-163` with `const attachments = store.tasks.listAttachmentsIncludingComments(task.id);`. Change `buildTaskContext`'s signature to drop `database` if nothing else in it uses it, and update the call in `resolve` (`:211`). Drop the now-unused `Attachment` type import only if nothing else uses it (the formatter still does).
   - `plugins/tasks/api/index.ts`: make `attachmentsForTasks` (`:345`) a one-line `flatMap` over `store.listAttachmentsIncludingComments`, or inline it at `:714` and `:854`.
   - `plugins/tasks/delegate/index.ts`: apply D1. With the recommended option, delete `collectAttachments` (`:179-197`) and pass `store.tasks.listAttachmentsIncludingComments(task.id)` at `:343`. With task-first order, pass `[...store.tasks.listAttachmentsForTask(task.id), ...store.tasks.listAttachmentsForTaskComments(task.id)]`. Without a D1 answer, leave the delegate call site unchanged for now and note it in the report.
   - Verify: run the targeted tests in the next section. The mention and api tests must pass unchanged, apart from the additions from step 2.
4. **Checkpoint B (after D2): one formatter set.**
   - Create `plugins/tasks/shared/task-context.ts` with `formatTaskSubtasks(subtasks: readonly Task[])`, `formatTaskAttachments(attachments: readonly Pick<Attachment, "id" | "fileName">[])` and `formatTaskComments(comments: readonly Comment[])`, written in the chosen D2 style. Each returns `"None."` for an empty list, as both copies do today. For D2 (c), add a `style: "raw" | "display"` argument that selects between the two current renderings byte-for-byte.
   - `plugins/tasks/delegate/index.ts`: delete `formatSubtasks`, `formatAttachments` and `formatComments` (`:69-100`) and import the shared ones in "buildSeedPrompt". Keep `markdownSection` local.
   - `plugins/tasks/mentions/index.ts`: delete the three formatters (`:92-126`), keep `formatThreads`, and import the shared ones.
   - Import types from `../db` as both files do today, and `displayName` from `./display-name`.
   - Update the inline snapshot at `delegate.test.ts:619` and the assertions at `mentions.test.ts:188-191` to the chosen wording only. For D2 (c), neither test text changes.
5. **Clean up.** Remove imports left unused (`Attachment` in `delegate/index.ts` if it is no longer referenced, `type Attachment` in mentions). Check `plugins/tasks/README.md:133-150` ("Task mentions") and `plugins/tasks/PLUGIN_OVERVIEW.md` for any description of the exact context wording, and update it if D2 changed that wording.
6. **Review.** Inspect the full diff for unrelated edits and confirm no second attachment-set definition or formatter copy remains (see the structural checks below). Recount the removed lines with the same `sed -n … | wc -l` method against the snapshot ranges.

**Verification and acceptance criteria**

Commands (scripts confirmed in `plugins/tasks/package.json` and the root `package.json` at the snapshot; not run, because the snapshot has no `node_modules`):

- In `plugins/tasks`: `pnpm exec vitest run --config vitest.config.ts delegate/delegate.test.ts mentions/mentions.test.ts api/api.test.ts db.test.ts attachments/attachments.test.ts`. All tests pass, including the step 2 additions.
- In `plugins/tasks`: `pnpm typecheck` (`tsc --noEmit`) and `pnpm lint` (`oxlint …`).
- At the repository root: `pnpm exec oxfmt <changed files>`, then `pnpm format:check` (`oxfmt . --check`).

Behavior checks:

- The mention context is byte-identical before and after checkpoint A for a task with task attachments, comment attachments and no attachments. Compare the `resolve` output in a test or a scratch script before you edit.
- The seed prompt lists every task and comment attachment exactly once. Its order follows D1.
- `deleteTask` and `deleteProject` remove the blob directories for both task and comment attachments (`api.test.ts:895`, plus the extended `:974`).
- After checkpoint B, the wording is the D2 choice in both outputs. The headings, the action contracts and the five-comment window are unchanged.

Structural completion:

- `git grep -n -E 'collectAttachments|attachmentManifest|AttachmentManifestRow' -- plugins/tasks` returns nothing.
- `git grep -n 'listAttachmentsForComment' -- plugins/tasks` shows only the store definition, the `listAttachments` RPC branch (`api/index.ts:1023`) and tests.
- After checkpoint B, `git grep -n -E 'function format(Subtasks|Attachments|Comments)' -- plugins/tasks` matches nothing outside `shared/task-context.ts`.

Performance: no benchmark is needed. The change only removes queries. If someone wants evidence, count `prepare` calls in a `deleteProject` test with 3 tasks and 5 comments before and after.

**Rollback and stop conditions**

Each checkpoint is one revertible commit inside `plugins/tasks`, with no schema, persisted-data or RPC contract change. Reverting restores the old text and queries.

Stop and re-plan if any of these appear:

- The `attachments` exactly-one-owner CHECK is gone or relaxed.
- A consumer outside `plugins/tasks`, or a published plugin-SDK surface, depends on the seed-prompt or mention text.
- Alex wants the two contexts to diverge on purpose, for example display names for mentions and raw values for workers. Then choose D2 (c), or ship checkpoint A alone.
- The step 2 characterization tests fail on the old code. That is a bug to report separately before any refactoring.

The smaller safe alternative is checkpoint A alone: it is ready, it changes no mention text, and it removes the N+1 on the delete paths.
