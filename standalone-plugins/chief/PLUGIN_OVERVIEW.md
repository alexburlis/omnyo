See what your chats need from you across every project, in one place, and get suggested answers from your own coding agent when you want them.

## What you get

- **Needs you.** See open questions and blocked chats across all your projects in one place.
- **One page to decide from.** Scan open decisions, then open a card to answer, go to the chat, or save it for later. Check the choices before sending a policy decision. Restore a postponed card anytime from Saved. Rule proposals live in Rules, and drafts live in Suggested replies with a review step before sending.
- **Answer suggestions.** After you turn them on, Chief uses your coding agent account to suggest answers to chat questions across all projects. You can answer questions yourself and change the setting anytime.
- **Inbox assistant.** Open Ask Chief to ask what is waiting, or tell it how you like things done. A stated preference comes back as a proposal in Rules. Review the wording and scope, compare adopted rules, then choose how Chief may use it.
- **Rules that only answer what they may.** An adopted rule can answer a question for you only when the asking chat marked it as answerable for you, the suggestion is "Sure", and you chose that level. Every such answer is attributed in the chat, listed under Answered for you, and can be undone. After adoption a rule can only be narrowed or retired.

## How it works

Listing what needs you reads Omnyo's own attention data and costs nothing. Suggestions come from short-lived hidden chats in the Chief's workspace that see only the question, its chat and project, your rules and your earlier answers; they are deleted after use. The Chief's own chat is created idle and stays out of every chat list; you reach it through Inbox assistant → Ask Chief.

Turn the Chief off in Settings > Plugins. Turning suggestions off stops every suggestion and every answer waiting to be sent.

## Command line

`omnyo chief status|brief|suggestions on|off|pause|resume|rules|delegations|start|distill|eval|history`. `omnyo chief start` repairs the Chief's chat if it is missing or broken. Add `--json` for machine-readable output.

No account, API key or paid service is needed; suggestions use the agent you already have.
