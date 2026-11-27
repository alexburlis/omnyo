# Chat Topics

- Canonical Omnyo titles are authoritative. Write a title only through the core
  conditional-title API and the tool's actual execution-context thread ID.
- Keep first-turn eligibility in the synchronous dispatch hook and local SQLite
  ledger. Naming storage failures must not reject dispatch. Never add metadata
  HTTP calls or async mutation queues to that hook. Configure remains synchronous.
  Await title/tag effects and forward cancellation.
- Never add separate inference, hidden helper chats, provider overrides, queues,
  backfill, paid fallback or bulk title edits.
- Tags never change a chat's section. Missing, unknown or removed tags never
  hide chats. Keep the precedence
  user > first-turn > prediction in `lib/tags.ts`.
- Preserve host actions, Inbox activity, shortcuts, split drag and sub-chat state.
- Run the package checks on the Node major in `.nvmrc` (22). The SQLite test
  binding is built for it; under Node 24 it cannot load, naming switches itself
  off and about twenty server tests fail with misleading assertions.
  `pnpm test` runs `scripts/check-node.mjs` first and stops on any other major.
- A test that pauses an operation at a gate waits with `paused(entered, operation)`
  from `tests/gates.ts`, never a bare `await entered.promise`: an operation that
  finishes without reaching its gate must fail the test instead of hanging the
  run. `tests/gates.test.ts` holds that guarantee to a one-second limit.
- Use the existing package checks and SDK test host. Add no code comments except
  semantic tool directives.
