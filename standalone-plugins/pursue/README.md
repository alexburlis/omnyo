# Goals

Goals and durable loops for Omnyo threads, on any provider.

Omnyo threads stop when the agent decides to stop. Goals adds two ways to keep
one going, and Omnyo's server-side Inbox owns both: a goal is the chat's own
producer, and a loop is a check wait on the chat.

```
omnyo pursue goal <objective>      # keep working until an independent judge says it is met
omnyo pursue loop <interval> <...> # wake the chat with a prompt until something changes
omnyo pursue status | list
```

## Why this exists

Claude Code has a native `/goal`, and an in-session scheduler behind `/loop`.
Neither is usable from Omnyo:

- `/goal` and its `ProposeGoal` tool are absent in a Omnyo thread. Typing `/goal`
  sends the literal text, and the agent treats it as a task. (Verified 17 Sep
  2026 — the message arrives as an ordinary turn with no goal event.)
- `CronCreate` works, but its jobs live inside the agent process: invisible to
  Omnyo, unlistable, and silently dropped when the thread restarts.

Codex has real goal mode server-side, but Omnyo never calls `thread/goal/set`, so
it cannot be started from Omnyo either.

Goals sits at the Omnyo layer instead of inside a provider session, so one
implementation covers Claude Code, Codex, Pi and ACP threads alike, and its
state lives in Omnyo where it survives restarts and shows up in `omnyo pursue list`.

## Goals

```
omnyo pursue goal the test suite passes and the linter is clean
omnyo pursue goal <objective> --max 5      # default 12 checks
omnyo pursue goal clear
```

After each turn the thread completes, Goals spawns a hidden judge thread in
the same environment. The judge sees the objective and the worker's closing
message, inspects the workspace read-only, and answers `MET` or
`UNMET: <what is missing>`.

The judge is a separate thread on purpose: a worker asked to grade itself can
end its own goal by asserting success. Unmet sends the worker a continuation
naming what is missing; met ends the goal. Hitting the iteration cap sends a
final message asking the worker to report where it got to, rather than stopping
silently.

Omnyo holds each iteration's result for the judge, for at most 15 minutes. UNMET
drops it, so the chat stays in **Running** while the goal works. MET, the
iteration limit, a clear or a judge failure surfaces one Inbox card, and a
verdict that never arrives surfaces the held result. The turn that set the goal
hands its request to the goal, so that request's answer is the goal's card.
Archiving the chat ends the goal, and pursue drops it.

Good objectives are checkable by someone other than the worker — tests green, a
file in a given state, an endpoint answering. An open-ended objective gives the
judge nothing to check and burns every iteration.

## Loops

```
omnyo pursue loop 10m check whether the deploy finished
omnyo pursue loop 1h <prompt> --max 24
omnyo pursue loop stop
```

Goals registers one check wait on the thread, keyed `pursue-loop`, and Omnyo
owns the timing. The minimum interval is 30s. After the interval Omnyo wakes the
chat with the prompt, in its own turn, once the chat is idle. Each wake is one
check, and `--max` counts checks.

- **Nothing changed:** the check runs `omnyo wait rearm <id>` and stays silent.
  Omnyo then waits twice as long before the next check, up to a day.
- **Something changed:** the check reports it. That ends the wait and puts the
  report on an Inbox card, and pursue opens the next wait at the original
  interval. Goals never re-arms a check by itself.

Between checks the chat shows **Waiting** with its return time. An agent's wait
ends at most 30 days after you last touched the chat, and then it comes back as
a Returned card. A deadline, a cancel or an archive closes the wait and ends the
loop. Undo of the archive reopens the wait.

A live loop also reports itself to Omnyo's shared work status, so the sidebar and
the Glance card name "This chat's loop" as the next owner, and Tidy does not
mark the chat ready to archive. A loop set before loops became Omnyo waits becomes
one at startup.

## Thread header control

When a thread has a goal, a pill with a target icon appears in its header:
`Goal`, a `3/12` checks-used chip and the objective. A loop instead shows in Glance's chat card at the top
of the chat: the pill gains a repeat icon with the time to the next check, and
the opened card has a Loop section with the prompt, Edit and Stop loop, which
call `pursue_state`, `pursue_edit_loop` and `pursue_clear_loop`. A goal that stopped short
shows as a muted `Goal stopped — <objective>`; a goal the judge says is met
disappears, because it is gone. Clicking it opens a dialog that explains the
judge, shows the checks used and the judge's last verdict, and offers an editable
objective with Save and Cancel goal.

Phones draw no header controls, so every thread actions menu (the `•••` in the
header, a sidebar row's menu) also has a Goal item: `Goal 3/12` with the objective
beneath it, opening the same dialog. The dialog is mounted once through an app
overlay, so the pill and the menu item share it.

Editing or cancelling from here touches plugin state only — the thread's turn
is never interrupted, so you can retarget a goal while the agent is mid-run.
Two details make that safe:

- **Edits bump a revision.** A judge already in flight for the old objective
  has its verdict discarded rather than applied to the new one.
- **An edit resumes a stalled goal.** Judgement is driven by `thread.idle`, so
  a goal whose thread is sitting idle would never be judged again. Editing one
  on an idle thread sends a continuation naming the new objective; editing one
  mid-run does not, because that turn ends in `idle` by itself.
- **A retarget resets the counter.** A new objective gets a fresh budget,
  so resuming a goal that stopped at its limit does not stop again on the next
  unmet verdict.

## Settings

```
omnyo plugin config pursue set maxIterations 20
omnyo plugin config pursue set judgeModel <model-id>     # blank = project default
```

## Design notes

- **Judge history is retained.** Judges remain hidden after their result is
  consumed. A coordinator restart resumes the same bound judge instead of
  creating another one or deleting its history.
- **A met goal deletes itself.** Nothing is sent when the judge says MET — a
  closing message would start the very turn the goal exists to stop — and the
  goal leaves plugin state, so the header pill, `omnyo pursue status` and
  `omnyo pursue list` all go quiet at once.
- **A verdict is read from the last few lines, not the literal last one.**
  Judges bold it, fence it, prefix it with "Verdict:" or sign off after it.
  MET is accepted only from a line that says nothing but MET, so a sentence
  like "Met the objective? No." cannot end a goal early.
- **An unreadable verdict stops the goal, it does not count as unmet.** Two
  judges in a row that answer in neither shape have told us nothing about the
  workspace; nudging the worker on that basis is how an achieved goal keeps
  running to its iteration limit. Goals retries once with a fresh judge, then
  stops with `judge returned no clear verdict twice`.
- **A stopped goal stays visible.** It shows in the header as a muted
  `Goal stopped` pill carrying the reason, with Dismiss and Resume, rather than
  vanishing the way a met one does.
- **An uncertain effect stops visibly.** Goals saves judge creation and
  continuation send intent before calling the SDK. If the coordinator stops
  before the result is recorded, or a send returns an ambiguous error, the goal
  stops with an uncertainty reason. The SDK has no send idempotency key, so
  recovery cannot promise exactly-once delivery and never blindly resends.
- **Clearing during judgement wins.** A judge takes a while, and the goal can be
  cleared while one is in flight. Goals re-reads the goal before writing a
  verdict, so a clear is never resurrected by an in-flight judge.
- **One evaluation per thread at a time.** `thread.idle` can fire again while a
  judge runs; startup recovery uses the same guard. The `reconcile` service
  makes one goal and loop recovery pass at startup, with no timer.
- **Goal updates preserve their neighbors.** Goal writes and clears share a
  serialized storage update. A verdict applies only if the expected goal still
  matches inside that update, so concurrent recovery or a clear cannot restore
  an obsolete snapshot.
- **Recovery checks ownership again.** A pending judge is bound to the owner,
  goal creation time, revision and iteration. Only a matching active goal on an
  idle owner can consume its result. An active owner waits for its next idle
  event; an edited or cleared goal cannot receive the stale decision.
- **Judge threads are tracked and skipped.** A judge goes idle like any thread;
  without that list, its own idle event would be judged recursively.
- **Goals and loops are dropped when their thread is deleted.**
- **A loop follows its Omnyo wait.** Goals stores only the loop's settings and
  its current wait. After each turn it reads that wait: a check closed as
  `resumed` opens the next one, and any other close ends the loop. Editing the
  prompt closes the current wait and opens one with the new prompt at the same
  time, because Omnyo refuses new content under a live wait's key.
- **Goals never reopens an archived chat.**

### Goals created before restart recovery

Older goals retained judge IDs without an owner and goal revision binding.
Startup does not guess that relationship from a judge title or create a
replacement judge. A protected, explicitly admitted recovery must verify the
exact owner/judge receipt, unchanged goal creation time, revision and iteration,
and the existing judge result before adding this field to the same goal:

```json
{
  "evaluation": {
    "ownerThreadId": "exact-owner-thread-id",
    "goalCreatedAt": "unchanged-goal-createdAt",
    "goalRevision": 0,
    "iteration": 0,
    "judgeAttempt": 1,
    "judgeThreadId": "exact-approved-existing-judge-id",
    "phase": "judging"
  }
}
```

The migration must compare the current goal inside the owning storage update
and preserve its objective, budget and all other goals. Admit it only while the
owner is idle and no evaluator or continuation is already running. Do not set or
edit the goal to recover it: those commands replace its identity or budget.
The next normal startup pass consumes the bound judge. No legacy migration or
continuation send is performed merely by deploying this source change.

## Development

```
npm install
node --test --test-concurrency=1 server.test.ts
npx tsc --noEmit
omnyo plugin build
omnyo plugin install . --yes
omnyo plugin reload pursue      # after each change
```

## Saved plan execution

With Inline UI enabled, saved plan cards ask Goals to evaluate linked content and existing ownership. **Execute** and the host model picker appear only for implementation-ready plans with nonempty work, acceptance checks, and concrete steps or unchecked progress. Checked-off progress with no remaining work, drafts, legacy plans awaiting migration, ordinary documents, reports, and completed plans cannot start a new run. A complete state with unchecked progress is a visible conflict, not completion. **Completed**, **No remaining steps**, **In progress**, **Running**, **Blocked**, and **Stopped** distinguish document state from live execution. Existing runs retain **Open run**; uncertain starts retain **Check run**. A missing run record never establishes that manual work stopped. An executing document without linked ownership stays **In progress** and cannot start another run. While a run is running, waiting, blocked or starting, a bar directly above the source chat's composer shows its status and title; one click opens the executing chat. Idle, archived and deleted runs leave the bar.

Execute returns as soon as the run's chat exists. Goals finishes its goal setup in the background, and the run's first idle check completes any setup that did not finish.

Settings → Goals → Plan execution defaults chooses either the source chat’s model with supported Ultra reasoning at standard speed, or a fixed provider/model/reasoning/tier selection. The card can override the selection for one run. Missing catalogs and unsupported selections fail visibly.

Use `omnyo pursue plan inspect <path> --json`, `omnyo pursue plan execute <path> [--selection JSON] --json`, and `omnyo pursue plan defaults [JSON] --json` for the same operations. Typed RPC contracts are in `plan-contract.ts`; `sdk.plugins.callRpc` exposes them to other plugins. See `skills/pursue/SKILL.md` for configuration examples and operating limits.

One plan file on one host has one recorded execution across source chats, workspace aliases and content edits. Different files and checkouts remain independent. Windows drive and UNC aliases normalize separators and case; POSIX path case is preserved. Existing records made with source-chat keys are reconciled without replacing their owner; conflicting historical owners block a new launch. Progress edits retain that run; the selected hash protects the first start. New executions are refused when the saved plan is complete, including through CLI or RPC and after a stale preview; existing runs are still reconciled. Retries reconcile existing metadata instead of replaying an ambiguous spawn. Execution preserves the source permissions and all plan approval/spending gates. Completing a planning document alone does not satisfy an implementation run.
