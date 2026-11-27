Steer autonomous agents while they keep working.

## What you get

- **Optional decisions above the composer.** Agents make routine choices
  themselves. When your input matters, they state a reversible default and
  continue working. You can answer with choices, notes or your own words.
- **Late answers that steer ongoing work.** Answers reach the current task;
  agents can adjust work already completed.
- **Questions that stay current.** Agents update pending questions in place
  as work progresses. Old drafts cannot answer a changed question.
- **Silent dismissal.** Skip closes a question without a chat message or a
  new agent turn. Skipping supplies no answer or approval.
- **Drafts that survive navigation and reloads.** Failed delivery preserves
  your input. Updates reset only the changed question's draft.
- Native optional-input status for chats with open questions, a **Questions** overview and a
  `omnyo decisions` shell command.

## How it works

An agent opens questions only when your input materially helps and cannot
reasonably be resolved from the request, code, docs or sensible defaults.
Open questions do not pause a thread. Only a specific action that requires
missing authority, essential information/access or an unsafe irreversible
guess must wait; the agent continues other authorized work.

Omnyo atomically queues the answer and closes the question. Retries cannot queue it twice.
Skip and withdrawal only update local state. They send no messages.
Omnyo owns persisted questions; archived chats no longer show them.
No account, API key or external service is needed.
