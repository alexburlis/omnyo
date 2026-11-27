# Smart Queues

This folder owns the standalone Omnyo queue plugin. Use npm with its lockfile.
Use only the public `@omnyo/plugin-sdk` entrypoints. Do not change Omnyo core or
other plugins from this plugin.

The routing model chooses actions and ordered-prefix counts. It cannot rewrite
user instructions. Grouping preserves native queue order. A new chat receives
the exact original blocks and all source user prompts. A version-checked source
receipt replaces an original only after durable destination readback. Never
delete a source row during handoff. Keep the original in the SQLite ledger.

Use existing subscription routing, default service tier, and no API keys or
additional provider spending.

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
and `omnyo plugin build .`.
