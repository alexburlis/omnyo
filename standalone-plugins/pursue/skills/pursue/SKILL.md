---
name: pursue
description: "Pursue an objective until an independent judge says it is met, or have Omnyo wake the chat with a prompt until something changes. Use when work has a checkable completion condition, or when something must be re-checked on a schedule that survives a thread restart."
---

# Goals

`omnyo pursue` acts on the thread you run it in, and works on every provider.

## Goals

```
omnyo pursue goal <objective>           # pursue it until met
omnyo pursue goal <objective> --max 5   # cap the number of checks (default 12)
omnyo pursue goal clear
```

After every turn this thread completes, a separate hidden judge thread reads
the objective and your closing message, inspects the workspace read-only, and
answers `MET` or `UNMET: <what is missing>`. Unmet sends you a continuation and
you keep working; met clears the goal — you get no message, the pill
disappears, and nothing nudges the thread again.

Omnyo holds each turn's result for the verdict, so the owner sees one Inbox card
when the goal is met, hits its limit, is cleared or the judge fails, not one
per turn. The owner's request that set the goal is answered by that card.
Archiving the chat ends the goal.

The judge is deliberately not you. Do not treat the continuation as a
suggestion to argue with — either the objective is met and the judge will say
so, or it names something real that is missing.

Set a goal when the finish line is checkable by someone other than you: tests
green, a file in a given state, an endpoint answering. Do not set one for open
-ended work ("improve the docs") — the judge has nothing to check and you will
burn every iteration.

Stop and say so if you are blocked on something only the user can resolve.
The loop cannot unblock a missing credential or an unmade decision, and
iterating against one wastes the budget.

## Loops

```
omnyo pursue loop 10m check whether the deploy finished    # first check in 10m; 30s minimum
omnyo pursue loop 1h ... --max 24                          # stop after 24 checks
omnyo pursue loop stop
```

A loop is a Omnyo check wait on this thread. Omnyo wakes you with the prompt; the
message starts with the wait's marker and its id.

- **Nothing changed:** run `omnyo wait rearm <id>` and stop. The turn stays
  silent, and Omnyo checks again after twice the interval, up to a day.
- **Something changed:** report it and do not rearm. The report becomes the
  owner's Inbox card, and pursue opens the next check at the original interval.

It survives a thread restart and shows up in `omnyo pursue list`. Prefer it over
an in-session scheduler for anything that matters — an in-session job is
invisible to Omnyo and dies silently when the thread restarts. A deadline, a
cancel or archiving the chat ends the loop. Run `omnyo pursue loop stop` as soon
as the loop's work is done.

Use a loop for external state Omnyo cannot notify you about (a CI run, a deploy, a
remote queue). Do not use one to poll work the harness already reports back.

## Seeing what is running

```
omnyo pursue status          # this thread
omnyo pursue list [--json]   # every active goal and loop
```

## Execute saved plans

With Inline UI enabled, saved plan cards ask Goals to evaluate linked content and existing ownership. **Execute** and the host model picker appear only for implementation-ready plans with nonempty work, acceptance checks, and concrete steps or unchecked progress. Checked-off progress with no remaining work, drafts, legacy plans awaiting migration, ordinary documents, reports, and completed plans cannot start a new run. A complete state with unchecked progress is a visible conflict, not completion. **Completed**, **No remaining steps**, **In progress**, **Running**, **Blocked**, and **Stopped** distinguish document state from live execution. Existing runs retain **Open run**; uncertain starts retain **Check run**. A missing run record never establishes that manual work stopped. An executing document without linked ownership stays **In progress** and cannot start another run. While a run is running, waiting, blocked or starting, a bar directly above the source chat's composer shows its status and title; one click opens the executing chat. Idle, archived and deleted runs leave the bar.

The default uses the source conversation’s provider and model, with Ultra when supported or its highest supported ordinary reasoning level. It uses standard speed. Set a fixed provider, model, reasoning level and optional service tier under Settings → Goals → Plan execution defaults. Settings changes apply to subsequent card loads; the card’s picker can override one run.

```sh
omnyo pursue plan inspect docs/plans/repair.md --json
omnyo pursue plan execute docs/plans/repair.md --json
omnyo pursue plan execute docs/plans/repair.md --selection '{"providerId":"codex","model":"verified-model-id","reasoningLevel":"ultra","serviceTier":"default"}' --json
omnyo pursue plan defaults --json
omnyo pursue plan defaults '{"kind":"current-chat-ultra"}' --json
omnyo pursue plan defaults '{"kind":"fixed","selection":{"providerId":"codex","model":"verified-model-id","reasoningLevel":"high"}}' --json
```

Resolve actual model IDs through `omnyo provider models` before supplying an explicit selection. Preview and execute are also available through typed `pursue_plan_preview` and `pursue_plan_execute` RPCs; `pursue_plan_defaults` and `pursue_plan_save_defaults` share the settings contract.

Only linked UTF-8 Markdown plans up to 256 KiB qualify. Content identifies Schema 2 plans or legacy ExecPlan sections; a filename alone, template, fenced example or ordinary Markdown document does not qualify. Legacy plans require migration before execution. Metadata state alone cannot make a document actionable. Progress checkboxes, executable sections and acceptance checks govern remaining work; prose keywords do not. Relative paths use the source workspace and machine. Execute rereads the file and checks its selected hash and workspace. Changed files require refreshing the card. Execute returns as soon as the run's chat exists; the run's goal is set up in the background and completed by its first idle check if needed.

Repeated clicks across chats and later progress edits share the existing run for that file on the same host. Different files and checkouts remain independent. Windows drive and UNC aliases normalize separators and case; POSIX path case is preserved. Existing source-chat records are reconciled by exact file identity; conflicting owners block new launches. Stopped or blocked runs remain accessible and are never silently replaced. The hash checks the first selected revision; progress edits do not create a new execution. **Open run** returns to it. **Check run** reconciles an uncertain start through exact plugin metadata; it never blindly starts a duplicate. An unavailable provider or model remains an error, without substituting another provider.

The Execute action starts implementation. It does not approve new spend, accounts, purchases or publication. The run follows current instructions and explicit authority. If only the user can unblock it, clear the execution goal and report the exact gate before stopping.
