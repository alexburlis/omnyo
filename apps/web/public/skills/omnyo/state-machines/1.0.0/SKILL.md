---
name: state-machines
description: Design durable recurring workflows with finite actions, explicit transitions, correlated events, and safe recovery from uncertain outcomes.
license: MIT
---

# State machines

Use this skill to specify and test a workflow that can revisit states while each action remains finite. It is runtime-neutral and contains no plugin, service, or command implementation. A named State Machines integration requires its own publicly documented compatible runtime and authorization.

## Model the workflow before scheduling it

Define states, accepted events, transition guards, effects, and terminal or paused outcomes. Give each state an observable meaning. A state such as `working` is too vague if it hides both a running action and a result awaiting reconciliation.

For each action, record its input, success evidence, timeout, cancellation behavior, retry safety, and effect boundary. A loop can continue indefinitely only by starting successive bounded actions; no finite test proves perpetual operation.

Here is a fictional offline workflow for validating generated sample documents. Its transitions do not publish anything:

| State     | Event and guard                         | Next state | Effect                                         |
| --------- | --------------------------------------- | ---------- | ---------------------------------------------- |
| Idle      | Start with a valid fixture revision     | Checking   | Begin one bounded local check.                 |
| Checking  | Result matches the current invocation   | Waiting    | Record pass or failure evidence.               |
| Checking  | Deadline expires without a known result | Uncertain  | Preserve ownership and inspect the invocation. |
| Waiting   | Tick arrives while enabled              | Checking   | Begin the next bounded check.                  |
| Waiting   | Pause requested                         | Paused     | Admit no new action.                           |
| Checking  | Pause requested                         | Draining   | Keep ownership of the active action.           |
| Draining  | Active action is confirmed finished     | Paused     | Record its outcome.                            |
| Uncertain | Reconciliation establishes completion   | Paused     | Record evidence without replaying the action.  |

Specify omitted events explicitly: reject, ignore with a reason, or retain for a defined future state. Do not let an unspecified event choose an accidental default transition.

## Make identity and ownership explicit

Distinguish the definition revision, run ID, action invocation ID, state entry ID, and control revision. An event must identify the run and entry or subscription window it belongs to. Late results from an earlier entry must not advance a newer one.

Use compare-and-set semantics for state changes: accept a mutation only if its expected revision still matches. On a conflict, reload and reconsider instead of replacing the revision and silently retrying.

Assign a stable idempotency key to one intended effect. An identical retry may reuse that key; a new intended effect gets a new key. Verify what the downstream service actually guarantees. A local request key alone cannot make an arbitrary external operation exactly once.

## Distinguish pause, cancellation, and completion

Pause prevents new work. Draining waits for current work to finish. Cancellation requests that current work stop. None proves that a remote worker or external effect has stopped.

Keep an unknown outcome explicit. A timeout, disconnect, or lost response can leave an effect in progress or already completed. Before retrying, inspect the exact invocation and authoritative result. Preserve ownership until completion or quiescence is established. If neither can be established, surface the uncertainty and the required decision.

A transition guard is not permission to send messages, spend money, deploy, or delete data. Model authorization separately and require it at the effect boundary. Do not invent approval from a timer or a workflow label.

## Test the model offline

Walk event sequences using a table or a small pure transition function. Include duplicate events, stale revisions, a late result after cancellation, restart during an action, deadline expiry, and two control requests racing.

Assert meaningful invariants: at most one active owner for an invocation; no effect admitted while paused; only matching events advance the current entry; unknown outcomes block conflicting work; completed evidence survives restart. For durable execution, test those properties against the actual persistence layer and crash/restart path before claiming runtime recovery.

Return the state table, effect boundaries, invariants, tested sequences, and unresolved decisions. Integrate only through the selected runtime's documented schema and controls. An offline model is useful design evidence, not proof that a scheduler or plugin enforces it.
