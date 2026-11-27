Messages arriving during a busy chat can change the current work, start another
task, or belong together in the next turn. Smart Queues batches those messages
and asks a small model to choose the route.

## Four routes

- **Steer:** deliver an ordered correction to the active chat.
- **New chat:** automatically create a visible chat with exact messages,
  attachments and historical user instructions.
- **Queue:** wait for current work to finish.
- **Combine:** group related messages through Omnyo's native queue.

The model chooses a route and prefix count. It does not rewrite instructions.
Each source has one classifier in flight. Changed queues invalidate old
decisions, and short bursts become one batch.

## Keep instructions intact

The destination's input is persisted and checked before source messages become
routing receipts. Originals remain in the plugin's SQLite ledger. Incomplete
handoffs stay held and expose recovery errors. New chats wait for existing work
in the same checkout to finish.

Omnyo's public SDK cannot make the entire transfer atomic. Crashes can leave
duplicates, so Smart Queues does not promise exactly-once delivery. Manual
**Send now** remains Omnyo's explicit override.

## Your existing subscription

The default classifier is Claude Haiku 5.5 through Claude Code. Configure an
existing approved subscription in the plugin settings. No API key or new account
is required. Subscription limits still apply.

Open **Smart Queues** in the sidebar to inspect routes, open destinations, or
restore incomplete handoffs. The same operations are available through
`omnyo smart-queues`.
