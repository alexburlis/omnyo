# Decisions

Steer autonomous agents without stopping their work.

Agents handle routine choices themselves. When your input would materially
change the outcome, a decision appears above the chat's composer and on the
Questions overview. The agent states a reversible default and keeps working.
You can answer later; your answer steers the current task and can change work
already completed.

```sh
omnyo plugin install .
```

## Answer, update or dismiss

Decisions have 2–8 choices, optional notes, or a free-text field. Recommendations
are marked. Omnyo’s shared form shows context, descriptions and an optional additive note.

Answer each question through Omnyo’s shared native form.
Half-typed drafts survive navigation and reloads. A failed send leaves the
question and draft open.

Agents can update pending questions in place as work progresses. Identity and
panel position stay the same. An update clears that question's older draft;
stale submissions are rejected. Other questions retain their drafts.

**Skip** silently dismisses a question. It sends no chat message and wakes no
agent. Skipping grants no approval. Agents can also withdraw questions when
input no longer matters.

Only an action that needs missing authority, essential information/access, or
an unsafe or irreversible guess must wait. Agents continue all other authorized
work. An open optional decision is not a reason to stop a thread.

## For agents

| Tool                 | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `decisions_open`     | Ask only necessary questions; continue with a stated default.        |
| `decisions_update`   | Update a pending question by id or key; only supplied fields change. |
| `decisions_list`     | Read open and recent answered, skipped and withdrawn decisions.      |
| `decisions_withdraw` | Remove questions whose answers no longer matter.                     |

The bundled skill explains autonomy, asynchronous steering and the few cases
where a specific action must wait. Answers arrive as `Question answered`.
Skip and dismissal send no messages.

Changed tools and instructions apply when a provider session is next constructed.
Sessions with an older tool list can use the CLI immediately.

## Surfaces

| Where                  | What                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Above the composer     | Open questions, answerable in place and collapsible.       |
| Sidebar row            | Native required-answer or optional-input status.           |
| **Questions** overview | All open questions, answerable without entering each chat. |
| `omnyo decisions`      | The same reads and writes from a shell.                    |

## Shell commands

```sh
omnyo decisions open [<chat-id>|.] --file <decisions.json> [--json]
omnyo decisions update <decision-id|key> --file <changes.json> [--chat <chat-id>|.] [--json]
omnyo decisions list [--json]
omnyo decisions show [<chat-id>|.] [--json]
omnyo decisions answer <decision-id> [--choice <option-id|label>]... [--text "..."] [--json]
omnyo decisions skip <decision-id> [--json]
omnyo decisions withdraw <decision-id|key>... [--chat <chat-id>|.] [--json]
```

Open files contain the `decisions_open` array or an object with a `decisions`
key. Update files contain question, context, options, `multiSelect` or `allowText`
fields; omitted fields stay unchanged. `context: null` clears context.
`.` means the current chat. JSON files are read on the invoking machine;
without chat context add `--machine <host-id>`.

## Native ownership

This plugin keeps the existing tools, RPCs and CLI as compatibility adapters. Omnyo owns the shared form, status, revisions, lifecycle and durable answer queue. Disabling this adapter leaves native questions available. Existing plugin records migrate once, retaining IDs, answers and notes; legacy writes are fenced.

## Development

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run format:check
omnyo plugin build .
omnyo plugin reload decisions
```

Adapter tests use the official Plugin SDK harness. Native SQLite/API tests in the omnyo core repository cover migration, silent dismissal, revisions and atomic answer delivery.
