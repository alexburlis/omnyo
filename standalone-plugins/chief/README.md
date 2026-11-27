# Chief

Needs you lists questions and blocked chats across all your projects. Inbox assistant holds Ask Chief, rules, and answers Chief sent for you. Suggested answers run on the owner's own agent only after they say yes, and rules the owner adopts can answer questions a chat marked as answerable for them, with attribution and Undo.

Open a card to review options or save it for later. Rules shows proposals beside applicable adopted rules. Saved lists postponed cards and lets you restore any card before its return time. Suggested replies are available in their own view, where you can review the draft before sending it to the chat. Answers and replies have a five-second Undo window. Closing or reloading the page during that window cancels the pending send.

Needs Omnyo with plugin SDK 0.6.54 or later (the sidebar entry slot, idle chats and plugin home chats).

## Install

```sh
pnpm install --frozen-lockfile
omnyo plugin build .
omnyo plugin install .
```

On start the plugin creates the Chief's chat in the Personal project as an idle chat (no first message, no agent turn) and marks it as its home chat, so no chat list shows it; Ask Chief embeds it. `omnyo chief start` recreates it if it is missing or broken. The daily rule check runs on the plugin's own schedule, only while suggested answers are on, at most once every 20 hours.

## Upgrading from 0.1

Upgrade a path install with `git pull`, then `pnpm install --frozen-lockfile`, `omnyo plugin build .` and `omnyo plugin reload chief`, after the coordinator runs plugin SDK 0.6.54 or later. On first start, 0.2 adopts the stored Chief chat as the Talk chat and marks it as the plugin's home chat. It keeps the pin, the history, the rules and open rule questions. It writes the v1 agent and model choices into settings, because the defaults now follow the Personal project's agent, and turns suggested answers on, because v1 already ran them. The old in-chat daily `omnyo pursue loop` keeps working: `omnyo chief distill` and the new schedule share the 20-hour limit, so the check runs once a day (`omnyo chief distill --force` runs it now). Stop the loop by asking the Chief in Talk to run `omnyo pursue loop stop` whenever convenient. Disabling or removing the plugin clears the home mark, so the chat reappears in the sidebar.

## Measure before trusting it

```sh
node scripts/baseline.mjs --db ~/.omnyo/app.db --split 2026-11-10 --until 2026-11-20T00:00:00 --export answers.json
omnyo chief history --dataset answers.json
omnyo chief eval start --dataset answers.json --split 2026-11-10
omnyo chief eval status EVAL_ID --json
```

The baseline script opens the database read-only and reports how often you chose the asking agent's recommended option. The export holds question text; keep it private and delete it after use. The evaluation replays held-out answers through the same judge the Chief page uses and compares the asking agent (B0), the Chief without rules (B1) and the Chief with rules distilled from earlier answers (B2).

## Safety model

- Only questions the asking chat marked `delegable` can be answered by the Chief. Omnyo refuses plugin answers to any other question.
- Suggested answers start only after the owner answers the one-time offer with Yes (stored per install; default undecided). While they are not on, no judge chat is spawned from any path, rule offers carry only "Yes. Chats follow it, and the Chief only suggests" and "No", and answers waiting to be sent are cancelled.
- Adopting a rule, letting it answer required questions and resuming answering for you happen only through native questions in the Chief's chat that you answer. Omnyo records who answered; the plugin applies only your answers, at the revision it opened. Answering at once additionally needs at least 95% replay precision over at least 10 of your earlier answers.
- Every adopted rule, at any level, joins the instructions of chats in its scope, which then follow it instead of asking you.
- After adoption a rule's authority only goes down: `omnyo chief rules lower RULE_ID ask|veto|optional`, `omnyo chief rules retire RULE_ID`, or the Rules tab. A rule you overrode twice, or one that has not matched for 30 days, comes back as a "Keep this rule?" question.
- Judges run hidden, in `accept-edits`, may call only their own tool, and fail if they ask for any permission.
- `omnyo chief pause` stops every answer for you at once.

To inspect saved cards from a script, read `savedCards` from `omnyo chief brief --json`. To restore a card, pass a JSON object containing its `card.key` as `cardKey` and its exact `until` timestamp to `omnyo plugin rpc call chief unsnooze --input-file INPUT.json`.

## Development

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Pure logic lives in `lib/` (inputs, metrics, cards, rules, delegation guards, replay) with node tests in `tests/`. `lib/service.ts` wires them to the Omnyo SDK; `server.ts` registers settings, tools, RPC, CLI and the background service; `app.tsx` and `components/` render the sidebar row's state, the Chief page, the in-chat card and the settings section.
