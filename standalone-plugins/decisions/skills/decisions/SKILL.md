---
name: decisions
description: "Keep agents autonomous. Ask for user input only when it materially changes the outcome and cannot reasonably be resolved from the request, code, docs or a sensible default. Decisions are asynchronous steering: continue with a reversible default, update pending questions as work progresses, and accept later answers as corrections. Stop only an action that truly needs missing authority or essential information/access."
---

# Decisions

Be autonomous first. Most choices are yours to make from the request, code,
docs and sensible defaults. Several possible approaches do not by themselves
justify asking the user.

When user input materially helps and you cannot reasonably settle the choice,
use `decisions_open`. The question appears above the chat's composer and on the
Questions overview. Opening a decision does not pause or block the agent.

## Continue while questions are open

State your recommendation and the reversible default you are proceeding with
in `context`. Then continue the task, including work affected by that default.
Do not stop, end a turn or wait just because an optional decision is open.
Keep the question available while a later answer would still help.

Very few decisions require waiting. Hold only the specific action that needs
missing authority, essential unavailable information/access, or a guess that
would be unsafe or irreversible. Existing authorization remains valid. A
missing preference is usually no reason to stop. Continue all other authorized
work, and name the exact action that needs the answer.

## When to ask

Ask only when the answer materially changes the outcome and cannot reasonably
be resolved yourself, for example a consequential preference only the user
knows or authority for an effect outside the current request. Routine
implementation choices, conventional defaults and facts you can inspect do
not need decisions.

Batch the questions you actually need into one `decisions_open` call. Give
one question per decision, a short `key`, the tradeoff and current default in
`context`, and a recommendation. Supply 2–8 options, or omit `options` for a
free-text answer. Use `multiSelect` only when several choices can apply.
`allowText` defaults to true so the user can qualify a choice.

Do not repeat a pinned question in prose or make the user confirm an already
authorized action.

## Update, answer and dismiss

- Use `decisions_update` when a pending question, its context, options or input
  settings change. Identify it by id or key. Only supplied fields change;
  `context: null` clears context. Identity and panel position stay the same.
- Updates invalidate the affected question's old draft. A submission for an
  older revision fails visibly rather than answering a changed question.
- Answers arrive as `Question answered`. Treat them as steering of the current
  task. Continue from existing progress, adjust completed work when needed and
  update the relevant plan or document. A late answer is not a new task or a
  reason to restart unrelated work.
- Skip/dismiss closes the question silently. It sends no message, wakes no
  agent and supplies no answer or approval. Do not reopen it unless the user
  asks. An action that still requires authority stays undone.
- Use `decisions_withdraw` when user input no longer matters or the choice has
  been settled. Do not withdraw useful steering just because you selected a
  provisional default.
- `decisions_list` reads open and recent answered, skipped and withdrawn
  decisions. Check it when you need current state; dismissal is silent.

## From a shell

```sh
omnyo decisions open [<chat-id>|.] --file decisions.json
omnyo decisions update <decision-id|key> --file changes.json [--chat <chat-id>|.]
omnyo decisions list
omnyo decisions show [<chat-id>|.]
omnyo decisions answer <decision-id> [--choice <option-id|label>]... [--text "..."]
omnyo decisions skip <decision-id>
omnyo decisions withdraw <decision-id|key>... [--chat <chat-id>|.]
```

`.` means the current chat. Update files contain the fields to change, such as
`{"context":"I am proceeding with the existing layout; you can steer this later."}`.
Files are read on the invoking machine. Without chat context, pass
`--machine <host-id>` for file commands. Add `--json` for structured output.
A session with an older tool list can use the CLI; refreshed tools and standing
instructions apply when its provider session is next constructed.
